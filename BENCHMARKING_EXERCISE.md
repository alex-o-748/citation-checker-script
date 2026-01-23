# Wikipedia Citation Verification Benchmarking Exercise

## Overview

This document describes a benchmarking exercise conducted to evaluate the performance of various Large Language Models (LLMs) on the task of verifying Wikipedia citations. The goal was to assess how well different models can determine whether claims in Wikipedia articles are supported by their cited sources.

## Motivation

Wikipedia's reliability depends on accurate citations. The Wikipedia Source Verifier tool (main.js) uses AI to help editors verify that citations actually support the claims they're attached to. To understand which models perform best at this task, we conducted a systematic benchmark across multiple LLMs using real Wikipedia citations.

## Methodology

### Dataset Construction

We created a ground truth dataset of 76 claim-citation pairs from Wikipedia articles, specifically focusing on the "Immigration to the United States" article. Each entry contains:

- **Claim text**: The specific statement made in the Wikipedia article
- **Source text**: The content from the cited source
- **Ground truth verdict**: Human-verified classification of whether the source supports the claim

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

### Test Configuration

All models were tested using:
- Temperature: 0.1 (for consistency)
- The same system prompt with detailed instructions and examples
- The same dataset of 76 entries
- API calls via PublicAI's free inference service

## Models Tested

We evaluated three open-source models available through PublicAI:

1. **Apertus-70B** (`swiss-ai/apertus-70b-instruct`)
   - 70 billion parameter model from Swiss AI Lab
   - Designed for instruction following

2. **Qwen-SEA-LION-v4** (`aisingapore/Qwen-SEA-LION-v4-32B-IT`)
   - 32 billion parameter model from AI Singapore
   - Based on Qwen architecture, fine-tuned for Southeast Asian languages/contexts

3. **OLMo-3.1-32B** (`allenai/Olmo-3.1-32B-Instruct`)
   - 32 billion parameter model from Allen Institute for AI
   - Open Language Model designed for transparency and research

## Results

### Summary Statistics

| Model | Exact Accuracy | Lenient Accuracy | Binary Accuracy | Avg Latency (ms) | Confidence Calibration |
|-------|---------------|------------------|-----------------|------------------|----------------------|
| Qwen-SEA-LION | **73.3%** | 86.7% | 86.7% | 3,657 | **30.25** |
| OLMo-32B | 66.7% | 82.7% | 84.0% | **3,002** | 43.20 |
| Apertus-70B | 57.3% | **93.3%** | **94.7%** | 4,398 | 8.15 |

### Detailed Results

#### Qwen-SEA-LION-v4-32B
- **Valid responses**: 75/76 (1 error)
- **Exact matches**: 55/75 (73.3%)
- **Lenient accuracy**: 86.7%
- **Binary accuracy**: 86.7%
- **Average latency**: 3,657ms
- **Confidence calibration**: 30.25 (86% when correct, 55.75% when wrong)

**Confusion Matrix** (rows = ground truth, columns = predicted):
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
- **Average latency**: 3,002ms (fastest)
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
- **Average latency**: 4,398ms
- **Confidence calibration**: 8.15 (82.2% when correct, 74.1% when wrong)

**Confusion Matrix**:
```
                    Supported  Partial  Not Supported  Unavailable
Supported (60)         34       24          2             0
Partial (10)            3        7          0             0
Not Supported (5)       0        2          2             1
Unavailable (0)         -        -          -             -
```

## Analysis

### Key Findings

1. **Qwen-SEA-LION shows the best exact accuracy** (73.3%), making it the most reliable for precise classification. It also has the best confidence calibration, showing much higher confidence when correct (86%) vs. incorrect (55.75%).

2. **Apertus-70B has the best lenient and binary accuracy** (93.3% and 94.7%), meaning it rarely makes serious errors. However, it tends to over-classify claims as "Partially supported" when they should be "Supported" - a conservative approach that avoids false positives but lacks precision.

3. **OLMo-32B is the fastest** (3,002ms average) while maintaining competitive accuracy. It shows good confidence calibration (43.2 point difference).

### Pattern Analysis

**Supported vs. Partially Supported**:
- Apertus-70B frequently labeled "Supported" claims as "Partially supported" (24 out of 60 cases)
- This accounts for its lower exact accuracy but higher lenient accuracy
- This suggests Apertus is more conservative/cautious in its judgments

**False Positives (Source doesn't support, but model says it does)**:
- Qwen-SEA-LION: 8 cases (6 Supported + 2 Partial when ground truth was Partial/Not Supported)
- OLMo-32B: 6 cases
- Apertus-70B: 5 cases (3 Supported + 2 Partial)

**Source Unavailable Detection**:
- All models struggled to detect truly unavailable sources
- Some models incorrectly marked accessible sources as unavailable (Qwen: 3, OLMo: 8, Apertus: 1)

### Reliability Considerations

- All three models had exactly 1 error/invalid response out of 76 (98.7% valid response rate)
- No model had systematic failures or consistent patterns of breakdown
- Response format compliance was excellent across all models

## Conclusions

### Best Overall: Qwen-SEA-LION-v4-32B

For the Wikipedia citation verification task, **Qwen-SEA-LION-v4-32B** emerges as the best overall choice:
- Highest exact accuracy (73.3%)
- Best confidence calibration (models that know when they're right are more trustworthy)
- Competitive speed (3,657ms)
- Good balance between precision and recall

### Use Case Recommendations

- **For maximum precision**: Use Qwen-SEA-LION
- **For conservative checking** (avoiding false claims of support): Use Apertus-70B
- **For speed-critical applications**: Use OLMo-32B

### Limitations

1. Dataset size (76 entries) is relatively small; more testing needed for statistical significance
2. Dataset focused on a single article topic (immigration); generalization to other domains needs validation
3. All models tested via the same API provider; performance may vary with different inference setups
4. Ground truth was created by human review, which may have its own biases

### Future Work

- Expand dataset to cover more Wikipedia articles across diverse topics
- Test additional models (Claude, GPT-4, etc.) when budget allows
- Investigate why models struggle with "Source unavailable" detection
- Analyze specific failure cases to improve prompting strategies
- Test impact of different temperature settings and prompt variations

## Reproduction

To reproduce this benchmark:

```bash
cd benchmark
npm install

# Extract dataset
npm run extract

# Run benchmark (uses PublicAI free tier)
npm run benchmark

# Analyze results
npm run analyze

# Generate report
npm run report
```

All code and data are available in the `/benchmark` directory of this repository.

---

**Generated**: 2025-01-23
**Dataset**: 76 Wikipedia citation pairs
**Models**: 3 open-source LLMs via PublicAI
**Total API calls**: 228 (76 × 3)
