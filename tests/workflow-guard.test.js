import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo setting "Allow GitHub Actions to create and approve pull requests"
// is one checkbox for both. The fix proposer needs the first half; these tests
// make sure no workflow ever uses the second, or merges anything.

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const workflows = readdirSync(dir)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => [f, readFileSync(join(dir, f), 'utf8')]);

const FORBIDDEN = [
    [/\bgh\s+pr\s+review\b/, 'gh pr review'],
    [/--approve\b/, '--approve'],
    [/\bgh\s+pr\s+merge\b/, 'gh pr merge'],
    [/auto-?merge/i, 'auto-merge'],
    [/\/pulls\/[^\s/]+\/(reviews|merge)\b/, 'the reviews or merge API'],
    [/createPullRequestReview|mergePullRequest|enablePullRequestAutoMerge/, 'a review or merge GraphQL mutation'],
    [/hmarr\/auto-approve-action|pascalgn\/automerge-action|peter-evans\/enable-pull-request-automerge/, 'an approve or merge action'],
];

test('no workflow approves, merges or auto-merges a pull request', () => {
    assert.ok(workflows.length > 0);
    for (const [file, text] of workflows) {
        for (const [pattern, name] of FORBIDDEN) {
            assert.doesNotMatch(text, pattern, `${file} uses ${name}`);
        }
    }
});

test('a workflow that pushes to main does so only when it runs on main', () => {
    for (const [file, text] of workflows) {
        if (!/HEAD:main/.test(text)) continue;
        assert.match(text, /github\.ref == 'refs\/heads\/main'/, `${file} pushes to main from any branch`);
    }
});

test('the fix proposer opens drafts and leaves no token for the agent', () => {
    const [, text] = workflows.find(([f]) => f === 'feedback-fix-proposer.yml');
    const creates = text.match(/gh pr create[^\n]*/g) || [];
    assert.ok(creates.length > 0);
    for (const line of creates) assert.match(line, /--draft/);
    assert.match(text, /persist-credentials:\s*false/);
});
