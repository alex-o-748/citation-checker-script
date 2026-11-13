// Revision metadata from the Wiki Replicas: the same fields
// analysis/lib/mwapi.js's listRevisions() and baselineRevision() return,
// in a handful of queries rather than one API call per page.
//
// Text is not here (the replicas carry no page content); the runner fetches it
// from the API either way.
//
// `actor_revision` and `comment_revision` are the replicas' views for joining
// from `revision` — the plain `actor` / `comment` views are much slower there
// (https://wikitech.wikimedia.org/wiki/News/Actor_storage_changes_on_the_Wiki_Replicas).
// No rev_sha1: MediaWiki has dropped that column (confirmed on enwiki_p,
// 2026-11-13: "Unknown column 'r.rev_sha1'").
// Bot status is the editor's *current* `bot` group membership: the replicas
// keep no history of group changes that this query could use.

export function toMwTimestamp(iso) {
    return iso.replace(/[-:TZ]/g, '').slice(0, 14);
}

export function fromMwTimestamp(ts) {
    const s = Buffer.isBuffer(ts) ? ts.toString('utf8') : String(ts);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
}

const text = v => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export function buildRevisionsQuery(pageIds, { from, until }) {
    const placeholders = pageIds.map(() => '?').join(', ');
    const sql = `
SELECT r.rev_id, r.rev_page, r.rev_parent_id, r.rev_timestamp, r.rev_len, r.rev_minor_edit,
       r.rev_deleted, a.actor_name, a.actor_user, c.comment_text,
       (SELECT GROUP_CONCAT(ctd.ctd_name SEPARATOR '|')
          FROM change_tag ct JOIN change_tag_def ctd ON ctd.ctd_id = ct.ct_tag_id
         WHERE ct.ct_rev_id = r.rev_id) AS tags,
       EXISTS (SELECT 1 FROM user_groups ug
                WHERE ug.ug_user = a.actor_user AND ug.ug_group = 'bot') AS is_bot
  FROM revision r
  JOIN actor_revision a ON a.actor_id = r.rev_actor
  LEFT JOIN comment_revision c ON c.comment_id = r.rev_comment_id
 WHERE r.rev_page IN (${placeholders})
   AND r.rev_timestamp >= ?${until ? '\n   AND r.rev_timestamp < ?' : ''}
 ORDER BY r.rev_page, r.rev_timestamp, r.rev_id`.trim();
    const params = [...pageIds, toMwTimestamp(from)];
    if (until) params.push(toMwTimestamp(until));
    return { sql, params };
}

export function buildBaselineQuery(pageIds, at) {
    const placeholders = pageIds.map(() => '?').join(', ');
    const sql = `
SELECT r.rev_page, MAX(r.rev_id) AS rev_id
  FROM revision r
 WHERE r.rev_page IN (${placeholders})
   AND r.rev_timestamp = (SELECT MAX(r2.rev_timestamp) FROM revision r2
                           WHERE r2.rev_page = r.rev_page AND r2.rev_timestamp <= ?)
 GROUP BY r.rev_page`.trim();
    return { sql, params: [...pageIds, toMwTimestamp(at)] };
}

export function rowToMeta(row) {
    const name = text(row.actor_name);
    const deleted = Number(row.rev_deleted) || 0;
    return {
        page_id: Number(row.rev_page),
        rev_id: Number(row.rev_id),
        parent_id: row.rev_parent_id === null ? null : Number(row.rev_parent_id),
        timestamp: fromMwTimestamp(row.rev_timestamp),
        user: deleted & 4 ? null : name,
        user_id: Number(row.actor_user) || 0,
        anon: !row.actor_user,
        temp: Boolean(row.actor_user) && /^~\d/.test(name ?? ''),
        tags: text(row.tags) ? text(row.tags).split('|') : [],
        size: row.rev_len === null ? null : Number(row.rev_len),
        minor: Boolean(Number(row.rev_minor_edit)),
        comment: deleted & 2 ? null : (text(row.comment_text) ?? ''),
        // revision.rev_sha1 is gone from the replicas (MediaWiki dropped the
        // column). Without it, identical texts after a revert are fetched
        // twice rather than once; results are unaffected.
        sha1: null,
        text_hidden: Boolean(deleted & 1),
        is_bot: Boolean(Number(row.is_bot)),
    };
}

function chunks(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/** Map page_id → revisions in [from, until), oldest first. */
export async function listRevisionsReplicas(query, pageIds, window) {
    const byPage = new Map(pageIds.map(id => [id, []]));
    for (const chunk of chunks(pageIds, 200)) {
        const { sql, params } = buildRevisionsQuery(chunk, window);
        for (const row of await query(sql, params)) byPage.get(Number(row.rev_page))?.push(rowToMeta(row));
    }
    return byPage;
}

/** Map page_id → baseline rev_id (last revision at or before `at`). */
export async function baselineIdsReplicas(query, pageIds, at) {
    const out = new Map();
    for (const chunk of chunks(pageIds, 200)) {
        const { sql, params } = buildBaselineQuery(chunk, at);
        for (const row of await query(sql, params)) out.set(Number(row.rev_page), Number(row.rev_id));
    }
    return out;
}
