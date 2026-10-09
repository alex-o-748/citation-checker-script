// Reads a findings CSV one record at a time, so memory stays flat however
// large the file is.
//
// service/csv-report.js's parseCsv() builds the whole file as an array of
// arrays, which is fine for a test fixture and not for a 400-article sweep:
// scripts/monitor-csv.js's first version did exactly that and was OOM-killed
// in a Toolforge shell at ~12k rows. Records span physical lines (claim_text,
// rationale and source_quote are prose with embedded newlines), so this tracks
// quoting rather than splitting on '\n' — same RFC4180 rules as parseCsv(): a
// quote only opens a field at its start, and "" inside quotes is one quote.

import { createReadStream } from 'node:fs';

/**
 * A push parser. `write()` takes text in arbitrary chunks (a record may span
 * any number of them); `onRecord(fields)` is called once per complete record.
 * `end()` flushes a final record that has no trailing newline and returns
 * `{ unterminated }` — true when the input ended inside a quoted field, i.e.
 * the last record was cut off mid-write (a SIGKILL during an append).
 */
export function createCsvParser(onRecord) {
    let record = [];
    let field = '';
    let inQuotes = false;
    let pendingQuote = false; // saw a '"' inside quotes; next char decides
    let pendingCr = false;    // saw '\r'; swallow a following '\n'
    let fieldStarted = false;

    const endField = () => { record.push(field); field = ''; fieldStarted = false; };
    const endRecord = () => { endField(); onRecord(record); record = []; };

    function write(text) {
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (pendingCr) {
                pendingCr = false;
                if (char === '\n') continue;
            }
            if (inQuotes) {
                if (pendingQuote) {
                    pendingQuote = false;
                    if (char === '"') { field += '"'; continue; }
                    inQuotes = false; // the quote closed the field; handle char below
                } else if (char === '"') { pendingQuote = true; continue; }
                else { field += char; continue; }
            }
            if (char === '"' && !fieldStarted && field === '') { inQuotes = true; fieldStarted = true; }
            else if (char === ',') endField();
            else if (char === '\n') endRecord();
            else if (char === '\r') { endRecord(); pendingCr = true; }
            else { field += char; fieldStarted = true; }
        }
    }

    function end() {
        // A closing quote that was the very last character closed its field.
        if (pendingQuote) { pendingQuote = false; inQuotes = false; }
        const unterminated = inQuotes;
        if (field !== '' || record.length || fieldStarted) endRecord();
        return { unterminated };
    }

    return { write, end };
}

/**
 * Streams a CSV file, calling `onRow(row, index)` for every data record with
 * `row` keyed by header name and `index` counting data records from 1.
 * Records whose field count differs from the header's go to `onMalformed`
 * instead (they cannot be keyed reliably). Resolves to
 * `{ header, rows, malformed, unterminated, lastIndex }`.
 */
export async function streamCsvRows(path, { onRow, onMalformed = () => {}, createStream = createReadStream } = {}) {
    let header = null;
    let rows = 0;
    let malformed = 0;
    let index = 0;
    const parser = createCsvParser(fields => {
        if (header === null) {
            // A UTF-8 BOM would otherwise become part of the first column name.
            header = fields.map((name, i) => (i === 0 ? name.replace(/^﻿/, '') : name));
            return;
        }
        if (fields.length === 1 && fields[0] === '') return; // blank line
        index++;
        if (fields.length !== header.length) {
            malformed++;
            onMalformed(fields, index);
            return;
        }
        rows++;
        const row = {};
        for (let i = 0; i < header.length; i++) row[header[i]] = fields[i];
        onRow(row, index);
    });

    const stream = createStream(path, { encoding: 'utf8' });
    for await (const chunk of stream) parser.write(chunk);
    const { unterminated } = parser.end();
    return { header: header ?? [], rows, malformed, unterminated, lastIndex: index };
}
