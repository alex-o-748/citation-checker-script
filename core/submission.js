// Dataset-submission helpers. Pure logic for building a prefilled Google Form
// URL so Wikipedia editors can contribute citation/ground-truth examples
// without an API or auth. Inlined into main.js between <core-injected>
// markers, and importable from tests.
//
// To activate the feature once a Form exists:
//   1. Create a Google Form whose questions correspond to the keys in
//      DATASET_SUBMISSION_ENTRY_IDS (articleUrl, citationNumber, claimText,
//      sourceUrl, llmVerdict, llmRationale, llmProvider, llmModel,
//      editorHandle, notes).
//   2. Use the Form's "Get pre-filled link" tool, fill every field with a
//      unique sentinel, and copy the resulting URL.
//   3. Replace DATASET_SUBMISSION_FORM_URL with the /viewform URL, and
//      replace each `entry.PLACEHOLDER_*` value with the matching
//      `entry.<numeric-id>` from the pre-filled link.
//   4. Run `npm run build` so the constants are re-inlined into main.js.

// Sentinel substring that marks scaffolded values as not-yet-configured.
// isDatasetSubmissionConfigured() looks for this exact token; don't reuse it
// anywhere else in this file.
export const DATASET_SUBMISSION_PLACEHOLDER = 'PLACEHOLDER';

export const DATASET_SUBMISSION_FORM_URL =
    'https://docs.google.com/forms/d/e/1FAIpQLSdn0mnTHLV7NQZSmEbQXgLRzkJEfd6tcvVffLdInGpVyySkBA/viewform';

export const DATASET_SUBMISSION_ENTRY_IDS = {
    articleUrl:     'entry.1530874375',
    citationNumber: 'entry.1417860793',
    claimText:      'entry.1673425995',
    sourceUrl:      'entry.1675972910',
    llmVerdict:     'entry.270831712',
    llmRationale:   'entry.805615048',
    llmProvider:    'entry.230272168',
    llmModel:       'entry.166995',
    // Populated only for SOURCE UNAVAILABLE rows where the proxy reported an
    // HTTP status — lets the dataset distinguish "we never fetched" from
    // "we fetched and the source returned 4xx/5xx".
    fetchStatus:    'entry.375255643',
    editorHandle:   'entry.362287943',
    notes:          'entry.133790832',
};

export function isDatasetSubmissionConfigured(
    formUrl = DATASET_SUBMISSION_FORM_URL,
    entryIds = DATASET_SUBMISSION_ENTRY_IDS,
) {
    if (!formUrl || formUrl.includes(DATASET_SUBMISSION_PLACEHOLDER)) return false;
    return Object.values(entryIds).every(
        id => typeof id === 'string' && id && !id.includes(DATASET_SUBMISSION_PLACEHOLDER)
    );
}

export function buildDatasetSubmissionUrl(
    fields,
    formUrl = DATASET_SUBMISSION_FORM_URL,
    entryIds = DATASET_SUBMISSION_ENTRY_IDS,
) {
    const params = new URLSearchParams();
    params.set('usp', 'pp_url');
    for (const key of Object.keys(entryIds)) {
        const value = fields == null ? undefined : fields[key];
        if (value === undefined || value === null || value === '') continue;
        params.set(entryIds[key], String(value));
    }
    return `${formUrl}?${params.toString()}`;
}
