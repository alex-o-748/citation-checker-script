// Classify whether an extracted source body is usable for downstream LLM
// verification. Returns { usable: true, reason: 'ok' } for content that should
// proceed, or { usable: false, reason: <pattern-name> } for structurally-bad
// bodies (Wayback chrome, CSS leak, JSON-LD blob, anti-bot challenge, etc.).
//
// When the classifier returns usable:false, the caller (userscript / benchmark)
// should short-circuit to a "Source unavailable" verdict without invoking an
// LLM. This pulls the SU-vs-Not-Supported decision out of the LLM's
// responsibility in cases where the answer is mechanically determinable — the
// LLM only needs to handle support-or-not-support on usable content.
//
// Patterns are derived from real failure cases observed in a 185-row × 9-provider
// citation-verification benchmark (combined-integration treatment), where both
// Claude Sonnet 4.5 and Claude Opus 4.7 agreed on a wrong "Source unavailable"
// verdict against a ground-truth "Not supported" label. Each pattern has at
// least one matching regression-test fixture in tests/body_classifier.test.js.

const SIGNATURE_LEN = 500;
const SHORT_BODY_FLOOR = 300;
// Upper length bound for "chrome-dominated" detectors. Above this, even if a
// chrome marker is present at the top, we assume substantive content follows
// (e.g., row_9: 912 chars of "The Wayback Machine - …" prefix + USCIS article).
// Tuned conservatively to favor false negatives (let body through, LLM handles)
// over false positives (real content discarded as unusable).
const CHROME_LENGTH_CAP = 600;

const PATTERNS = [
  {
    reason: 'json_ld_leak',
    // Body is a JSON-LD blob (schema.org structured data picked up by Defuddle
    // instead of the article body).
    test: (text) =>
      /^\s*\{[^{}]{0,200}"@(context|type|graph)"\s*:/.test(text),
  },
  {
    reason: 'css_leak',
    // Body is CSS rules (Defuddle picked up a <style> element).
    // Confirmed with CSS-glyph density in the signature window.
    test: (text) => {
      const head = text.slice(0, SIGNATURE_LEN);
      if (!/^[\s.#@\w-]+\{[^{}]{10,}/.test(head)) return false;
      const cssGlyphs = (head.match(/[{};:]/g) || []).length;
      return cssGlyphs / head.length > 0.05;
    },
  },
  {
    reason: 'anti_bot_challenge',
    // Cloudflare / Anubis / generic JS-challenge interstitials.
    test: (text) =>
      /(Making sure you('|&#39;)re not a bot|Anubis uses a Proof-of-Work|Just a moment\.\.\.|Verifying you are human|Please enable JavaScript and cookies|Checking your browser before accessing)/i
        .test(text.slice(0, 1500)),
  },
  {
    reason: 'wayback_redirect_notice',
    // Wayback "page redirected at crawl time" interstitial.
    test: (text) =>
      /Got an HTTP \d{3} response at crawl time/.test(text.slice(0, 1500)),
  },
  {
    reason: 'wayback_chrome',
    // Wayback Machine wrapper captured without the inner archived content.
    // Fire only when the body is too short to contain substantive content
    // after the chrome — a Wayback prefix on a long body indicates the real
    // article follows (see row_9: 912 chars, USCIS glossary entry).
    // The id_-flag URL rewrite in PAP reduces incidence but doesn't eliminate
    // it (PDF-too-large, JS-only archives still produce chrome).
    test: (text) => {
      if (text.length >= CHROME_LENGTH_CAP) return false;
      const head = text.slice(0, SIGNATURE_LEN);
      return (
        /^The Wayback Machine - https?:\/\//.test(head) ||
        /\d+ captures\s+\d{1,2} \w+ \d{4}/.test(head) ||
        /\bCOLLECTED BY\s+Collection:/.test(head)
      );
    },
  },
  {
    reason: 'amazon_stub',
    // Amazon listing page rendered without product details (JS-loaded).
    test: (text) =>
      /Conditions of Use(?: & Sale)?\s*\n?\s*Privacy Notice\s*\n?\s*©\s*\d{4}-\d{4},?\s*Amazon\.com/i
        .test(text),
  },
  {
    reason: 'short_body',
    // Catch-all for bodies too short to be substantive. Conservative floor —
    // false positives (real short content flagged as unusable) directly hurt
    // accuracy; false negatives are recoverable (LLM still handles).
    test: (text) => text.length < SHORT_BODY_FLOOR,
  },
];

export function classifyBody(text) {
  if (text == null) return { usable: false, reason: 'short_body' };
  const trimmed = text.trim();
  for (const { reason, test } of PATTERNS) {
    if (test(trimmed)) return { usable: false, reason };
  }
  return { usable: true, reason: 'ok' };
}
