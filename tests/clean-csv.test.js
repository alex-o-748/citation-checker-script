import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, HELP_TEXT } from '../service/clean-csv.js';

test('manual cleaner uses the derived output path', async () => {
    let call;
    let output = '';
    const code = await main(['node', 'clean-csv.js', 'old.csv'], {
        writeCleanCsvFn: async (...args) => { call = args; },
        stdout: { write: text => { output += text; } },
        stderr: { write() {} },
    });
    assert.equal(code, 0);
    assert.deepEqual(call, ['old.csv', 'old-clean.csv']);
    assert.match(output, /old-clean\.csv/);
});

test('manual cleaner accepts --out and reports missing input', async () => {
    let call;
    const io = {
        writeCleanCsvFn: async (...args) => { call = args; },
        stdout: { write() {} }, stderr: { write() {} },
    };
    assert.equal(await main(['node', 'clean-csv.js', 'old.csv', '--out', 'share.csv'], io), 0);
    assert.deepEqual(call, ['old.csv', 'share.csv']);
    assert.equal(await main(['node', 'clean-csv.js'], io), 2);
    assert.match(HELP_TEXT, /input\.csv/);
});
