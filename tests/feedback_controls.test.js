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
  buildTalkSectionBody,
  buildCommentUrl,
  FEEDBACK_TALK_PAGE,
} from '../core/feedback.js';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Same approach as styles.test.js: main.js is an IIFE that expects a browser,
// so the feedback methods are lifted out of the source and run against stubs.
// This is what keeps the routing decision — ratings to the worker, comments to
// the wiki — covered by tests rather than only by inspection.
const START = '        getFeedbackClientId() {';
const END_MARKER = '            return wrap;\n        }';

function feedbackMethods() {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const start = src.indexOf(START);
  const end = src.indexOf(END_MARKER, start);
  assert.ok(start !== -1, 'getFeedbackClientId() not found in main.js — did the method get renamed?');
  assert.ok(end !== -1, 'buildFeedbackControls() tail not found in main.js — did the method get renamed?');
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

function makeHarness({ postFeedback } = {}) {
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
    setHref(href) { this.cfg.href = href; return this; }
    click() { return Promise.all((this.handlers.click || []).map(fn => fn())); }
  }

  // Only wgTitle is consulted now that nothing is posted through the API.
  const mw = { config: { get: key => ({ wgTitle: 'Barack Obama' }[key] ?? null) } };

  const posted = [];
  const postFeedbackStub = postFeedback || (payload => { posted.push(payload); return Promise.resolve(true); });

  const Harness = new Function(
    'document', 'window', 'localStorage', 'OO', 'mw', 'VERDICT_LIST', 'newCheckId',
    'buildFeedbackPayload', 'postFeedback', 'buildCommentUrl',
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
    { ui: { ButtonWidget } },
    mw,
    VERDICT_LIST,
    newCheckId,
    buildFeedbackPayload,
    payload => postFeedbackStub(payload),
    buildCommentUrl,
  );

  return {
    harness: new Harness(),
    posted,
    byLabel: label => widgets.find(w => w.cfg.label === label),
    byTitle: title => widgets.find(w => w.cfg.title === title),
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
  const ctx = makeHarness();
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

test('Comment is a link to the wiki edit form, not an in-tool composer', () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  const button = ctx.byLabel('Comment');
  // The editor writes in Wikipedia's own interface — with preview, signature
  // and native handling of blocks and abuse filters — so the sidebar has no
  // textarea of its own.
  assert.equal(el.querySelector('textarea'), null);
  assert.equal(button.cfg.target, '_blank');
  const url = new URL(button.cfg.href);
  assert.equal(url.searchParams.get('title'), FEEDBACK_TALK_PAGE);
  assert.equal(url.searchParams.get('section'), 'new');
});

test('the comment link preloads the check context and the check id', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const params = new URL(ctx.byLabel('Comment').cfg.href).searchParams;
  assert.match(params.get('preloadtitle'), /check a7f3k2q9/);
  assert.match(params.get('preloadparams[]'), /He was born in Honolulu\./);
  assert.match(params.get('preloadparams[]'), /source-verifier check: a7f3k2q9/);
});

test('the comment link is available without rating first', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  assert.ok(ctx.byLabel('Comment').cfg.href, 'commenting should not require a rating');
});

test('choosing a correction updates the comment link to carry it', async () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const before = new URL(ctx.byLabel('Comment').cfg.href).searchParams.get('preloadparams[]');
  assert.equal(before.includes('should be'), false);

  await ctx.byTitle('This verdict looks wrong').click();
  await ctx.byLabel('SUPPORTED').click();

  const after = new URL(ctx.byLabel('Comment').cfg.href).searchParams.get('preloadparams[]');
  assert.match(after, /Editor says it should be:''' SUPPORTED/);
});

test('the preloaded text matches what the pure builder produces', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const params = new URL(ctx.byLabel('Comment').cfg.href).searchParams;
  assert.equal(params.get('preloadparams[]'), buildTalkSectionBody({
    checkId: 'a7f3k2q9',
    articleUrl: 'https://en.wikipedia.org/wiki/Barack_Obama',
    articleTitle: 'Barack Obama',
    citationNumber: '12',
    claimText: 'He was born in Honolulu.',
    sourceUrl: 'https://example.com/source',
    verdict: 'NOT SUPPORTED',
    comments: 'The source never mentions Honolulu.',
    providerName: 'Claude',
    model: 'claude-sonnet-4-6',
  }));
});
