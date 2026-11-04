#!/bin/sh
# Hands one handoff to the plugin that started this receiver: `blixel agent receive
# --deliver-with` runs it once for each, with the text as its one argument, and never
# again. It answers 0 once OpenCode took the text, 69 if OpenCode will not run it, and
# 1 for any doubt, as `receive` reads it.
case $(printf '%s\0' "$1" | /usr/bin/nc -U "$BLIXEL_OPENCODE_SOCKET") in
ok) exit 0 ;;
no) exit 69 ;;
esac
exit 1
