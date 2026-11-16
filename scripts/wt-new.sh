#!/usr/bin/env bash
# Start a feature in its own worktree off origin/main (see AGENTS.md).
#
#   scripts/wt-new.sh <name> [feat|fix|chore]   # default: feat
#
# Creates branch <type>/<name> at ../fwai_code-<name> and prints the path.
set -euo pipefail

name="${1:?usage: scripts/wt-new.sh <name> [feat|fix|chore]}"
type="${2:-feat}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "name must be kebab-case: $name" >&2; exit 2; }

top="$(git rev-parse --show-toplevel)"
# Always relative to the main checkout, even when run from another worktree.
main_checkout="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
dir="$(dirname "$main_checkout")/fwai_code-$name"
branch="$type/$name"

[ -e "$dir" ] && { echo "$dir 已存在" >&2; exit 1; }
git -C "$top" fetch --quiet origin main
git -C "$top" worktree add -q -b "$branch" "$dir" origin/main
echo "$dir  ($branch @ $(git -C "$dir" rev-parse --short HEAD))"
# t3.json's setup script (deps, linked .env files); T3 runs it for worktrees it
# creates itself, this script does not. It needs the main checkout to link from.
echo "next: cd $dir && T3CODE_PROJECT_ROOT=$main_checkout node scripts/setup-worktree.ts"
