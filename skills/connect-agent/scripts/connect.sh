#!/bin/sh
# Runs inside /blixel:connect's `!` line, before the model. Claude Code aborts a
# command whose `!` line exits non-zero, so a failed connect has to exit 0 for
# the model to see why. A session connected this way never loaded the skill,
# so its rules follow the answer.
. "${0%/*}/path.sh"
case ${1-} in
ask | direct) set -- --approval "$1" ;;
*) set -- ;;
esac
"${0%/*}/blixel" agent connect "$@" 2>&1
status=$?
[ "$status" = 0 ] || echo "exit $status"
echo
sed -n '/^## Blixel handoffs$/,$p' "${0%/*}/../SKILL.md"
echo
cat "${0%/*}/../references/claude-code.md"
exit 0
