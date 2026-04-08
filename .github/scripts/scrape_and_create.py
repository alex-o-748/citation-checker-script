import os
import json
import requests
from datetime import datetime, timezone
from anthropic import Anthropic
from github import Github

# --- Config ---
TALK_PAGE = "User_talk:Alaexis/AI_Source_Verification"
LAST_SCRAPED_FILE = ".github/last_scraped.txt"
ANTHROPIC_MODEL = "claude-opus-4-5"
TALK_PAGE_URL = "https://en.wikipedia.org/wiki/User_talk:Alaexis/AI_Source_Verification"

# --- Init ---
client = Anthropic()
gh = Github(os.environ["GITHUB_TOKEN"])
repo = gh.get_repo(os.environ["GITHUB_REPO"])

# --- Load/save last scraped timestamp ---
def load_last_scraped():
    try:
        with open(LAST_SCRAPED_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "2024-01-01T00:00:00Z"

def save_last_scraped(ts: str):
    with open(LAST_SCRAPED_FILE, "w") as f:
        f.write(ts)

# --- Fetch new revisions via MediaWiki API ---
def fetch_new_revisions(since: str) -> list[dict]:
    params = {
        "action": "query",
        "titles": TALK_PAGE,
        "prop": "revisions",
        "rvprop": "ids|timestamp|content",
        "rvstart": since,
        "rvdir": "newer",
        "rvlimit": 50,
        "rvslots": "main",
        "formatversion": "2",
        "format": "json",
    }
    r = requests.get("https://en.wikipedia.org/w/api.php", params=params)
    r.raise_for_status()
    data = r.json()

    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return []

    revisions = pages[0].get("revisions", [])
    results = []
    for rev in revisions:
        content = rev.get("slots", {}).get("main", {}).get("content", "")
        if content:
            results.append({
                "timestamp": rev["timestamp"],
                "content": content,
            })
    return results

# --- Get existing issue titles for dedup ---
def get_existing_issue_titles() -> list[str]:
    issues = repo.get_issues(state="open")
    return [issue.title for issue in issues]

# --- LLM extraction prompt ---
EXTRACTION_PROMPT = """You are helping maintain a GitHub issue tracker for a Wikipedia userscript called "AI Source Verification" (also known as the citation checker script).

The tool helps Wikipedia editors verify whether cited sources actually support the claims they're attached to. It uses AI (Claude, GPT-4, Gemini) to check citations and returns confidence scores with verdicts.

Below is content from the Wikipedia Talk page for this userscript. It may contain feature requests, bug reports, questions, or general discussion from Wikipedia editors who use the tool.

Your job:
1. Extract all ACTIONABLE items (feature requests and bug reports only)
2. Ignore: thank-yous, general questions with no clear ask, already-resolved discussions, noise, meta-discussion about Wikipedia
3. For each actionable item return structured JSON

Existing open GitHub issues (avoid creating duplicates):
{existing_issues}

Talk page content:
{content}

Respond ONLY with a JSON array, no preamble, no markdown fences. Each item:
- "title": short, clear issue title (max 80 chars)
- "body": 2-4 sentences describing the request or bug clearly, as if writing for a developer
- "type": "feature" or "bug"
- "duplicate_of": exact title of existing issue if already covered, otherwise null

If nothing is actionable, return: []"""

def extract_issues(content: str, existing_titles: list[str]) -> list[dict]:
    prompt = EXTRACTION_PROMPT.format(
        existing_issues="\n".join(f"- {t}" for t in existing_titles) or "None yet",
        content=content,
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
        print(f"Failed to parse LLM response:\n{raw}")
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
    full_body = f"{body}\n\n---\n*Automatically imported from the [Wikipedia Talk page]({TALK_PAGE_URL})*"
    issue = repo.create_issue(title=title, body=full_body, labels=labels)
    print(f"  ✓ Created: {issue.title} → {issue.html_url}")

# --- Main ---
def main():
    last_scraped = load_last_scraped()
    print(f"Last scraped: {last_scraped}")

    revisions = fetch_new_revisions(last_scraped)
    print(f"New revisions found: {len(revisions)}")

    if not revisions:
        print("Nothing new, exiting.")
        return

    ensure_labels()
    existing_titles = get_existing_issue_titles()

    for rev in revisions:
        print(f"Processing revision from {rev['timestamp']}...")
        items = extract_issues(rev["content"], existing_titles)
        print(f"  Extracted {len(items)} actionable items")

        for item in items:
            if item.get("duplicate_of"):
                print(f"  ↩ Skipping duplicate: '{item['title']}'")
                continue
            create_issue(item["title"], item["body"], item["type"])
            existing_titles.append(item["title"])

    # Save new timestamp and commit it
    new_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_last_scraped(new_ts)

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

    print(f"Done. Next run will scrape from {new_ts}")

if __name__ == "__main__":
    main()
