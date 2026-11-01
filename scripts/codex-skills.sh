#!/bin/sh
# Codex asks its users to trust hooks again when anything in its plugin's root changes,
# so that root is codex/, and holds its own copy of the skills. Run this after changing
# them: tests/codex-hooks.sh fails on a stale copy.
root=$(cd "$(dirname "$0")/.." && pwd -P)
rsync -a --delete "$root/skills/" "$root/codex/skills/"
