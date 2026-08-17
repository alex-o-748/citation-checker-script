// Connecting to Wiki Replicas from a Toolforge tool account.
//
// Two layers, deliberately split: the config-file parsing and hostname/database
// naming are pure functions, tested without a database. Opening the actual
// connection is a thin I/O wrapper around them — it cannot be meaningfully
// tested here (Wiki Replicas are unreachable from outside Wikimedia Cloud
// infrastructure), so it stays small and every external call is injectable,
// matching the pattern in core/wikipedia.js.

import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

export const DEFAULT_CNF_PATH = join(homedir(), 'replica.my.cnf');

// Wiki Replicas expose two host families: `.web.` (tight connection/time
// limits, meant for quick request-driven queries) and `.analytics.` (meant for
// longer-running, bulk work — exactly this job's shape). Confirmed manually
// against enwiki.analytics.db.svc.wikimedia.cloud before this module was
// written; do not swap to `.web.` without re-checking the timeout budget.
const CLUSTER_SUFFIX = Object.freeze({
    analytics: 'analytics.db.svc.wikimedia.cloud',
    web: 'web.db.svc.wikimedia.cloud',
});

export function wikiHost(wikiDb, { cluster = 'analytics' } = {}) {
    const suffix = CLUSTER_SUFFIX[cluster];
    if (!suffix) throw new RangeError(`unknown replica cluster: ${cluster} (known: ${Object.keys(CLUSTER_SUFFIX).join(', ')})`);
    if (!wikiDb) throw new TypeError('wikiHost requires a wiki database name, e.g. "enwiki"');
    return `${wikiDb}.${suffix}`;
}

export function wikiDatabase(wikiDb) {
    if (!wikiDb) throw new TypeError('wikiDatabase requires a wiki database name, e.g. "enwiki"');
    return `${wikiDb}_p`;
}

// Parses the INI-shaped config Toolforge drops into every tool account's home
// directory: a [client] section with `user` and `password`, values optionally
// single- or double-quoted. Comments start with # or ; on their own line.
export function parseReplicaConfig(text) {
    const config = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) continue;

        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
            value = value.slice(1, -1);
        }
        config[key] = value;
    }

    if (!config.user || !config.password) {
        throw new Error(
            `replica config is missing "user" and/or "password" (found keys: ${Object.keys(config).join(', ') || 'none'})`
        );
    }

    return { user: config.user, password: config.password };
}

/**
 * Opens a connection to one wiki's replica database.
 *
 * `readFile` and `createConnection` are injectable so a caller can point this
 * at a fixture during development without a real Toolforge session — they are
 * not used by any test in this repo, since there's nothing to assert against
 * without a live server, but the seam matches core/wikipedia.js's fetchImpl
 * pattern rather than hardcoding mysql2 as unavoidable.
 */
export async function openReplicaConnection({
    wikiDb = 'enwiki',
    cluster = 'analytics',
    cnfPath = DEFAULT_CNF_PATH,
    readFile = fsReadFile,
    createConnection = mysql.createConnection,
    connectTimeout = 30000,
} = {}) {
    const cnfText = await readFile(cnfPath, 'utf8');
    const { user, password } = parseReplicaConfig(cnfText);

    return createConnection({
        host: wikiHost(wikiDb, { cluster }),
        port: 3306,
        user,
        password,
        database: wikiDatabase(wikiDb),
        connectTimeout,
        // page_title and similar columns are VARBINARY in the MediaWiki
        // schema — mysql2 returns those as Buffer by default, which
        // service/selection.js's normalizeRow() already expects and decodes.
    });
}

// Adapts a mysql2 connection to the (sql, params) => rows shape
// service/selection.js's selectCandidates() expects.
export function makeQueryFn(connection) {
    return async (sql, params) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
    };
}
