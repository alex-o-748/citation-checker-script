#!/usr/bin/env node
/**
 * Benchmark Runner Script
 *
 * Runs the enriched dataset through multiple LLM providers and records results.
 *
 * Usage: node run_benchmark.js [--providers claude,openai,gemini] [--limit N] [--resume]
 *
 * Environment variables for API keys:
 *   ANTHROPIC_API_KEY - Claude API key
 *   OPENAI_API_KEY - OpenAI API key
 *   GEMINI_API_KEY - Google Gemini API key
 *
 * Output:
 *   - results.json: Complete benchmark results
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const DATASET_PATH = path.join(__dirname, 'dataset.json');
const RESULTS_PATH = path.join(__dirname, 'results.json');

// Provider configurations
const PROVIDERS = {
    // Open-source models via PublicAI (direct API)
    'apertus-70b': {
        name: 'Apertus 70B',
        model: 'swiss-ai/apertus-70b-instruct',
        endpoint: 'https://api.publicai.co/v1/chat/completions',
        requiresKey: true,
        keyEnv: 'PUBLICAI_API_KEY',
        type: 'publicai'
    },
    'qwen-sealion': {
        name: 'Qwen SEA-LION v4',
        model: 'aisingapore/Qwen-SEA-LION-v4-32B-IT',
        endpoint: 'https://api.publicai.co/v1/chat/completions',
        requiresKey: true,
        keyEnv: 'PUBLICAI_API_KEY',
        type: 'publicai'
    },
    'olmo-32b': {
        name: 'OLMo 3.1 32B',
        model: 'allenai/Olmo-3.1-32B-Instruct',
        endpoint: 'https://api.publicai.co/v1/chat/completions',
        requiresKey: true,
        keyEnv: 'PUBLICAI_API_KEY',
        type: 'publicai'
    }
};

// Parse command line arguments
const args = process.argv.slice(2);
const providerArg = args.find(a => a.startsWith('--providers='));
const selectedProviders = providerArg
    ? providerArg.split('=')[1].split(',')
    : Object.keys(PROVIDERS);
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : null;
const RESUME = args.includes('--resume');

/**
 * Generate the system prompt (same as main.js)
 */
function generateSystemPrompt() {
    return `You are an assistant helping to verify whether claims from Wikipedia are supported by their cited sources.

Your task is to analyze whether the provided source text supports the claim from the Wikipedia article.

IMPORTANT GUIDELINES:
1. ONLY use the information provided in the source text to make your determination
2. Do NOT use any external knowledge about the topic
3. Consider a claim "supported" if the source contains information that directly or reasonably confirms the claim
4. Accept paraphrasing - the exact words don't need to match, but the meaning should
5. Be careful to distinguish between facts stated as certain vs. speculation or disputed claims
6. If the source text appears to be an error page, paywall, login page, or doesn't contain actual article content, mark as "SOURCE UNAVAILABLE"

ABOUT SOURCES:
Usable source content includes:
- Actual article text from websites, news outlets, or blogs
- Press releases or official statements
- Archive.org snapshots of articles
- Book or document content

Unusable sources (mark as SOURCE UNAVAILABLE):
- Library catalog entries (e.g., WorldCat, Google Books previews showing only metadata)
- Paywall or login-required pages
- Database search results without actual content
- Cookie consent or error pages
- 404 or "page not found" messages
- Just bibliographic information without the actual source content

Provide your response in valid JSON format with these fields:
{
  "confidence": <number from 0-100>,
  "verdict": "<SUPPORTED|PARTIALLY SUPPORTED|NOT SUPPORTED|SOURCE UNAVAILABLE>",
  "comments": "<brief quote from source if supported, or explanation if not>"
}

Confidence scoring guidelines:
- 80-100: Claim is clearly and directly supported by source
- 50-79: Claim is partially supported (some aspects confirmed, others not)
- 1-49: Claim is not supported by the source content
- 0: Source is unavailable or unusable

EXAMPLES:

Example 1:
Claim: "The company was founded in 1985"
Source: "Acme Corp, established in 1985, has grown to become..."
Result: {"confidence": 95, "verdict": "SUPPORTED", "comments": "Source states 'established in 1985'"}

Example 2:
Claim: "The population increased by 25% between 2010 and 2020"
Source: "Census data shows the population grew from 100,000 to 120,000 over the decade"
Result: {"confidence": 60, "verdict": "PARTIALLY SUPPORTED", "comments": "Source confirms population growth but shows 20% increase, not 25%"}

Example 3:
Claim: "The building was designed by Frank Lloyd Wright"
Source: "The historic structure was built in 1923 and features art deco elements"
Result: {"confidence": 10, "verdict": "NOT SUPPORTED", "comments": "Source describes the building but does not mention the architect"}

Example 4:
Claim: "The treaty was signed in 1648"
Source: "Access denied. Please log in to view this content."
Result: {"confidence": 0, "verdict": "SOURCE UNAVAILABLE", "comments": "Source requires login and does not provide content"}`;
}

/**
 * Generate user prompt for a claim/source pair
 */
function generateUserPrompt(claimText, sourceText, sourceUrl) {
    let sourceContent = sourceText;
    if (sourceUrl) {
        sourceContent = `Source URL: ${sourceUrl}\n\nSource Content:\n${sourceText}`;
    }

    return `Please analyze whether this source supports the following claim.

CLAIM FROM WIKIPEDIA:
${claimText}

SOURCE:
${sourceContent}

Provide your analysis in JSON format.`;
}

/**
 * Make API call to provider
 */
async function callProvider(provider, systemPrompt, userPrompt) {
    const config = PROVIDERS[provider];
    const startTime = Date.now();

    try {
        let result;

        // Route based on provider type
        switch (config.type) {
            case 'publicai':
                result = await callPublicAI(config, systemPrompt, userPrompt);
                break;
            case 'claude':
                result = await callClaude(config, systemPrompt, userPrompt);
                break;
            case 'openai':
                result = await callOpenAI(config, systemPrompt, userPrompt);
                break;
            case 'gemini':
                result = await callGemini(config, systemPrompt, userPrompt);
                break;
            default:
                throw new Error(`Unknown provider type: ${config.type}`);
        }

        const latency = Date.now() - startTime;
        return { ...result, latency, error: null };

    } catch (error) {
        const latency = Date.now() - startTime;
        return {
            verdict: 'ERROR',
            confidence: 0,
            comments: error.message,
            latency,
            error: error.message
        };
    }
}

/**
 * Call PublicAI API
 */
async function callPublicAI(config, systemPrompt, userPrompt) {
    const apiKey = process.env[config.keyEnv];
    if (!apiKey) throw new Error(`Missing ${config.keyEnv}`);

    const response = await httpPost(config.endpoint, {
        model: config.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000
    }, {
        'Authorization': `Bearer ${apiKey}`
    });

    const content = response.choices?.[0]?.message?.content || '';
    return parseResponse(content);
}

/**
 * Call Claude API
 */
async function callClaude(config, systemPrompt, userPrompt) {
    const apiKey = process.env[config.keyEnv];
    if (!apiKey) throw new Error(`Missing ${config.keyEnv}`);

    const response = await httpPost(config.endpoint, {
        model: config.model,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    }, {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
    });

    const content = response.content?.[0]?.text || '';
    return parseResponse(content);
}

/**
 * Call OpenAI API
 */
async function callOpenAI(config, systemPrompt, userPrompt) {
    const apiKey = process.env[config.keyEnv];
    if (!apiKey) throw new Error(`Missing ${config.keyEnv}`);

    const response = await httpPost(config.endpoint, {
        model: config.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000
    }, {
        'Authorization': `Bearer ${apiKey}`
    });

    const content = response.choices?.[0]?.message?.content || '';
    return parseResponse(content);
}

/**
 * Call Gemini API
 */
async function callGemini(config, systemPrompt, userPrompt) {
    const apiKey = process.env[config.keyEnv];
    if (!apiKey) throw new Error(`Missing ${config.keyEnv}`);

    const url = `${config.endpoint}?key=${apiKey}`;

    const response = await httpPost(url, {
        contents: [{
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
        }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000
        }
    });

    const content = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseResponse(content);
}

/**
 * Parse LLM response to extract verdict
 */
function parseResponse(content) {
    // Try to extract JSON from response
    let jsonStr = content;

    // Handle markdown code blocks
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1];
    }

    // Try to find JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
        jsonStr = objMatch[0];
    }

    try {
        const parsed = JSON.parse(jsonStr);
        return {
            verdict: normalizeVerdict(parsed.verdict || ''),
            confidence: parsed.confidence || 0,
            comments: parsed.comments || '',
            raw_response: content
        };
    } catch (e) {
        // Fallback: try to extract verdict from text
        const verdictMatch = content.match(/verdict["\s:]+([A-Z_ ]+)/i);
        return {
            verdict: verdictMatch ? normalizeVerdict(verdictMatch[1]) : 'PARSE_ERROR',
            confidence: 0,
            comments: 'Failed to parse JSON response',
            raw_response: content
        };
    }
}

/**
 * Normalize verdict string
 */
function normalizeVerdict(verdict) {
    const v = verdict.toUpperCase().trim();
    if (v.includes('NOT SUPPORTED') || v.includes('NOT_SUPPORTED')) return 'Not supported';
    if (v.includes('PARTIALLY')) return 'Partially supported';
    if (v.includes('UNAVAILABLE')) return 'Source unavailable';
    if (v.includes('SUPPORTED')) return 'Supported';
    return verdict;
}

/**
 * HTTP POST helper
 */
function httpPost(url, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...extraHeaders
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(JSON.stringify(body));
        req.end();
    });
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main benchmark function
 */
async function main() {
    console.log('=== Benchmark Runner ===\n');

    // Check dataset exists
    if (!fs.existsSync(DATASET_PATH)) {
        console.error(`Dataset not found: ${DATASET_PATH}`);
        console.error('Run extract_dataset.js first to create the dataset.');
        process.exit(1);
    }

    // Load dataset
    const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
    console.log(`Loaded ${dataset.length} entries from dataset`);

    // Filter to complete entries only
    let entries = dataset.filter(e => e.extraction_status === 'complete' && !e.needs_manual_review);
    console.log(`${entries.length} entries are complete and ready for benchmarking`);

    if (entries.length === 0) {
        console.error('\nNo complete entries found. Please review and complete the dataset first.');
        process.exit(1);
    }

    if (LIMIT) {
        entries = entries.slice(0, LIMIT);
        console.log(`Limited to ${LIMIT} entries`);
    }

    // Check available providers
    const availableProviders = selectedProviders.filter(p => {
        const config = PROVIDERS[p];
        if (!config) {
            console.log(`Unknown provider: ${p}`);
            return false;
        }
        if (config.requiresKey && !process.env[config.keyEnv]) {
            console.log(`Skipping ${p}: missing ${config.keyEnv}`);
            return false;
        }
        return true;
    });

    if (availableProviders.length === 0) {
        console.error('\nNo providers available. Set API keys as environment variables.');
        process.exit(1);
    }

    console.log(`\nProviders to benchmark: ${availableProviders.join(', ')}`);

    // Load existing results if resuming
    let results = [];
    const completedIds = new Set();

    if (RESUME && fs.existsSync(RESULTS_PATH)) {
        results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
        results.forEach(r => completedIds.add(`${r.entry_id}|${r.provider}`));
        console.log(`Resuming: ${completedIds.size} results already completed`);
    }

    // Generate prompts
    const systemPrompt = generateSystemPrompt();

    // Run benchmarks
    const totalTasks = entries.length * availableProviders.length;
    let completed = completedIds.size;

    console.log(`\nRunning ${totalTasks} benchmark tasks...\n`);

    for (const entry of entries) {
        for (const provider of availableProviders) {
            const taskId = `${entry.id}|${provider}`;

            if (completedIds.has(taskId)) {
                continue;
            }

            console.log(`[${++completed}/${totalTasks}] ${entry.id} / ${provider}`);

            const userPrompt = generateUserPrompt(
                entry.claim_text,
                entry.source_text,
                entry.source_url
            );

            const result = await callProvider(provider, systemPrompt, userPrompt);

            results.push({
                entry_id: entry.id,
                provider: provider,
                model: PROVIDERS[provider].model,
                ground_truth: entry.ground_truth,
                predicted_verdict: result.verdict,
                confidence: result.confidence,
                comments: result.comments,
                latency_ms: result.latency,
                error: result.error,
                correct: compareVerdicts(result.verdict, entry.ground_truth),
                timestamp: new Date().toISOString()
            });

            // Save after each result (for resume capability)
            fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

            // Rate limiting between calls
            await sleep(1000);
        }
    }

    console.log(`\nBenchmark complete. Results saved to: ${RESULTS_PATH}`);

    // Print quick summary
    printSummary(results, availableProviders);
}

/**
 * Compare predicted verdict with ground truth
 */
function compareVerdicts(predicted, groundTruth) {
    const p = predicted.toLowerCase();
    const g = groundTruth.toLowerCase();

    // Exact match
    if (p === g) return 'exact';

    // Normalize for comparison
    const normalize = v => {
        if (v.includes('not supported')) return 'not_supported';
        if (v.includes('partially')) return 'partial';
        if (v.includes('supported')) return 'supported';
        if (v.includes('unavailable')) return 'unavailable';
        return v;
    };

    if (normalize(p) === normalize(g)) return 'exact';

    // Partial match (e.g., predicted "partial" for "supported" is closer than "not supported")
    const pn = normalize(p);
    const gn = normalize(g);

    if ((pn === 'partial' && gn === 'supported') || (pn === 'supported' && gn === 'partial')) {
        return 'partial';
    }

    return 'wrong';
}

/**
 * Print summary statistics
 */
function printSummary(results, providers) {
    console.log('\n=== Summary ===\n');

    for (const provider of providers) {
        const providerResults = results.filter(r => r.provider === provider);
        if (providerResults.length === 0) continue;

        const exact = providerResults.filter(r => r.correct === 'exact').length;
        const partial = providerResults.filter(r => r.correct === 'partial').length;
        const wrong = providerResults.filter(r => r.correct === 'wrong').length;
        const errors = providerResults.filter(r => r.error).length;
        const avgLatency = providerResults.reduce((sum, r) => sum + r.latency_ms, 0) / providerResults.length;

        console.log(`${PROVIDERS[provider].name} (${PROVIDERS[provider].model}):`);
        console.log(`  Exact match: ${exact}/${providerResults.length} (${(exact/providerResults.length*100).toFixed(1)}%)`);
        console.log(`  Partial match: ${partial}/${providerResults.length}`);
        console.log(`  Wrong: ${wrong}/${providerResults.length}`);
        console.log(`  Errors: ${errors}/${providerResults.length}`);
        console.log(`  Avg latency: ${avgLatency.toFixed(0)}ms`);
        console.log('');
    }
}

// Run
main().catch(console.error);
