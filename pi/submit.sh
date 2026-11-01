#!/bin/sh
# Hands one handoff to the extension that started this relay: `agent relay` runs it
# once for each, and never again. It answers 0 once pi took the text, 69 if pi will
# not run it, and 1 for any doubt, as the relay reads it.
case $(printf '%s\0' "$1" | /usr/bin/nc -U "$BLIXEL_PI_SOCKET") in
ok) exit 0 ;;
no) exit 69 ;;
esac
exit 1
