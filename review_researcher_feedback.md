# Review of Researcher Feedback

## 1. Data Collection / Privacy

The Google Form approach is pragmatic: no server infrastructure to maintain, built-in data storage in Google Sheets, easy to share/collaborate.

**Key concern: Google Forms text field limits.** Short answer fields cap at ~500 characters, paragraph fields at ~4,096 characters. The `source_text` field in dataset entries can be up to 50,000 characters (`extract_dataset.js:169`), so that field would need to be heavily truncated or replaced with a hash/URL reference in form submissions.

The idea of a second copy of the script for data collection is a low-risk way to iterate. A feature flag in the existing script could avoid divergence over time, but a copy is fine for initial experimentation.

Regarding default collection with a disclaimer: this seems reasonable as long as only verification results are logged (verdict, confidence, article URL, citation number) and no PII-adjacent data (user names, session identifiers, IP addresses) is captured or inferable.

## 2. Claim Extraction (Between Citations vs Full Sentences)

The researcher raises an important trade-off. The current approach (`main.js:914-993`) extracts text between the current citation and the previous citation (or start of container). This is more precise but can produce fragments that lack context. The researcher's full-sentence extraction provides more context but may include claims backed by other citations.

The `claim_container` field is already stored in `dataset.json` but is **not** passed to the LLM during verification -- only `claim` and `sourceText` go into the prompt (`main.js:1359-1362`).

**Recommendation:** Test a three-way input approach (claim text, surrounding context, source) by modifying `generateUserPrompt()`:

```
Claim: "{claim}"

Context (surrounding paragraph): "{container}"

Source text:
{sourceText}
```

This would let the LLM disambiguate pronouns and understand the broader topic without conflating claims from different citations. It's a low-effort experiment since `claim_container` is already captured in the benchmark dataset.

## 3. Plaintext Extraction

Current extraction (`extract_dataset.js:154-169`) uses basic regex matching for `<article>`, `<main>`, or `<body>` tags, then strips scripts/styles/tags with a 50,000 character limit.

The researcher's trafilatura approach produces cleaner text but 7/66 sources were blocked (403s and a 202). This could be due to:
- The proxy (`publicai-proxy.alaexis.workers.dev`) handling requests differently than trafilatura's default user-agent/headers
- Parsing vs. fetching differences (trafilatura may fail at the HTTP level rather than content extraction)

The 30% median length difference is notable. For larger LLMs with long context windows, extra boilerplate probably doesn't hurt accuracy. For smaller models like MiniCheck with smaller context windows, cleaner extraction could matter more since they have less ability to filter noise.

## 4. Partial Support

The "text contained several claims and the source supported only some of them" issue ties back to claim extraction. The between-citation extraction (`main.js:936-961`) tries to isolate specific claims, but Wikipedia paragraphs often contain compound statements before a single citation.

The current system prompt (`main.js:1256-1336`) handles this with the PARTIALLY SUPPORTED verdict. Consider adding explicit guidance like: "If the text contains multiple distinct claims and only some are supported, identify which specific claims are and aren't supported in your comments."

As the dataset grows, tracking how often partial support is due to compound claims (extraction issue) vs. genuinely hedged/incomplete source coverage (verification issue) would help decide whether to invest in more granular claim extraction.

## 5. MiniCheck Models

Running MiniCheck on the existing dataset is a good complement -- it's purpose-built for NLI-based fact verification and provides a baseline comparison against the LLM-based approach.

Worth noting: MiniCheck likely won't handle SOURCE UNAVAILABLE cases well since it doesn't have the prompt-engineered detection for unusable sources (paywalls, metadata pages, etc.) that the current system prompt includes (`main.js:1266-1281`). Those entries should probably be filtered out or handled separately when comparing results.

## Summary of Actionable Items

1. **Google Form field limits**: Verify character limits; consider logging only metadata (URL, citation number, verdict, confidence) rather than full source text
2. **Three-way context experiment**: Test passing `claim_container` as additional context to the LLM alongside claim and source text
3. **Partial support guidance**: Add more explicit instructions in the system prompt for handling compound claims
4. **trafilatura comparison**: Investigate whether the 7 blocked sources are due to HTTP-level differences or content parsing differences
5. **MiniCheck evaluation**: Filter SOURCE UNAVAILABLE entries when comparing MiniCheck results against LLM results
