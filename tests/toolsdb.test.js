import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolsDbDatabase, TOOLSDB_HOST, openToolsDbConnection } from '../service/toolsdb.js';

test('toolsDbDatabase builds the <credentialUser>__<name> convention', () => {
    assert.equal(toolsDbDatabase('s57953'), 's57953__source_verifier');
    assert.equal(toolsDbDatabase('s57953', 'other_db'), 's57953__other_db');
});

test('toolsDbDatabase requires a credential user', () => {
    assert.throws(() => toolsDbDatabase(), TypeError);
    assert.throws(() => toolsDbDatabase(''), TypeError);
});

test('TOOLSDB_HOST is the shared ToolsDB host, distinct from any wiki replica host', () => {
    assert.equal(TOOLSDB_HOST, 'tools.db.svc.wikimedia.cloud');
});

test('openToolsDbConnection derives the database name from the parsed credential user', async () => {
    const seen = [];
    await openToolsDbConnection({
        readFile: async () => "[client]\nuser = s57953\npassword = 'secret'\n",
        createConnection: async (config) => { seen.push(config); return { config }; },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, TOOLSDB_HOST);
    assert.equal(seen[0].user, 's57953');
    assert.equal(seen[0].password, 'secret');
    assert.equal(seen[0].database, 's57953__source_verifier');
});
