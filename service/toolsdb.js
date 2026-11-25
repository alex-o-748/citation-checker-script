// Connecting to ToolsDB from a Toolforge tool account — the writable
// counterpart to service/replicas.js's read-only Wiki Replicas connection.
//
// Same credentials file, different host and a different database-naming
// convention: see docs/design-plans/2026-08-17-toolsdb-findings-store.md's
// "The database: ToolsDB, not Wiki Replicas" table. Reuses
// parseReplicaConfig()/DEFAULT_CNF_PATH from service/replicas.js rather than
// re-parsing ~/replica.my.cnf, per that doc's explicit instruction — the
// `user` value it returns doubles as ToolsDB's <credentialUser>.

import { readFile as fsReadFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { DEFAULT_CNF_PATH, parseReplicaConfig } from './replicas.js';

export const TOOLSDB_HOST = 'tools.db.svc.wikimedia.cloud';

export function toolsDbDatabase(credentialUser, dbName = 'source_verifier') {
    if (!credentialUser) throw new TypeError('toolsDbDatabase requires a credentialUser, e.g. "s57953"');
    return `${credentialUser}__${dbName}`;
}

/**
 * Opens a connection to this tool's ToolsDB database.
 *
 * `readFile` and `createConnection` are injectable, matching
 * openReplicaConnection()'s seam — not used by any test here since there's
 * nothing to assert against without a live server (ToolsDB is unreachable
 * from outside Wikimedia Cloud infrastructure).
 */
export async function openToolsDbConnection({
    dbName = 'source_verifier',
    cnfPath = DEFAULT_CNF_PATH,
    readFile = fsReadFile,
    createConnection = mysql.createConnection,
    connectTimeout = 30000,
} = {}) {
    const cnfText = await readFile(cnfPath, 'utf8');
    const { user, password } = parseReplicaConfig(cnfText);

    return createConnection({
        host: TOOLSDB_HOST,
        port: 3306,
        user,
        password,
        database: toolsDbDatabase(user, dbName),
        connectTimeout,
    });
}

// A dropped connection, as mysql2 reports it: errors that end the connection
// carry `fatal: true`; a command sent on one already closed throws a plain
// Error ("Can't add new command when connection is in closed state").
const CONNECTION_LOST_CODES = new Set([
    'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ER_SERVER_SHUTDOWN',
]);
export function isConnectionLost(error) {
    if (!error) return false;
    if (error.fatal === true || CONNECTION_LOST_CODES.has(error.code)) return true;
    return /closed state|connection lost|server has gone away/i.test(error.message ?? '');
}

/**
 * A query function over a connection that is reopened when it drops.
 *
 * One connection held for a day-long sweep or an hour-long import does not
 * survive: the November 2026 ruwiki rerun stored 183 findings and then failed
 * the next 8,679, every one on the same dead connection. On a lost connection
 * this reconnects and retries the statement once. That is safe for the only
 * statement it runs, buildUpsertQuery()'s idempotent upsert. Any other error
 * (a column too narrow, a missing migration) is the caller's, unretried.
 *
 * Returns { query(sql, params) -> rows, end(), reconnects }.
 */
export async function openReconnectingQuery(connect, { onReconnect } = {}) {
    let connection = await connect();
    let reconnects = 0;
    const run = async (sql, params) => {
        const [rows] = await connection.execute(sql, params);
        return rows;
    };
    return {
        async query(sql, params) {
            try {
                return await run(sql, params);
            } catch (error) {
                if (!isConnectionLost(error)) throw error;
                try { await connection.end(); } catch { /* already gone */ }
                connection = await connect();
                reconnects++;
                onReconnect?.(error, reconnects);
                return run(sql, params);
            }
        },
        async end() {
            try { await connection.end(); } catch { /* already gone */ }
        },
        get reconnects() { return reconnects; },
    };
}
