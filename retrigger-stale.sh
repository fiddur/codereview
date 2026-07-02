#!/usr/bin/env bash
# Sweep open, non-draft PRs across the configured repos and re-fire a review for
# any whose latest posted review is behind the current head SHA (i.e. never got a
# review at HEAD — typically because a usage-limit blackout killed the attempt).
# Idempotent: PRs already reviewed at HEAD are skipped.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"

# Repos to sweep: one owner/repo per line in repos.local (gitignored), so the
# real list stays out of the repository. Falls back to an example when absent.
if [[ -f "$DIR/repos.local" ]]; then
  mapfile -t REPOS < <(grep -vE '^[[:space:]]*(#|$)' "$DIR/repos.local")
else
  REPOS=("you/your-repo")
fi

for repo in "${REPOS[@]}"; do
  echo "🔍 $repo"
  gh pr list --repo "$repo" --state open --json number,isDraft,headRefOid \
    --jq '.[] | select(.isDraft|not) | "\(.number) \(.headRefOid)"' |
  while read -r num head; do
    last=$(gh api "repos/$repo/pulls/$num/reviews" --jq '[.[].commit_id]|last' 2>/dev/null || echo "")
    if [ "$last" != "$head" ]; then
      echo "  🔁 stale #$num (head=${head:0:7} reviewed=${last:0:7}) → retrigger"
      node "$DIR/retrigger.mjs" "$repo" "$num"
    else
      echo "  ✅ current #$num (${head:0:7})"
    fi
  done
done
