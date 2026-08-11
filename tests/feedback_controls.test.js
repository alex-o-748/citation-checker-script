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
  normalizeRevisionId,
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

// The revision helpers live elsewhere in the class, so they are lifted
// separately rather than stubbed — the point of the revision tests is that the
// id the real reader produces is the one that reaches the comment link.
function classMethod(name) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  const open = `\n        ${name}(`;
  const start = src.indexOf(open);
  assert.ok(start !== -1, `${name}() not found in main.js — did the method get renamed?`);
  const end = src.indexOf('\n        }\n', start);
  assert.ok(end !== -1, `${name}() has no closing brace at class indentation`);
  return src.slice(start + 1, end + '\n        }'.length);
}

// --- stubs --------------------------------------------------------------

function jq(el) {
  return {
    0: el,
    length: 1,
    addClass(c) { el.classList.add(...String(c).split(/\s+/)); return this; },
  };
}

function makeHarness({ postFeedback, config } = {}) {
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

  // wgTitle for the heading, and the revision/site keys the permalink is built
  // from. Nothing is posted through the API, so no other config is consulted.
  const defaultConfig = {
    wgTitle: 'Barack Obama',
    wgPageName: 'Barack_Obama',
    wgServer: '//en.wikipedia.org',
    wgScript: '/w/index.php',
    wgRevisionId: 1234567,
    wgCurRevisionId: 1234567,
  };
  const values = { ...defaultConfig, ...config };
  const mw = { config: { get: key => values[key] ?? null } };

  const posted = [];
  const postFeedbackStub = postFeedback || (payload => { posted.push(payload); return Promise.resolve(true); });

  const Harness = new Function(
    'document', 'window', 'localStorage', 'OO', 'mw', 'VERDICT_LIST', 'newCheckId',
    'buildFeedbackPayload', 'postFeedback', 'buildCommentUrl', 'normalizeRevisionId',
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
${classMethod('getArticleRevisionId')}
${classMethod('getRevisionPermalinkUrl')}
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
    normalizeRevisionId,
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

test('Yes, No and Comment are built as one set of buttons', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const yes = ctx.byTitle('This verdict looks right');
  const no = ctx.byTitle('This verdict looks wrong');
  const comment = ctx.byLabel('Comment');

  // Two bare emoji beside an icon-and-label button read as decoration rather
  // than as part of the same set. All three are the same widget with the same
  // trimmings, which is what keeps them looking like one row of controls.
  for (const [name, button] of [['Yes', yes], ['No', no], ['Comment', comment]]) {
    assert.ok(button, `${name} is missing from the row`);
    assert.ok(button.cfg.icon, `${name} has no icon`);
    assert.ok(button.cfg.label, `${name} has no label`);
    assert.equal(button.cfg.framed, false, `${name} is framed but the others are not`);
  }
  // `check` and `close` ship in oojs-ui.styles.icons-interactions, which the
  // script already loads; anything else would need a new module.
  assert.equal(yes.cfg.icon, 'check');
  assert.equal(no.cfg.icon, 'close');
});

test('the chosen answer is marked and the other one fades', async () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const up = ctx.byTitle('This verdict looks right');
  const down = ctx.byTitle('This verdict looks wrong');
  // Both answers disable on the first click, so OOUI dims them equally. Without
  // a chosen/dimmed distinction the editor cannot tell which way they voted.
  await down.click();
  assert.equal(down.$element[0].classList.contains('is-chosen'), true);
  assert.equal(up.$element[0].classList.contains('is-dimmed'), true);
  assert.equal(down.$element[0].classList.contains('is-dimmed'), false);
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

// A confirmation the editor never sees is the same as no confirmation. The
// single status line used to sit below the correction chips, so a thumbs-up —
// which does not open the chips at all — reported "Thanks" further down the
// panel than the button that was clicked.
test('each confirmation sits with the control that produced it', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  const correction = el.querySelector('.verifier-feedback-correction');
  const ratingStatus = [...el.children].find(c => c.classList.contains('verifier-feedback-status'));
  const chipStatus = correction.querySelector('.verifier-feedback-status');

  assert.ok(ratingStatus, 'the rating has no status line of its own');
  assert.ok(chipStatus, 'the correction chips have no status line of their own');
  assert.equal(
    ratingStatus.compareDocumentPosition(correction) & 4 /* DOCUMENT_POSITION_FOLLOWING */,
    4,
    'the rating confirmation must come before the correction block, not after it'
  );

  await ctx.byTitle('This verdict looks wrong').click();
  assert.match(ratingStatus.textContent, /Thanks/);
  assert.equal(chipStatus.textContent, '');

  await ctx.byLabel('SUPPORTED').click();
  assert.match(chipStatus.textContent, /Thanks/);
});

test('a recorded confirmation is marked as such, not left as plain caption text', async () => {
  const ctx = makeHarness();
  const el = ctx.harness.buildFeedbackControls(RESULT);
  await ctx.byTitle('This verdict looks right').click();
  const status = el.querySelector('.verifier-feedback-status');
  assert.equal(status.classList.contains('is-done'), true);
  assert.equal(status.classList.contains('is-error'), false);
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

// Reproducibility: the preloaded section has to name the revision that was
// checked, and link it, or a reader coming to the talk page later has no fixed
// page to compare a second run against.
test('the comment link carries the revision the check ran against', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const body = new URL(ctx.byLabel('Comment').cfg.href).searchParams.get('preloadparams[]');
  assert.match(
    body,
    /revision \[https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=Barack_Obama&oldid=1234567 1234567\]/,
  );
});

// wgRevisionId is the revision on screen, which is the one that was read.
// Naming wgCurRevisionId while an old revision is displayed would record a
// page the tool never saw.
test('viewing an old revision records that revision, not the current one', () => {
  const ctx = makeHarness({ config: { wgRevisionId: 111, wgCurRevisionId: 999 } });
  ctx.harness.buildFeedbackControls(RESULT);
  const body = new URL(ctx.byLabel('Comment').cfg.href).searchParams.get('preloadparams[]');
  assert.match(body, /revision \[\S+oldid=111 111\]/);
  assert.equal(body.includes('999'), false);
});

test('a page with no revision of its own contributes no revision line', () => {
  const ctx = makeHarness({ config: { wgRevisionId: 0, wgCurRevisionId: 0 } });
  ctx.harness.buildFeedbackControls(RESULT);
  const body = new URL(ctx.byLabel('Comment').cfg.href).searchParams.get('preloadparams[]');
  assert.equal(body.includes('revision'), false);
});

test('the preloaded text matches what the pure builder produces', () => {
  const ctx = makeHarness();
  ctx.harness.buildFeedbackControls(RESULT);
  const params = new URL(ctx.byLabel('Comment').cfg.href).searchParams;
  assert.equal(params.get('preloadparams[]'), buildTalkSectionBody({
    checkId: 'a7f3k2q9',
    articleUrl: 'https://en.wikipedia.org/wiki/Barack_Obama',
    articleTitle: 'Barack Obama',
    revisionId: 1234567,
    revisionUrl: 'https://en.wikipedia.org/w/index.php?title=Barack_Obama&oldid=1234567',
    citationNumber: '12',
    claimText: 'He was born in Honolulu.',
    sourceUrl: 'https://example.com/source',
    verdict: 'NOT SUPPORTED',
    comments: 'The source never mentions Honolulu.',
    providerName: 'Claude',
    model: 'claude-sonnet-4-6',
  }));
});
