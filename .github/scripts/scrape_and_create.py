import os
import re
import json
import requests
from datetime import datetime, timezone
from anthropic import Anthropic
from github import Github, Auth

# --- Config ---
TALK_PAGE = "User_talk:Alaexis/AI_Source_Verification"
TALK_PAGE_URL = "https://en.wikipedia.org/wiki/User_talk:Alaexis/AI_Source_Verification"
LAST_SCRAPED_FILE = ".github/last_scraped.txt"
ANTHROPIC_MODEL = "claude-sonnet-4-6"
WIKI_HEADERS = {
    "User-Agent": "citation-checker-script/1.0 (https://github.com/alex-o-748/citation-checker-script)"
}

# --- Init ---
client = Anthropic()
gh = Github(auth=Auth.Token(os.environ["GITHUB_TOKEN"]))
repo = gh.get_repo(os.environ["GITHUB_REPO"])

# --- Timestamp helpers ---
WIKI_TIMESTAMP_RE = re.compile(
    r'\b(\d{1,2}:\d{2}),\s+(\d{1,2}\s+\w+\s+\d{4})\s+\(UTC\)'
)

def parse_wiki_timestamp(time_part: str, date_part: str) -> datetime | None:
    try:
        combined = f"{time_part}, {date_part}"
        return datetime.strptime(combined, "%H:%M, %d %B %Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None

# --- Load/save last scraped timestamp ---
def load_last_scraped() -> str:
    try:
        with open(LAST_SCRAPED_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "2024-01-01T00:00:00Z"

def save_last_scraped(ts: str):
    with open(LAST_SCRAPED_FILE, "w") as f:
        f.write(ts)

# --- Fetch latest wikitext ---
def fetch_latest_wikitext() -> str:
    params = {
        "action": "query",
        "titles": TALK_PAGE,
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "rvlimit": 1,
        "formatversion": "2",
        "format": "json",
    }
    r = requests.get("https://en.wikipedia.org/w/api.php", params=params, headers=WIKI_HEADERS)
    r.raise_for_status()
    data = r.json()
    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return ""
    revisions = pages[0].get("revisions", [])
    if not revisions:
        return ""
    return revisions[0].get("slots", {}).get("main", {}).get("content", "")

# --- Parse wikitext into sections ---
def split_into_sections(wikitext: str) -> list[dict]:
    sections = []
    current_title = "(preamble)"
    current_lines = []

    for line in wikitext.splitlines():
        if line.startswith("== ") and line.endswith(" =="):
            if current_lines:
                sections.append({
                    "title": current_title,
                    "content": "\n".join(current_lines).strip()
                })
            current_title = line.strip("= ").strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        sections.append({
            "title": current_title,
            "content": "\n".join(current_lines).strip()
        })

    return sections

# --- Filter sections newer than last scrape ---
def section_is_new(section: dict, since: datetime) -> bool:
    matches = WIKI_TIMESTAMP_RE.findall(section["content"])
    for time_part, date_part in matches:
        ts = parse_wiki_timestamp(time_part, date_part)
        if ts and ts > since:
            return True
    return False

def fetch_new_sections(since_str: str) -> list[dict]:
    since = datetime.fromisoformat(since_str.replace("Z", "+00:00"))
    wikitext = fetch_latest_wikitext()
    if not wikitext:
        print("Could not fetch wikitext.")
        return []
    sections = split_into_sections(wikitext)
    new_sections = [s for s in sections if section_is_new(s, since)]
    print(f"  {len(sections)} total sections, {len(new_sections)} have activity since {since_str}")
    return new_sections

# --- Get existing issue titles for dedup ---
def get_existing_issue_titles() -> list[str]:
    issues = repo.get_issues(state="open")
    return [issue.title for issue in issues]

# --- LLM extraction ---
EXTRACTION_PROMPT = """You are helping maintain a GitHub issue tracker for a Wikipedia userscript called "AI Source Verification" (also known as the citation checker script).

The tool helps Wikipedia editors verify whether cited sources actually support the claims they're attached to. It uses AI (Claude, GPT-4, Gemini) to check citations and returns confidence scores with verdicts.

Below is content from one section of the Wikipedia Talk page for this userscript. It may contain feature requests, bug reports, questions, or general discussion from Wikipedia editors who use the tool.

Your job:
1. Extract all ACTIONABLE items (feature requests and bug reports only)
2. Ignore: thank-yous, general questions with no clear ask, already-resolved discussions, noise, meta-discussion about Wikipedia
3. For each actionable item return structured JSON

Existing open GitHub issues (avoid creating duplicates):
{existing_issues}

Talk page section title: {section_title}
Talk page section content:
{content}

Respond ONLY with a JSON array, no preamble, no markdown fences. Each item:
- "title": short, clear issue title (max 80 chars)
- "body": 2-4 sentences describing the request or bug clearly, as if writing for a developer
- "type": "feature" or "bug"
- "duplicate_of": exact title of existing issue if already covered, otherwise null

If nothing is actionable, return: []"""

def extract_issues(section: dict, existing_titles: list[str]) -> list[dict]:
    prompt = EXTRACTION_PROMPT.format(
        existing_issues="\n".join(f"- {t}" for t in existing_titles) or "None yet",
        section_title=section["title"],
        content=section["content"],
    )

    message = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        print(f"  Failed to parse LLM response:\n{raw}")
        return []

# --- Ensure labels exist ---
def ensure_labels():
    existing = [l.name for l in repo.get_labels()]
    needed = [
        ("feature-request", "0075ca"),
        ("bug", "d73a4a"),
        ("from-talk-page", "e4e669"),
    ]
    for name, color in needed:
        if name not in existing:
            repo.create_label(name, color)

# --- Create GitHub issue ---
def create_issue(title: str, body: str, issue_type: str):
    labels = ["from-talk-page", "feature-request" if issue_type == "feature" else "bug"]
    full_body = (
        f"{body}\n\n"
        f"---\n"
        f"*Automatically imported from the [Wikipedia Talk page]({TALK_PAGE_URL})*"
    )
    issue = repo.create_issue(title=title, body=full_body, labels=labels)
    print(f"  ✓ Created: {issue.title} → {issue.html_url}")

# --- Commit updated timestamp back to repo ---
def commit_last_scraped(new_ts: str):
    with open(LAST_SCRAPED_FILE) as f:
        new_content = f.read()
    try:
        existing_file = repo.get_contents(LAST_SCRAPED_FILE)
        repo.update_file(
            LAST_SCRAPED_FILE,
            f"Update last scraped timestamp to {new_ts}",
            new_content,
            existing_file.sha
        )
    except Exception:
        repo.create_file(LAST_SCRAPED_FILE, "Create last scraped timestamp", new_content)
    print(f"  Committed last_scraped.txt → {new_ts}")

# --- Main ---
def main():
    last_scraped = load_last_scraped()
    print(f"Last scraped: {last_scraped}")

    new_sections = fetch_new_sections(last_scraped)
    print(f"New sections to process: {len(new_sections)}")

    if not new_sections:
        print("Nothing new, exiting.")
        return

    ensure_labels()
    existing_titles = get_existing_issue_titles()

    for section in new_sections:
        print(f"Processing section: '{section['title']}'...")
        items = extract_issues(section, existing_titles)
        print(f"  Extracted {len(items)} actionable items")

        for item in items:
            if item.get("duplicate_of"):
                print(f"  ↩ Skipping duplicate: '{item['title']}' (covered by '{item['duplicate_of']}')")
                continue
            create_issue(item["title"], item["body"], item["type"])
            existing_titles.append(item["title"])

    new_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_last_scraped(new_ts)
    commit_last_scraped(new_ts)
    print(f"Done. Next run will scrape from {new_ts}")

if __name__ == "__main__":
    main()
