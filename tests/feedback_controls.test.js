import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  VERDICT_LIST,
} from '../core/verdicts.js';
import {
  newCheckId,
  buildFeedbackPayload,
  buildTalkSectionTitle,
  buildTalkSectionBody,
  FEEDBACK_TALK_PAGE,
  FEEDBACK_TALK_PAGE_URL,
} from '../core/feedback.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as styles.test.js: main.js is an IIFE that expects a browser,
// so the feedback methods are lifted out of the source and run against stubs.
// This is what keeps the routing decision — ratings to the worker, comments to
// the wiki — covered by tests rather than only by inspection.
const START = '        getFeedbackClientId() {';
const END_MARKER = '            return { button, panel };\n        }';

function feedbackMethods() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf(START);
  const end = src.indexOf(END_MARKER, start);
  assert.ok(start !== -1, 'getFeedbackClientId() not found in main.js — did the method get renamed?');
  assert.ok(end !== -1, 'buildFeedbackCommentPanel() tail not found in main.js — did the method get renamed?');
  return src.slice(start, end + END_MARKER.length);
}

// --- stubs --------------------------------------------------------------

function jq(el) {
  return {
    0: el,
    length: 1,
    addClass(c) { el.classList.add(...String(c).split(/\s+/)); return this; },
  };
}

function makeHarness({ userName = 'Alice', serverName = 'en.wikipedia.org', postFeedback, editResult } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const { document } = dom.window;
  const widgets = [];
  const store = new Map();

  class ButtonWidget {
    constructor(cfg = {}) {
      this.cfg = cfg;
      this.disabled = false;
      this.handlers = {};
      const el = document.createElement('span');
      el.className = 'oo-ui-buttonElement';
      el.textContent = cfg.label ?? '';
      this.$element = jq(el);
      widgets.push(this);
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    setDisabled(v) { this.disabled = v; return this; }
    click() { return Promise.all((this.handlers.click || []).map(fn => fn())); }
  }

  const inputs = [];
  class MultilineTextInputWidget {
    constructor(cfg = {}) {
      this.cfg = cfg;
      this.value = '';
      this.handlers = {};
      this.$element = jq(document.createElement('textarea'));
      inputs.push(this);
    }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    getValue() { return this.value; }
    setValue(v) { this.value = v; (this.handlers.change || []).forEach(fn => fn(v)); return this; }
    focus() { return this; }
  }

  const edits = [];
  class Api {
    postWithEditToken(params) {
      edits.push(params);
      return editResult ? editResult() : Promise.resolve({});
    }
  }

  const mw = {
    config: { get: key => ({ wgUserName: userName, wgTitle: 'Barack Obama', wgServerName: serverName }[key] ?? null) },
    Api,
    ForeignApi: Api,
    loader: { using: () => Promise.resolve() },
  };

  const posted = [];
  const postFeedbackStub = postFeedback || (payload => { posted.push(payload); return Promise.resolve(true); });

  const Harness = new Function(
    'document', 'window', 'localStorage', 'OO', 'mw', 'VERDICT_LIST', 'newCheckId',
    'buildFeedbackPayload', 'postFeedback', 'buildTalkSectionTitle', 'buildTalkSectionBody',
    'FEEDBACK_TALK_PAGE', 'FEEDBACK_TALK_PAGE_URL',
    `
    class Harness {
      constructor() {
        this.providers = { claude: { name: 'Claude', model: 'claude-sonnet-4-6' } };
        this.currentProvider = 'claude';
      }
      t(en, params) {
        let s = en;
        if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(String(params[k]));
        return s;
      }
${feedbackMethods()}
    }
    return Harness;
    `,
  )(
    document,
    { location: { origin: 'https://en.wikipedia.org', pathname: '/wiki/Barack_Obama' } },
    {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
    },
    { ui: { ButtonWidget, MultilineTextInputWidget } },
    mw,
    VERDICT_LIST,
    newCheckId,
    buildFeedbackPayload,
    payload => postFeedbackStub(payload),
    buildTalkSectionTitle,
    buildTalkSectionBody,
    FEEDBACK_TALK_PAGE,
    FEEDBACK_TALK_PAGE_URL,
  );

  return {
    harness: new Harness(),
    posted,
    edits,
    byLabel: label => widgets.find(w => w.cfg.label === label),
    byTitle: title => widgets.find(w => w.cfg.title === title),
    input: () => inputs[inputs.length - 1],
  };
}

const RESULT = {
  checkId: 'a7f3k2q9',
  citationNumber: '12',
  claimText: 'He was born in Honolulu.',
  url: 'https://example.com/source',
  verdict: 'NOT SUPPORTED',
  comments: 'The source never mentions Honolulu.',
};

// --- tests --------------------------------------------------------------

test('no controls are offered for a check with no id', () => {
  const { harness } = makeHarness();
  // An unparseable or errored verdict has nothing to attach feedback to;
  // buttons that silently go nowhere would be worse than no buttons.
  assert.equal(harness.buildFeedbackControls({ ...RESULT, checkId: null }), null);
  assert.equal(harness.buildFeedbackControls({}), null);
});

test('thumbs-up posts a +1 rating against the check id', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks right').click();
  assert.equal(ctx.posted.length, 1);
  assert.equal(ctx.posted[0].check_id, 'a7f3k2q9');
  assert.equal(ctx.posted[0].rating, 1);
  assert.equal(ctx.posted[0].corrected_verdict, null);
  assert.match(el.querySelector('.verifier-feedback-status').textContent, /Thanks/);
});

test('a rating carries a client id but never a username', async () => {
  const ctx = makeHarness({ userName: 'Alice' });
  ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks right').click();
  assert.match(ctx.posted[0].client_id, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(ctx.posted[0]).includes('Alice'), false);
});

test('the client id is stable across separate ratings in one browser', async () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks right').click();
  const second = ctx.harness.buildFeedbackControls({ ...RESULT, checkId: 'b8g4l3r0' });
  assert.ok(second);
  await ctx.byTitle('This verdict looks wrong').click();
  assert.equal(ctx.posted[0].client_id, ctx.posted[1].client_id);
});

test('rating twice is not possible — both thumbs disable on the first click', async () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const up = ctx.byTitle('This verdict looks right');
  const down = ctx.byTitle('This verdict looks wrong');
  await up.click();
  assert.equal(up.disabled, true);
  assert.equal(down.disabled, true);
});

test('thumbs-down reveals the corrected-verdict chips; thumbs-up does not', async () => {
  const down = makeHarness();
  const downEl = down.harness.buildFeedbackControls(RESULT);
  assert.equal(downEl.querySelector('.verifier-feedback-correction').hidden, true);
  await down.byTitle('This verdict looks wrong').click();
  assert.equal(downEl.querySelector('.verifier-feedback-correction').hidden, false);

  const up = makeHarness();
  const upEl = up.harness.buildFeedbackControls(RESULT);
  await up.byTitle('This verdict looks right').click();
  assert.equal(upEl.querySelector('.verifier-feedback-correction').hidden, true);
});

test('every canonical verdict is offered as a correction chip', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  for (const verdict of VERDICT_LIST) {
    assert.ok(ctx.byLabel(verdict), `no chip for ${verdict}`);
  }
});

test('choosing a corrected verdict records it without re-counting the rating', async () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks wrong').click();
  await ctx.byLabel('SUPPORTED').click();
  assert.equal(ctx.posted.length, 2);
  assert.equal(ctx.posted[0].rating, -1);
  assert.equal(ctx.posted[1].rating, null, 'the correction must not re-send the rating');
  assert.equal(ctx.posted[1].corrected_verdict, 'SUPPORTED');
  assert.equal(ctx.posted[1].check_id, 'a7f3k2q9');
});

test('a failed rating tells the user instead of silently doing nothing', async () => {
  const ctx = makeHarness({ postFeedback: () => Promise.reject(new Error('HTTP 500')) });
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks right').click();
  await new Promise(r => setImmediate(r));
  const status = el.querySelector('.verifier-feedback-status');
  assert.match(status.textContent, /Could not record/);
  assert.equal(status.classList.contains('is-error'), true);
});

// --- the comment half ---------------------------------------------------

test('logged-out users get a link to the talk page, not a composer', () => {
  const ctx = makeHarness({ userName: null });
  const el = ctx.harness.buildFeedbackControls(RESULT);
  const button = ctx.byLabel('Comment on talk page');
  assert.ok(button);
  assert.equal(button.cfg.href, FEEDBACK_TALK_PAGE_URL);
  assert.equal(el.querySelector('.verifier-feedback-comment'), null);
});

test('the composer is hidden until the comment button is clicked', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  const panel = el.querySelector('.verifier-feedback-comment');
  assert.equal(panel.hidden, true);
  await ctx.byLabel('Comment').click();
  assert.equal(panel.hidden, false);
});

test('the composer shows the exact wikitext that will be posted', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  const preview = el.querySelector('.verifier-feedback-preview pre').textContent;
  assert.match(preview, /^== Feedback: Barack Obama \[12\] \(check a7f3k2q9\) ==/);
  assert.match(preview, /source-verifier check: a7f3k2q9/);
  assert.match(preview, /~~~~/);
});

test('the composer names the account the edit will be signed with', async () => {
  const ctx = makeHarness({ userName: 'Alice' });
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  assert.match(el.querySelector('.verifier-feedback-notice').textContent, /Alice/);
});

test('an empty note is refused rather than posted', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  await ctx.byLabel('Post to talk page').click();
  assert.equal(ctx.edits.length, 0);
  assert.match(el.querySelector('.verifier-feedback-status').textContent, /Write something first/);
});

test('a written comment goes to the wiki and its section is recorded against the check', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  ctx.input().setValue('The source does support this, on page 4.');
  await ctx.byLabel('Post to talk page').click();

  assert.equal(ctx.edits.length, 1);
  const edit = ctx.edits[0];
  assert.equal(edit.action, 'edit');
  assert.equal(edit.title, FEEDBACK_TALK_PAGE);
  assert.equal(edit.section, 'new');
  assert.equal(edit.sectiontitle, 'Feedback: Barack Obama [12] (check a7f3k2q9)');
  assert.match(edit.text, /The source does support this, on page 4\./);
  assert.match(edit.text, /<!-- source-verifier check: a7f3k2q9 -->/);
  assert.match(edit.summary, /Source Verifier/);

  // The check row learns about the discussion immediately rather than waiting
  // for the scheduled talk-page scrape to notice it.
  const sectionRow = ctx.posted.find(p => p.wiki_section);
  assert.ok(sectionRow, 'the talk-page section should be recorded against the check');
  assert.equal(sectionRow.check_id, 'a7f3k2q9');
  assert.equal(sectionRow.wiki_section, 'Feedback: Barack Obama [12] (check a7f3k2q9)');
  assert.match(el.querySelector('.verifier-feedback-status').textContent, /Posted to the talk page/);
});

test('a comment made after a correction carries that correction into the wikitext', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks wrong').click();
  await ctx.byLabel('SUPPORTED').click();
  await ctx.byLabel('Comment').click();
  ctx.input().setValue('Page 4 says so.');
  await ctx.byLabel('Post to talk page').click();
  assert.match(ctx.edits[0].text, /\* '''Editor says it should be:''' SUPPORTED/);
});

test('a failed post leaves the composer usable and points at the talk page', async () => {
  const ctx = makeHarness({ editResult: () => Promise.reject(new Error('badtoken')) });
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  ctx.input().setValue('Something.');
  await ctx.byLabel('Post to talk page').click();

  const status = el.querySelector('.verifier-feedback-status');
  assert.match(status.textContent, /Could not post/);
  assert.equal(status.classList.contains('is-error'), true);
  assert.equal(ctx.byLabel('Post to talk page').disabled, false, 'the user should be able to retry');
  assert.equal(ctx.posted.some(p => p.wiki_section), false, 'no section should be recorded for a failed post');
});

test('off en.wikipedia the comment is posted through ForeignApi, not the local wiki', async () => {
  const ctx = makeHarness({ serverName: 'fr.wikipedia.org' });
  ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byLabel('Comment').click();
  ctx.input().setValue('Bonjour.');
  await ctx.byLabel('Post to talk page').click();
  // The talk page always lives on en.wikipedia; a plain mw.Api would have
  // created the section on the wrong wiki.
  assert.equal(ctx.edits.length, 1);
  assert.equal(ctx.edits[0].title, FEEDBACK_TALK_PAGE);
});
