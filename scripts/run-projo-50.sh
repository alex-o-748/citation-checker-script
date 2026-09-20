#!/usr/bin/env bash
set -euo pipefail

# Submit the 50 selected articles in the ProJo verification sample to Toolforge.
# Source: https://github.com/alex-o-748/wiki/blob/main/projects/projo-verification-sample-2026-09-17.md
# Run this from a Toolforge bastion; the job itself switches to the deployed
# citation-checker-script checkout before starting the sweep.
toolforge jobs run sweep-projo-50 \
  --image node18 \
  --mem 1Gi \
  --command "cd /data/project/source-verifier/citation-checker-script && node service/run-sweep.js --titles-file service/article-lists/projo-verification-sample-2026-09-17.txt --live-source-fetch --max 50 --concurrency 8 --out projo-verification-sample-2026-09-17-findings.csv"
