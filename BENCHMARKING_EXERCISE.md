# Wikipedia Citation Verification Benchmarking Exercise

## Overview

This document describes a benchmarking exercise conducted to evaluate the performance of various Large Language Models (LLMs) on the task of verifying Wikipedia citations. The goal was to assess how well different models can determine whether claims in Wikipedia articles are supported by their cited sources.

## Motivation

Wikipedia's reliability depends on accurate citations. The [Wikipedia AI Source Verification tool](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification) uses AI to help editors verify that citations actually support the claims they're attached to. To understand which models perform best at this task, we conducted a systematic benchmark across multiple LLMs using real Wikipedia citations.

## Methodology

### Dataset Construction

We created a ground truth dataset of 76 claim-citation pairs from Wikipedia articles, specifically focusing on the "Immigration to the United States" article. Each entry contains:

- **Claim text**: The specific statement made in the Wikipedia article
- **Source text**: The content from the cited source
- **Ground truth verdict**: Human-verified classification of whether the source supports the claim

**Dataset**: [`benchmark/dataset.json`](benchmark/dataset.json)

The dataset was created using the following workflow:
1. Extract claim/source pairs from Wikipedia articles using `extract_dataset.js`
2. Manual review of the dataset to ensure accuracy (especially for citations that appear multiple times)
3. Verification that source content was accessible and usable

### Evaluation Criteria

Claims were classified into four categories:

- **Supported**: The source clearly supports the claim with definitive statements
- **Partially supported**: The source provides some support but lacks specificity or uses hedged language
- **Not supported**: The source contradicts the claim or doesn't mention the asserted information
- **Source unavailable**: The source content couldn't be accessed (paywall, 404, etc.)

### Metrics

We measured the following metrics for each model:

- **Exact Accuracy**: Percentage of predictions that exactly match the ground truth
- **Lenient Accuracy**: Exact matches plus cases where "Supported" ↔ "Partially supported"
- **Binary Accuracy**: Correct classification of support vs. no support (ignoring partial distinctions)
- **Confidence Calibration**: Difference between average confidence on correct vs. incorrect predictions (higher is better)
- **Latency**: Average response time in milliseconds

**Full Results**: [`benchmark/results.json`](benchmark/results.json) | **Analysis**: [`benchmark/analysis.json`](benchmark/analysis.json)

### Test Configuration

All models were tested using:
- Temperature: 0.1 (for consistency)
- The same system prompt with detailed instructions and examples
- The same dataset of 76 entries
- API calls via PublicAI's free inference service (for open-source models) and Anthropic API (for Claude)

## Models Tested

We evaluated four models:

1. **Claude Sonnet 4.5** (`claude-sonnet-4-5-20250929`)
   - Anthropic's frontier model
   - Tested via Anthropic API

2. **Qwen-SEA-LION-v4** (`aisingapore/Qwen-SEA-LION-v4-32B-IT`)
   - 32 billion parameter model from AI Singapore
   - Based on Qwen architecture, fine-tuned for Southeast Asian languages/contexts

3. **OLMo-3.1-32B** (`allenai/Olmo-3.1-32B-Instruct`)
   - 32 billion parameter model from Allen Institute for AI
   - Open Language Model designed for transparency and research

4. **Apertus-70B** (`swiss-ai/apertus-70b-instruct`)
   - 70 billion parameter model from Swiss AI Lab
   - Designed for instruction following

## Results

### Summary Statistics

| Model | Exact Accuracy | Lenient Accuracy | Binary Accuracy | Avg Latency (ms) | Confidence Calibration |
|-------|---------------|------------------|-----------------|------------------|----------------------|
| **Claude Sonnet 4.5** | **75.0%** | 86.8% | **92.1%** | 4,093 | **39.04** |
| Qwen-SEA-LION | 73.3% | 86.7% | 86.7% | **3,657** | 30.25 |
| OLMo-32B | 66.7% | 82.7% | 84.0% | 3,002 | 43.20 |
| Apertus-70B | 57.3% | **93.3%** | 94.7% | 4,398 | 8.15 |

### Detailed Results

#### Claude Sonnet 4.5 🏆
- **Valid responses**: 76/76 (0 errors - perfect reliability!)
- **Exact matches**: 57/76 (75.0%)
- **Lenient accuracy**: 86.8%
- **Binary accuracy**: 92.1%
- **Average latency**: 4,093ms
- **Confidence calibration**: 39.04 (86.9% when correct, 47.9% when wrong)

**Confusion Matrix** (rows = ground truth, columns = predicted):
```
                    Supported  Partial  Not Supported  Unavailable
Supported (60)         52        5          1             2
Partial (10)            4        5          0             1
Not Supported (5)       1        1          0             4
Unavailable (0)         -        -          -             -
```

#### Qwen-SEA-LION-v4-32B
- **Valid responses**: 75/76 (1 error)
- **Exact matches**: 55/75 (73.3%)
- **Lenient accuracy**: 86.7%
- **Binary accuracy**: 86.7%
- **Average latency**: 3,657ms (fastest)
- **Confidence calibration**: 30.25 (86% when correct, 55.75% when wrong)

**Confusion Matrix**:
```
                    Supported  Partial  Not Supported  Unavailable
Supported (60)         50        4          4             2
Partial (10)            6        3          0             1
Not Supported (5)       2        1          2             0
Unavailable (0)         -        -          -             -
```

#### OLMo-3.1-32B-Instruct
- **Valid responses**: 75/76 (1 error)
- **Exact matches**: 50/75 (66.7%)
- **Lenient accuracy**: 82.7%
- **Binary accuracy**: 84.0%
- **Average latency**: 3,002ms
- **Confidence calibration**: 43.20 (82.4% when correct, 39.2% when wrong)

**Confusion Matrix**:
```
                    Supported  Partial  Not Supported  Unavailable
Supported (60)         44        7          4             5
Partial (10)            5        3          0             2
Not Supported (5)       1        0          3             1
Unavailable (0)         -        -          -             -
```

#### Apertus-70B-Instruct
- **Valid responses**: 75/76 (1 error)
- **Exact matches**: 43/75 (57.3%)
- **Lenient accuracy**: 93.3%
- **Binary accuracy**: 94.7%
- **Average latency**: 4,398ms (slowest)
- **Confidence calibration**: 8.15 (82.2% when correct, 74.1% when wrong)

**Confusion Matrix**:
```
                    Supported  Partial  Not Supported  Unavailable
Supported (60)         34       24          2             0
Partial (10)            3        7          0             0
Not Supported (5)       0        2          2             1
Unavailable (0)         -        -          -             -
```

### Note on Gemini

Gemini 2.5 Flash was also tested but encountered significant reliability issues with 55 errors out of 76 attempts (72% failure rate), making it unsuitable for this task in its current API configuration.

## Analysis

### Key Findings

1. **Claude Sonnet 4.5 is the clear winner** with 75% exact accuracy and perfect reliability (0 errors). It also has the best confidence calibration, showing much higher confidence when correct (86.9%) vs. incorrect (47.9%).

2. **Qwen-SEA-LION is the best open-source option** at 73.3% exact accuracy, nearly matching Claude's performance. It's also the fastest of the reliable models (3,657ms).

3. **Apertus-70B has the best lenient and binary accuracy** (93.3% and 94.7%), meaning it rarely makes serious errors. However, it tends to over-classify claims as "Partially supported" when they should be "Supported" - a conservative approach that avoids false positives but lacks precision.

4. **OLMo-32B offers a balanced middle ground** with 66.7% accuracy and decent speed (3,002ms), though it showed good confidence calibration (43.2 point difference).

### Pattern Analysis

**Supported vs. Partially Supported**:
- Apertus-70B frequently labeled "Supported" claims as "Partially supported" (24 out of 60 cases)
- This accounts for its lower exact accuracy but higher lenient accuracy
- Claude and Qwen were much better at distinguishing these categories

**False Positives (Source doesn't support, but model says it does)**:
- Qwen-SEA-LION: 8 cases
- OLMo-32B: 6 cases
- Apertus-70B: 5 cases
- Claude Sonnet 4.5: 5 cases

**"Not Supported" Detection**:
- This was the hardest category for all models
- Claude correctly identified 0/5 as "Not Supported" but conservatively marked 4 as "Source unavailable"
- OLMo performed best on this category (3/5 correct)

**Confidence Calibration**:
- Claude has the best calibration (39.04 point gap), making it more trustworthy
- OLMo has strong calibration (43.2 point gap)
- Apertus has poor calibration (8.15 point gap), showing similar confidence whether right or wrong

### Reliability Considerations

- **Claude Sonnet 4.5** had perfect reliability with 0 errors (100% valid response rate)
- The three open-source models had excellent reliability with only 1 error each (98.7% valid response rate)
- No model had systematic failures or consistent patterns of breakdown
- Response format compliance was excellent across all models

## Conclusions

### Best Overall: Claude Sonnet 4.5

For the Wikipedia citation verification task, **Claude Sonnet 4.5** is the clear winner:
- Highest exact accuracy (75.0%)
- Perfect reliability (0 errors out of 76)
- Best confidence calibration (models that know when they're right are more trustworthy)
- Highest binary accuracy (92.1%)

### Best Open-Source: Qwen-SEA-LION-v4-32B

For users who need an open-source solution, **Qwen-SEA-LION-v4-32B** is the best choice:
- Nearly matches Claude's accuracy (73.3% vs 75%)
- Fastest response time among reliable models (3,657ms)
- Good confidence calibration (30.25)
- Excellent reliability (98.7%)

### Use Case Recommendations

- **For maximum accuracy and reliability**: Use Claude Sonnet 4.5
- **For best open-source option**: Use Qwen-SEA-LION-v4-32B
- **For conservative checking** (avoiding false claims of support): Use Apertus-70B
- **For budget-conscious deployments**: Use OLMo-32B

### Limitations

1. Dataset size (76 entries) is relatively small; more testing needed for statistical significance
2. Dataset focused on a single article topic (immigration); generalization to other domains needs validation
3. Open-source models tested via the same API provider; performance may vary with different inference setups
4. Ground truth was created by human review, which may have its own biases
5. "Not Supported" is the rarest category (5 examples), making it hard to evaluate performance on this edge case

### Future Work

- Expand dataset to cover more Wikipedia articles across diverse topics (target: 500+ entries)
- Test additional models (GPT-4, other Claude variants, larger open models)
- Add more "Not Supported" examples to better test false positive rates
- Investigate why models struggle with "Not Supported" detection
- Analyze specific failure cases to improve prompting strategies
- Test impact of different temperature settings and prompt variations
- Evaluate cost-performance tradeoffs for production deployment

## Reproduction

To reproduce this benchmark:

```bash
cd benchmark
npm install

# Extract dataset
npm run extract

# Run benchmark (requires API keys)
npm run benchmark

# Analyze results
npm run analyze

# Generate comparison report
npm run report
```

All code and data are available in the `/benchmark` directory of this repository.

---

**Generated**: 2026-01-23
**Dataset**: [`benchmark/dataset.json`](benchmark/dataset.json) (76 Wikipedia citation pairs)
**Models**: Claude Sonnet 4.5 + 3 open-source LLMs
**Total API calls**: 304 (76 × 4)
**Full Results**: [`benchmark/results.json`](benchmark/results.json)
**Analysis**: [`benchmark/analysis.json`](benchmark/analysis.json)
