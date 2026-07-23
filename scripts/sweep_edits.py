#!/usr/bin/env python3
"""Sweep Wikipedia recent changes for edits made with the Source Verifier userscript.

Edits made via the tool carry a prefilled edit summary containing the substring
"Source Verifier". The MediaWiki API cannot filter by summary content, so this
script fetches recent changes in bulk and filters client-side, appending matches
to an append-only NDJSON log.

Configuration (environment variables):

    SV_WIKIS           Comma-separated wiki hosts to sweep   (default: en.wikipedia.org)
    SV_MATCH           Substring to match in the summary      (default: Source Verifier)
    SV_LOOKBACK_HOURS  How far back to sweep, in hours        (default: 48)
    SV_LOG_PATH        Output NDJSON file                     (default: data/edit-log.ndjson)

Run: python scripts/sweep_edits.py
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

# --- Config ---
DEFAULT_WIKIS = "en.wikipedia.org"
DEFAULT_MATCH = "Source Verifier"
DEFAULT_LOOKBACK_HOURS = 48
DEFAULT_LOG_PATH = "data/edit-log.ndjson"

RCLIMIT = 500  # ceiling for non-bot clients; do not raise
REQUEST_SLEEP = 0.1  # ~100ms between paginated requests
MAX_RETRIES = 4  # at least 3 attempts on 429/5xx
REQUEST_TIMEOUT = 30

USER_AGENT = (
    "citation-checker-script edit-log-sweep/1.0 "
    "(https://github.com/alex-o-748/citation-checker-script; alaexis@gmail.com)"
)


def iso_utc(dt: datetime) -> str:
    """Format a datetime as a Wikipedia-style ISO 8601 UTC timestamp."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_config():
    wikis = [
        w.strip()
        for w in os.environ.get("SV_WIKIS", DEFAULT_WIKIS).split(",")
        if w.strip()
    ]
    match = os.environ.get("SV_MATCH", DEFAULT_MATCH)
    try:
        lookback = int(os.environ.get("SV_LOOKBACK_HOURS", DEFAULT_LOOKBACK_HOURS))
    except ValueError:
        lookback = DEFAULT_LOOKBACK_HOURS
    log_path = os.environ.get("SV_LOG_PATH", DEFAULT_LOG_PATH)
    return wikis, match, lookback, log_path


def load_existing(log_path: str):
    """Return (records, keys) from an existing log, or empty containers.

    records is a list of previously-logged dicts; keys is a set of
    (wiki, revid) tuples already present, used for deduplication.
    """
    records = []
    keys = set()
    try:
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                records.append(rec)
                keys.add((rec["wiki"], rec["revid"]))
    except FileNotFoundError:
        pass
    return records, keys


def fetch_with_retry(session, url, params):
    """GET with exponential backoff on HTTP 429 and 5xx."""
    delay = 2
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(url, params=params, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            last_exc = exc
            resp = None
        if resp is not None:
            if resp.status_code == 429 or resp.status_code >= 500:
                last_exc = RuntimeError(f"HTTP {resp.status_code}")
            else:
                resp.raise_for_status()
                return resp
        if attempt < MAX_RETRIES - 1:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"request failed after {MAX_RETRIES} attempts: {last_exc}")


def sweep_wiki(session, wiki, match_lower, rcstart, rcend, existing_keys, first_seen):
    """Sweep one wiki and return (new_records, total_matches).

    total_matches counts every change whose summary matched, including ones
    already present in the log; new_records holds only the ones not yet logged.
    """
    url = f"https://{wiki}/w/api.php"
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "list": "recentchanges",
        "rctype": "edit|new",
        "rclimit": RCLIMIT,
        "rcprop": "title|ids|timestamp|user|comment|sizes|flags",
        "rcstart": iso_utc(rcstart),  # newer bound — results come newest-first
        "rcend": iso_utc(rcend),      # older bound
    }

    new_records = []
    total_matches = 0
    while True:
        resp = fetch_with_retry(session, url, params)
        data = resp.json()

        for rc in data.get("query", {}).get("recentchanges", []):
            comment = rc.get("comment", "") or ""
            if match_lower not in comment.lower():
                continue
            total_matches += 1
            revid = rc.get("revid")
            if revid is None or (wiki, revid) in existing_keys:
                continue

            oldlen = rc.get("oldlen")
            newlen = rc.get("newlen")
            size_delta = None
            if isinstance(oldlen, int) and isinstance(newlen, int):
                size_delta = newlen - oldlen

            record = {
                "wiki": wiki,
                "revid": revid,
                "old_revid": rc.get("old_revid"),
                "pageid": rc.get("pageid"),
                "title": rc.get("title"),
                "user": rc.get("user"),
                "timestamp": rc.get("timestamp"),
                "comment": comment,
                "size_delta": size_delta,
                "is_new_page": rc.get("type") == "new" or "new" in rc,
                "is_minor": "minor" in rc,
                "first_seen": first_seen,
            }
            existing_keys.add((wiki, revid))
            new_records.append(record)

        cont = data.get("continue", {}).get("rccontinue")
        if not cont:
            break
        params["rccontinue"] = cont
        time.sleep(REQUEST_SLEEP)

    return new_records, total_matches


def write_log(log_path, records):
    """Write all records to the log, sorted by edit timestamp."""
    records.sort(key=lambda r: (r.get("timestamp") or "", r.get("wiki") or "", r.get("revid") or 0))
    directory = os.path.dirname(log_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")


def main():
    wikis, match, lookback_hours, log_path = get_config()
    match_lower = match.lower()

    now = datetime.now(timezone.utc)
    rcstart = now
    rcend = now - timedelta(hours=lookback_hours)
    first_seen = iso_utc(now)

    existing_records, existing_keys = load_existing(log_path)

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    all_new = []
    total_matches = 0
    failures = []
    for wiki in wikis:
        try:
            new_records, matches = sweep_wiki(
                session, wiki, match_lower, rcstart, rcend, existing_keys, first_seen
            )
            all_new.extend(new_records)
            total_matches += matches
        except Exception as exc:  # noqa: BLE001 - continue with other wikis
            print(f"ERROR sweeping {wiki}: {exc}", file=sys.stderr)
            failures.append((wiki, exc))

    # Write whatever we collected even if some wikis failed — partial success
    # must not lose the data it did collect.
    if all_new:
        write_log(log_path, existing_records + all_new)

    window = f"{iso_utc(rcend)} .. {iso_utc(rcstart)}"
    print(
        f"Swept {len(wikis)} wiki(s) [{', '.join(wikis)}] over window {window}; "
        f"{total_matches} match(es) found, {len(all_new)} new record(s) appended "
        f"to {log_path}"
        + (f"; {len(failures)} wiki(s) failed" if failures else "")
    )

    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
