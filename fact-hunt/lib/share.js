// What a share says, and the Open Graph tags that make its link preview.
//
// Shares go out as plain links the person chooses to follow — never a
// widget or a third-party script on the page (Toolforge's cross-site policy,
// and widgets track people).

import { TOPICS } from './cards.js';

export const APP_NAME = 'Fact Hunt';
export const TAGLINE = "Find and fix inaccuracies on Wikipedia: places where an article says something its own source doesn't.";

const spanText = (part) => part.text.slice(part.span.start, part.span.end);

// Bluesky counts 300 graphemes including the link; keep the text well under.
const MAX_TEXT = 220;

function clip(text, max = MAX_TEXT) {
    if (text.length <= max) return text;
    return text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

export function fixShareText(card) {
    return clip(`Wikipedia's article on ${card.pageTitle} said ${spanText(card.claim)}. Its own source said ${spanText(card.quote)}. I fixed it. Find one yourself:`);
}

export function puzzleShareText() {
    return 'This Wikipedia sentence disagrees with its own source. Can you spot where?';
}

export function topicShareText(topicId, count) {
    const label = TOPICS.find(t => t.id === topicId)?.label || 'Wikipedia';
    const noun = count === 1 ? 'place' : 'places';
    return `There are ${count} ${noun} where Wikipedia's ${label.toLowerCase()} articles disagree with their own sources. Help fix them:`;
}

/** Links that open each service's composer with the text and link filled in. */
export function shareTargets(text, url) {
    const both = `${text} ${url}`;
    return {
        bluesky: `https://bsky.app/intent/compose?text=${encodeURIComponent(both)}`,
        x: `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
        // Mastodon has no single host: the page asks for the person's server
        // and builds https://<server>/share?text=… itself.
        mastodonPath: `/share?text=${encodeURIComponent(both)}`,
    };
}

const escapeAttr = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** <meta> tags for a page: title, description, and a preview image if there is one. */
export function metaTags({ title, description, url = null, image = null }) {
    const tags = [
        `<title>${escapeAttr(title)}</title>`,
        `<meta name="description" content="${escapeAttr(description)}">`,
        `<meta property="og:site_name" content="${APP_NAME}">`,
        `<meta property="og:title" content="${escapeAttr(title)}">`,
        `<meta property="og:description" content="${escapeAttr(description)}">`,
        `<meta property="og:type" content="website">`,
    ];
    if (url) tags.push(`<meta property="og:url" content="${escapeAttr(url)}">`);
    if (image) {
        tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`);
        tags.push('<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">');
        tags.push('<meta name="twitter:card" content="summary_large_image">');
    } else {
        tags.push('<meta name="twitter:card" content="summary">');
    }
    return tags.join('\n    ');
}

export function pageMeta(kind, { card = null, topicId = null, count = null } = {}) {
    if (kind === 'fix' && card) {
        return {
            title: `Fixed: ${card.pageTitle}`,
            description: `Wikipedia said ${spanText(card.claim)}. Its own source said ${spanText(card.quote)}. Someone fixed it.`,
        };
    }
    if (kind === 'puzzle' && card) {
        return { title: puzzleShareText(), description: card.claim.text };
    }
    if (kind === 'topic' && topicId) {
        const label = TOPICS.find(t => t.id === topicId)?.label || 'Wikipedia';
        return { title: `${label}: ${APP_NAME}`, description: count == null ? TAGLINE : topicShareText(topicId, count).replace(/:$/, '.') };
    }
    return { title: `${APP_NAME}: find and fix inaccuracies on Wikipedia`, description: TAGLINE };
}
