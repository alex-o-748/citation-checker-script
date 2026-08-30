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
