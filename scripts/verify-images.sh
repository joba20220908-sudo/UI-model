#!/bin/bash
# Verify all images referenced in a project's data.js exist in screenshots/
# Usage: ./scripts/verify-images.sh [project-dir]
# Example: ./scripts/verify-images.sh Projects/hnw-licai

set -euo pipefail

PROJECT="${1:-Projects/hnw-licai}"
DATA="$PROJECT/data.js"
SHOTS="$PROJECT/screenshots"

if [ ! -f "$DATA" ]; then
  echo "Error: $DATA not found" >&2
  exit 1
fi

if [ ! -d "$SHOTS" ]; then
  echo "Error: $SHOTS directory not found" >&2
  exit 1
fi

missing=0
total=0

while IFS= read -r fname; do
  [ -z "$fname" ] && continue
  total=$((total + 1))
  if [ ! -f "$SHOTS/$fname" ]; then
    echo "MISSING: $fname"
    missing=$((missing + 1))
  fi
done < <(grep -o '"image":"[^"]*"' "$DATA" | sed 's/"image":"//;s/"//')

echo "---"
echo "Project : $PROJECT"
echo "Result  : $((total - missing))/$total images present"

if [ "$missing" -gt 0 ]; then
  echo "Status  : FAIL ($missing missing)"
  exit 1
else
  echo "Status  : OK"
fi
