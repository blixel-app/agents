#!/bin/sh
# Claude Code pastes /blixel:connect's arguments into its `!` line before any
# shell parses them, so anything else here would run as a command. A hook that
# cannot read them refuses too.
arguments=$(plutil -extract command_args raw -o - - 2>/dev/null) && case $arguments in
'' | ask | direct) exit 0 ;;
esac
echo "Usage: /blixel:connect [ask|direct]" >&2
exit 2
