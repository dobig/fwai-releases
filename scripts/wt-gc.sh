#!/usr/bin/env bash
# Remove worktrees and local branches whose PR has merged.
#
# PRs are squash-merged, so `git branch --merged` never recognises them; this
# asks GitHub instead. Something is only removed when
#   - a PR from that branch merged and none from it is still open,
#   - the branch has no commit newer than that merge (a reused branch name
#     carrying new work is left alone), and
#   - for a worktree: nothing uncommitted (it may be another session's work).
#
#   scripts/wt-gc.sh           # dry run: list what would go
#   scripts/wt-gc.sh --apply   # remove it
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

cd "$(git rev-parse --show-toplevel)"
main_checkout="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
# Pin gh to origin: with an `upstream` remote present, gh otherwise queries
# pingdotgg/t3code and finds none of our PRs.
repo="$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"

# "<branch>\t<merged-at epoch>", latest merge per branch name.
merged="$(gh pr list -R "$repo" --state merged -L 1000 --json headRefName,mergedAt \
  --jq '.[] | "\(.headRefName)\t\(.mergedAt | fromdate)"' | sort -t$'\t' -k1,1 -k2,2nr | sort -t$'\t' -u -k1,1)"
open="$(gh pr list -R "$repo" --state open -L 1000 --json headRefName --jq '.[].headRefName')"

# Prints a reason to keep the branch, or nothing when it is safe to remove.
keep_reason() {
  local b="$1" merged_at tip
  if grep -qxF "$b" <<<"$open"; then echo "有未合并的 PR"; return; fi
  merged_at="$(awk -F'\t' -v b="$b" '$1 == b { print $2 }' <<<"$merged")"
  if [ -z "$merged_at" ]; then echo "没有已合并的 PR"; return; fi
  tip="$(git log -1 --format=%ct "refs/heads/$b")"
  if [ "$tip" -gt "$merged_at" ]; then echo "合并之后又有新提交"; return; fi
}

run() { if [ "$APPLY" = 1 ]; then "$@"; else echo "  would: $*"; fi; }

echo "== worktrees"
# Branches the worktree pass already decided on. Newline-delimited rather than
# an associative array: macOS ships bash 3.2.
handled=""
while IFS=$'\t' read -r path branch; do
  handled="$handled$branch"$'\n'
  [ "$path" = "$main_checkout" ] && continue
  reason="$(keep_reason "$branch")"
  if [ -z "$reason" ] && [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
    reason="PR 已合并，但有未提交的改动"
  fi
  if [ -n "$reason" ]; then
    echo "keep   $path ($branch): $reason"
    continue
  fi
  echo "remove $path ($branch)"
  run git worktree remove "$path"
  run git branch -D "$branch"
done < <(git worktree list --porcelain | awk '
  /^worktree /{p=substr($0,10)} /^branch /{sub("refs/heads/","",$2); print p "\t" $2}')

echo
echo "== 本地分支（没有挂在 worktree 上的）"
n=0
while IFS= read -r b; do
  grep -qxF "$b" <<<"$handled" && continue
  case "$b" in main) continue ;; esac
  [ -z "$(keep_reason "$b")" ] || continue
  n=$((n + 1))
  run git branch -D "$b"
done < <(git for-each-ref --format='%(refname:short)' refs/heads)
echo "$n 个已合并分支$([ "$APPLY" = 1 ] && echo " 已删除" || echo " 可删除")"

current="$(git -C "$main_checkout" branch --show-current)"
if [ "$current" != main ]; then
  echo
  echo "注意：主 checkout ($main_checkout) 在 '$current' 上，不在 main。"
fi
