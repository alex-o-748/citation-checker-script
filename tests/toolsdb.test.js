import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolsDatabase, TOOLSDB_HOST, TOOLSDB_PORT, openToolsDbConnection, makeQueryFn } from '../service/toolsdb.js';

test('toolsDatabase derives "<credentialUser>__<name>"', () => {
    assert.equal(toolsDatabase('s57953'), 's57953__source_verifier');
    assert.equal(toolsDatabase('s57953', 'other_db'), 's57953__other_db');
    assert.equal(toolsDatabase('u12345'), 'u12345__source_verifier');
});

test('toolsDatabase rejects a missing or malformed credential user rather than silently producing garbage', () => {
    // The real failure mode this guards: "undefined__source_verifier" reaching
    // MariaDB and failing later as a confusing access-denied.
    assert.throws(() => toolsDatabase(undefined), TypeError);
    assert.throws(() => toolsDatabase(''), TypeError);
    assert.throws(() => toolsDatabase(null), TypeError);
    assert.throws(() => toolsDatabase('source_verifier'), TypeError); // not a credential user shape
    assert.throws(() => toolsDatabase('s'), TypeError); // no digits
});

test('toolsDatabase rejects a missing database name', () => {
    assert.throws(() => toolsDatabase('s57953', ''), TypeError);
    assert.throws(() => toolsDatabase('s57953', null), TypeError);
});

test('TOOLSDB_HOST and TOOLSDB_PORT are the documented ToolsDB endpoint, distinct from Wiki Replicas', () => {
    assert.equal(TOOLSDB_HOST, 'tools.db.svc.wikimedia.cloud');
    assert.equal(TOOLSDB_PORT, 3306);
    assert.notEqual(TOOLSDB_HOST, 'enwiki.analytics.db.svc.wikimedia.cloud');
});

test('openToolsDbConnection derives the database name from the parsed credential user, not a hardcoded string', async () => {
    let capturedConfig;
    const fakeConnection = { fake: true };
    const connection = await openToolsDbConnection({
        readFile: async () => "[client]\nuser = s57953\npassword = 'secret'\n",
        createConnection: async (config) => {
            capturedConfig = config;
            return fakeConnection;
        },
    });

    assert.equal(connection, fakeConnection);
    assert.equal(capturedConfig.host, TOOLSDB_HOST);
    assert.equal(capturedConfig.port, TOOLSDB_PORT);
    assert.equal(capturedConfig.user, 's57953');
    assert.equal(capturedConfig.password, 'secret');
    assert.equal(capturedConfig.database, 's57953__source_verifier');
});

test('openToolsDbConnection respects a custom database name', async () => {
    let capturedConfig;
    await openToolsDbConnection({
        name: 'other_db',
        readFile: async () => '[client]\nuser = s12345\npassword = pw\n',
        createConnection: async (config) => {
            capturedConfig = config;
            return {};
        },
    });
    assert.equal(capturedConfig.database, 's12345__other_db');
});

test('openToolsDbConnection surfaces a missing/malformed config file as an error rather than connecting with undefined credentials', async () => {
    await assert.rejects(
        openToolsDbConnection({
            readFile: async () => '[client]\n# no user or password here\n',
            createConnection: async () => ({}),
        })
    );
});

test('makeQueryFn adapts a mysql2-shaped connection.execute() into (sql, params) => result', async () => {
    const calls = [];
    const fakeConnection = {
        execute: async (sql, params) => {
            calls.push({ sql, params });
            return [{ affectedRows: 1, insertId: 42 }, []];
        },
    };

    const query = makeQueryFn(fakeConnection);
    const result = await query('INSERT INTO x VALUES (?)', [1]);

    assert.deepEqual(result, { affectedRows: 1, insertId: 42 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { sql: 'INSERT INTO x VALUES (?)', params: [1] });
});
