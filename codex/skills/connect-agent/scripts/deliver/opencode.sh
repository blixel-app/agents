#!/bin/sh
# Prompts one handoff into this OpenCode session through its server's API, the way the
# user typing it would. `blixel agent receive --deliver-with` runs it once per handoff
# and reads its exit: 0 the server took it, 69 it will not run, anything else unknown.
# It finds nothing on PATH, and the server's password never goes in an argv, where
# any process could read it.
service=${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json
field() { /usr/bin/plutil -extract "$1" raw -o - "$service" 2>/dev/null; }
pid=$(field pid) && url=$(field url) && password=$(field password) || exit 69
# Another server than the session's, as after a restart: the session is not on it.
[ "$pid" = "$BLIXEL_AGENT_PID" ] || exit 69

# The input needs a quoted key, or plutil reads it as an old-style plist.
body=$(printf '{"delivery":"queue"}' | /usr/bin/plutil -insert text -string "$1" -o - -) || exit 69
code=$(printf 'user = "opencode:%s"\n' "$(printf '%s' "$password" | /usr/bin/sed 's/[\\"]/\\&/g')" |
	/usr/bin/curl -s -K - -o /dev/null -w '%{http_code}' -m 8 -H 'content-type: application/json' \
		--data-binary "$body" "${url%/}/api/session/$BLIXEL_AGENT_SESSION_KEY/prompt")
case $code in
2??) exit 0 ;;
4??) exit 69 ;;
esac
exit 1
