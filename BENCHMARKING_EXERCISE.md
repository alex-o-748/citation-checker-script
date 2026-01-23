# Wikipedia Citation Verification Benchmarking Exercise

## Overview

This document describes a benchmarking exercise conducted to evaluate the performance of various Large Language Models (LLMs) on the task of verifying Wikipedia citations. The goal was to assess how well different models can determine whether claims in Wikipedia articles are supported by their cited sources.

## Motivation

Wikipedia's reliability depends on accurate citations. The [Wikipedia AI Source Verification tool](https://en.wikipedia.org/wiki/User:Alaexis/AI_Source_Verification) uses AI to help editors verify that citations actually support the claims they're attached to. To understand which models perform best at this task, we conducted a systematic benchmark across multiple LLMs using real Wikipedia citations.

## Methodology

### Dataset Construction

We created a ground truth dataset of 76 claim-citation pairs from Wikipedia articles. The articles were chosen semi-randomly from the autor's areas of interest (). 

- **Claim text**: The specific statement made in the Wikipedia article
- **Source text**: The content from the cited source
- **Ground truth verdict**: Human-verified classification of whether the source supports the claim

**Dataset**: [`benchmark/dataset.json`](benchmark/dataset.json)

The dataset was created using the following workflow:
1. Extract claim/source pairs from Wikipedia articles using `extract_dataset.js`
2. Manual review of the dataset to ensure accuracy (especially for citations that appear multiple times)
3. Verification that source content was accessible and usable

The dataset contains almost all of the sources that were available online for the articles in the sample. To balance the dataset, a few examples of citations that failed verification were added from the author's archives. See the [Appendix](#appendix-example-cases) for detailed examples of "Not Supported" cases.

### Evaluation Criteria

Claims were classified into four categories:

- **Supported**: The source clearly supports the claim with definitive statements
- **Partially supported**: The source only parts of the claim or uses hedged language
- **Not supported**: The source contradicts the claim or doesn't mention the asserted information

### Metrics

We measured the following metrics for each model:

- **Exact Accuracy**: Percentage of predictions that exactly match the ground truth
- **Lenient Accuracy**: Treats "Partially supported" and "Not supported" as equivalent (since both indicate citation problems requiring user action). Counts as correct: exact matches on "Supported", and either "Partially supported" OR "Not supported" when ground truth is one of those two.
- **Confidence Calibration**: Difference between average confidence on correct vs. incorrect predictions (higher is better)
- **Latency**: Average response time in milliseconds

**Full Results**: [`benchmark/results.json`](benchmark/results.json) | **Analysis**: [`benchmark/analysis.json`](benchmark/analysis.json)

### Test Configuration

All models were tested using:
- Temperature: 0.1 (for consistency)
- The same system prompt with detailed instructions and examples // TODO add link
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

| Model | Exact Accuracy | Lenient Accuracy | Avg Latency (ms) | Confidence Calibration |
|-------|---------------|------------------|------------------|----------------------|
| **Claude Sonnet 4.5** | **75.0%** | **76.3%** | 4,093 | **39.04** |
| Qwen-SEA-LION | 73.3% | 74.7% | **3,657** | 30.25 |
| OLMo-32B | 66.7% | 66.7% | 3,002 | 43.20 |
| Apertus-70B | 57.3% | 60.0% | 4,398 | 8.15 |

### Detailed Results

#### Claude Sonnet 4.5 🏆
- **Valid responses**: 76/76 (0 errors - perfect reliability!)
- **Exact matches**: 57/76 (75.0%)
- **Lenient accuracy**: 58/76 (76.3%)
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
- **Lenient accuracy**: 56/75 (74.7%)
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
- **Lenient accuracy**: 50/75 (66.7%)
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
- **Lenient accuracy**: 45/75 (60.0%)
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


## Analysis

### Key Findings

1. **Claude Sonnet 4.5 is the clear winner** with 75% exact accuracy, 76.3% lenient accuracy, and perfect reliability (0 errors). It also has the best confidence calibration, showing much higher confidence when correct (86.9%) vs. incorrect (47.9%).

2. **Qwen-SEA-LION is the best open-source option** at 73.3% exact accuracy and 74.7% lenient accuracy, nearly matching Claude's performance. It's also the fastest of the reliable models (3,657ms).

3. **Apertus-70B is the most conservative** but has the lowest accuracy (57.3% exact, 60.0% lenient). It tends to over-classify claims as "Partially supported" when they should be "Supported" - a conservative approach that avoids false negatives but creates many false positives.

4. **OLMo-32B offers a balanced middle ground** with 66.7% accuracy and decent speed (3,002ms), though it showed good confidence calibration (43.2 point difference).

### Pattern Analysis

**Supported vs. Partially Supported**:
- Apertus-70B frequently labeled "Supported" claims as "Partially supported" (24 out of 60 cases)
- This conservative approach creates many false positives, resulting in both lower exact accuracy (57.3%) and lower lenient accuracy (60.0%)
- Claude and Qwen were much better at distinguishing these categories

**False Negatives (missing problems - dangerous!)**:
These are cases where the model fails to detect citation issues, allowing unsupported claims to pass. Ground truth was "Partially supported" or "Not supported" but model predicted "Supported", or ground truth was "Not supported" but model predicted any level of support:
- Qwen-SEA-LION: 9 cases (6 Partial→Supported, 3 NotSupported→Supported/Partial)
- Claude Sonnet 4.5: 6 cases (4 Partial→Supported, 2 NotSupported→Supported/Partial)
- OLMo-32B: 6 cases (5 Partial→Supported, 1 NotSupported→Supported)
- Apertus-70B: 5 cases (3 Partial→Supported, 2 NotSupported→Partial)

**False Positives (overcautious)**:
These are cases where the model incorrectly flags good citations, potentially creating unnecessary work. Ground truth was "Supported" but model predicted "Partially supported" or "Not supported":
- Apertus-70B: 26 cases (24 Supported→Partial, 2 Supported→NotSupported)
- OLMo-32B: 11 cases (7 Supported→Partial, 4 Supported→NotSupported)
- Qwen-SEA-LION: 6 cases (4 Supported→Partial, 2 Supported→NotSupported - note: 2 were marked as unavailable)
- Claude Sonnet 4.5: 6 cases (5 Supported→Partial, 1 Supported→NotSupported)

**"Not Supported" Detection**:
- Claude marked 4 as "Source unavailable" when the source was in fact available. In the comments it reasoned correctly that the claim is not supported but somehow failed to classify them as "Not Supported"
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
- Highest lenient accuracy (76.3%)
- Perfect reliability (0 errors out of 76)
- Best confidence calibration (models that know when they're right are more trustworthy)

### Best Open-Source: Qwen-SEA-LION-v4-32B

For users who need an open-source solution, **Qwen-SEA-LION-v4-32B** is the best choice:
- Nearly matches Claude's accuracy (73.3% vs 75%)
- Fastest response time among reliable models (3,657ms)
- Good confidence calibration (30.25)
- Excellent reliability (98.7%)

### Use Case Recommendations

- **For maximum accuracy and reliability**: Use Claude Sonnet 4.5
- **For best open-source option**: Use Qwen-SEA-LION-v4-32B
- **For conservative checking** (avoiding false negatives, willing to accept false positives): Use Apertus-70B
- **For budget-conscious deployments**: Use OLMo-32B

### Limitations

1. Dataset size (76 entries) is relatively small; more testing needed for statistical significance
2. Ground truth was created by human review, which may have its own biases
3. "Not Supported" is the rarest category (5 examples), making it hard to evaluate performance on this edge case

### Future Work

- Expand dataset to cover more Wikipedia articles across diverse topics (target: 500+ entries)
- Test additional models
- Add more "Not Supported" examples to better test false negative rates
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

## Appendix: Example Cases

### Not Supported Examples

These examples illustrate cases where the cited source does not support the Wikipedia claim. Detecting these is critical for maintaining Wikipedia's reliability.

#### Example 1: Irrelevant Source Content

**Article**: Immigration to the United States
**Claim**: "After an initial wave of immigration from China following the California Gold Rush, racist attitudes toward the Chinese population of the West Coast led to Congress passing the very first U.S. law restricting immigration: The Page Act of 1875 banned Chinese women who, it was claimed, were arriving to engage in prostitution."

**Source**: Washington Post opinion column about Arizona immigration law (2010)
**Why Not Supported**: The source is a modern opinion piece about Arizona's immigration policies and makes no mention of the Page Act of 1875, Chinese immigration, or 19th-century immigration law. The source is completely unrelated to the historical claim.

**Model Performance**:
- OLMo-32B: ✓ Correctly identified as "Not supported"
- Apertus-70B: Marked as "Partially supported" (false negative)
- Qwen-SEA-LION: Marked as "Supported" (false negative)
- Claude Sonnet 4.5: Marked as "Supported" (false negative)

---

#### Example 2: Wrong Date/Event

**Article**: Nasry Asfura
**Claim**: "The case continued until 15 December 2025, when the Supreme Court fully annulled all charges against Asfura and Cruz."

**Source**: El Heraldo article from June 1, 2021
**Why Not Supported**: The source describes a June 2021 appeals court decision to freeze criminal proceedings, not a December 2025 Supreme Court decision to annul charges. The date, court, and outcome are all different from the claim.

**Model Performance**:
- OLMo-32B: ✓ Correctly identified as "Not supported"
- Apertus-70B: Marked as "Partially supported" (false negative)
- Qwen-SEA-LION: Marked as "Supported" (false negative)
- Claude Sonnet 4.5: Marked as "Source unavailable" (incorrect reasoning)

---

#### Example 3: Source Unavailable

**Article**: War in Abkhazia (1992-1993)
**Claim**: "Most of the people who didn't survive the crossing died of cold and starvation. The survivors who reached the Svan mountains were attacked and robbed by local criminal groups. One of the survivors recalls the crossing:"

**Source**: (Failed to fetch - 404 error)
**Why Not Supported**: The source URL returns a 404 error and no content could be retrieved to verify the claim.

**Model Performance**:
- OLMo-32B: ✓ Correctly identified as "Not supported"
- Apertus-70B: Marked as "Partially supported" (false negative)
- Qwen-SEA-LION: Marked as "Supported" (false negative)
- Claude Sonnet 4.5: Marked as "Source unavailable" (technically correct but not the category we used)

---

### Key Observations from "Not Supported" Detection

The rarest category in the dataset (only 5 examples out of 76), "Not Supported" was the hardest for all models to detect correctly:

- **OLMo-32B performed best**: 3/5 correct (60%)
- **Apertus-70B**: 2/5 correct (40%), marked 2 as "Partially supported" and 1 as "Source unavailable"
- **Qwen-SEA-LION**: 2/5 correct (40%), incorrectly marked 2 as "Supported" and 1 as "Partially supported"
- **Claude Sonnet 4.5**: 0/5 correct (0%), but interestingly marked 4 as "Source unavailable" - the model's reasoning in comments often correctly identified that claims weren't supported, but it chose the wrong category

This pattern suggests that models tend to be overly generous in their assessments, preferring to mark questionable citations as "Partially supported" rather than "Not supported". This represents a significant risk for false negatives - allowing bad citations to remain on Wikipedia.

---

**Generated**: 2026-01-23
**Dataset**: [`benchmark/dataset.json`](benchmark/dataset.json) (76 Wikipedia citation pairs)
**Models**: Claude Sonnet 4.5 + 3 open-source LLMs
**Total API calls**: 304 (76 × 4)
**Full Results**: [`benchmark/results.json`](benchmark/results.json)
**Analysis**: [`benchmark/analysis.json`](benchmark/analysis.json)
