#!/bin/sh
# Runs inside /blixel:connect's `!` line, before the model. Claude Code aborts a
# command whose `!` line exits non-zero, so a failed connect has to exit 0 for
# the model to see why. A session connected this way never loaded the skill,
# so how to receive follows the answer.
. "${0%/*}/path.sh"
"${0%/*}/blixel" agent connect 2>&1
status=$?
[ "$status" = 0 ] || echo "exit $status"
echo
cat "${0%/*}/../references/claude.md"
exit 0
