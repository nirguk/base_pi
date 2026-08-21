#!/bin/bash
# get a markdown table of free models available today on openrouter api

set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [--pretty]

  --pretty    Output a markdown table instead of raw CSV.
EOF
  exit 1
}

PRETTY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pretty) PRETTY=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# Fetch the catalog and filter free models
fetch_csv() {
  curl -s https://openrouter.ai/api/v1/models |
    jq -r '.data[]
           | select(.pricing.prompt == "0" and .pricing.completion == "0")
           | [.id, .name, (.context_length // "N/A"), (.max_completion_tokens // "N/A"), (.top_provider?.name // .provider // "N/A")]
           | @csv | gsub("\""; "")'
}

# Output handling
if [[ "$PRETTY" == "true" ]]; then
  printf "| ID | Name | Context | Max Tokens | Provider |\n"
  printf "|---|---|---|---|---|\n"
  fetch_csv | while IFS=',' read -r id name ctx maxdfn provider; do
    printf "| \`%s\` | %s | %s | %s | %s |\n" "$id" "$name" "$ctx" "$maxdfn" "$provider"
  done
else
  fetch_csv
fi