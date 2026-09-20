#!/usr/bin/env bash
set -euo pipefail

# Submit the first 50 articles in the ProJo verification sample to Toolforge.
# Run this from a Toolforge bastion; the job itself switches to the deployed
# citation-checker-script checkout before starting the sweep.
toolforge jobs run sweep-projo-50 \
  --image node18 \
  --mem 1Gi \
  --command "cd /data/project/source-verifier/citation-checker-script && node service/run-sweep.js --titles-file projects/projo-verification-sample-2026-09-17.md --live-source-fetch --max 50 --concurrency 8 --out projo-verification-sample-2026-09-17-findings.csv"
