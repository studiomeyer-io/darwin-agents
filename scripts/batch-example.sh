#!/bin/bash
# Darwin Batch Runner — Example
# Runs multiple tasks through an agent to build evolution data.
# Customize TOPICS and AGENT for your use case.
set -e
cd "$(dirname "$0")/.."
source .env 2>/dev/null

DARWIN="npx tsx src/cli/index.ts"
AGENT="writer"  # Change to your agent name
LOG="darwin-batch-$(date +%Y%m%d-%H%M).log"

echo "=== Darwin Batch (${AGENT}) ===" | tee "$LOG"
echo "Started: $(date)" | tee -a "$LOG"

# Define your topics: "category|task description"
TOPICS=(
  "tech|Explain how containerization improves deployment reliability for small teams"
  "tutorial|Write a beginner-friendly guide to setting up CI/CD with GitHub Actions"
  "opinion|Why TypeScript is worth the initial overhead for any project beyond a prototype"
  "comparison|Next.js vs Remix vs Astro: which framework for which use case in 2026"
  "deep-dive|Understanding WebSocket scaling: from single server to distributed architecture"
)

SUCCESS=0
FAIL=0
TOTAL=${#TOPICS[@]}

for i in "${!TOPICS[@]}"; do
  IFS='|' read -r TYPE TASK <<< "${TOPICS[$i]}"
  RUN_NUM=$((i + 1))

  echo "--- Run $RUN_NUM/$TOTAL ($TYPE) ---" | tee -a "$LOG"
  START=$(date +%s)
  if $DARWIN run "$AGENT" "$TASK" --task-type "$TYPE" 2>&1 | tee -a "$LOG"; then
    END=$(date +%s)
    echo "✓ Run $RUN_NUM (${TYPE}) done ($((END - START))s)" | tee -a "$LOG"
    SUCCESS=$((SUCCESS + 1))
  else
    END=$(date +%s)
    echo "✗ Run $RUN_NUM failed ($((END - START))s)" | tee -a "$LOG"
    FAIL=$((FAIL + 1))
  fi
  echo "" | tee -a "$LOG"
done

echo "=== Batch Complete ===" | tee -a "$LOG"
echo "Success: $SUCCESS / $TOTAL" | tee -a "$LOG"
echo "Failed:  $FAIL / $TOTAL" | tee -a "$LOG"
echo "Finished: $(date)" | tee -a "$LOG"

$DARWIN status "$AGENT" 2>&1 | tee -a "$LOG"
