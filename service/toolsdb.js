// Connecting to ToolsDB from a Toolforge tool account — the tool's own
// writable MariaDB database, as distinct from Wiki Replicas
// (service/replicas.js), which is read-only and belongs to a different host
// family. See docs/design-plans/2026-08-17-toolsdb-findings-store.md for the
// two systems' differences.
//
// Same split as service/replicas.js: pure, offline-testable naming logic in
// one function, a thin I/O wrapper around it that isn't meaningfully testable
// here (ToolsDB is unreachable from outside Wikimedia Cloud infrastructure).
// Deliberately reuses replicas.js's parseReplicaConfig() rather than
// re-parsing ~/replica.my.cnf — same credentials file, same [client] section.

import { readFile as fsReadFile } from 'node:fs/promises';
import { DEFAULT_CNF_PATH, parseReplicaConfig } from './replicas.js';

export const TOOLSDB_HOST = 'tools.db.svc.wikimedia.cloud';
export const TOOLSDB_PORT = 3306;

// ToolsDB database names are "<credentialUser>__<name>" — the credential user
// IS the value parseReplicaConfig() already returns as `user`, so this must
// never be a hardcoded string (that breaks under any tool account other than
// the one it was hardcoded for; see the parent design doc §5 on running the
// browser-facing proxy and the batch sweep under two separate tool accounts).
//
// Toolforge credential users are always "s" or "u" followed by digits
// (a ToolAccount/User numeric id) — validated so a missing or mistyped `user`
// fails here with a clear message, rather than producing
// "undefined__source_verifier" and failing later as a confusing
// access-denied from MariaDB.
const CREDENTIAL_USER_RE = /^[su]\d+$/;

export function toolsDatabase(credentialUser, name = 'source_verifier') {
    if (!credentialUser || !CREDENTIAL_USER_RE.test(credentialUser)) {
        throw new TypeError(
            `toolsDatabase requires a Toolforge credential user like "s51234" or "u12345" (got: ${JSON.stringify(credentialUser)})`
        );
    }
    if (!name) throw new TypeError('toolsDatabase requires a database name');
    return `${credentialUser}__${name}`;
}

/**
 * Opens a connection to this tool's ToolsDB database.
 *
 * `readFile` and `createConnection` are injectable so a caller can point this
 * at a fixture during development without a real Toolforge session — matches
 * the seam in service/replicas.js's openReplicaConnection().
 *
 * The mysql2 driver is imported lazily (inside this function, only when
 * `createConnection` isn't supplied — not at module top level) so that
 * everything else in this module, and every module that imports from it,
 * stays importable and testable in an environment where the driver isn't
 * installed. service/replicas.js has the same fix for the same reason: a
 * top-level `import mysql2` used to make tests/replicas.test.js fail outright
 * (before reaching a single assertion) wherever mysql2 isn't present.
 */
export async function openToolsDbConnection({
    name = 'source_verifier',
    cnfPath = DEFAULT_CNF_PATH,
    readFile = fsReadFile,
    createConnection,
    connectTimeout = 30000,
} = {}) {
    const cnfText = await readFile(cnfPath, 'utf8');
    const { user, password } = parseReplicaConfig(cnfText);

    const connect = createConnection ?? (await import('mysql2/promise')).createConnection;

    return connect({
        host: TOOLSDB_HOST,
        port: TOOLSDB_PORT,
        user,
        password,
        database: toolsDatabase(user, name),
        connectTimeout,
    });
}

// Adapts a mysql2 connection to the (sql, params) => rows shape
// service/findings.js's upsertFinding() expects — identical contract to
// service/replicas.js's makeQueryFn(), duplicated rather than imported
// because the two connections (Replicas, ToolsDB) are never open at the same
// time in the same caller and importing across for one three-line function
// isn't worth the coupling.
export function makeQueryFn(connection) {
    return async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        return result;
    };
}
