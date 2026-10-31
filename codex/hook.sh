# Sourced first by each script. Hooks run outside Codex's sandbox with the session's
# PATH, which can hold a folder the sandbox writes, such as an active venv's, so
# nothing may be found on it: not `ps`, not `blixel`, not `codex`. That goes for the
# filters in hooks.json too. Spotlight goes for the same reason, as a workspace can
# hold a bundle with Blixel's id. BLIXEL_HOOK_PATH is for tests and development
# builds. A hook gets the environment of Codex itself, so sandboxed code cannot set it.
export PATH="${BLIXEL_HOOK_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export BLIXEL_SHIM_NO_SEARCH=1
input=$BLIXEL_HOOK_INPUT
unset BLIXEL_HOOK_INPUT
session=${input#*\"session_id\":\"}
session=${session%%\"*}
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
export BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$session
export BLIXEL_AGENT_PROVIDER=codex BLIXEL_AGENT_NAME=Codex
blixel=$PLUGIN_ROOT/skills/connect-agent/scripts/blixel
# All a session keeps, so a filter tells a session that never invoked Blixel from
# one that did with a single `test`. `connected` means a relay belongs here.
state=$PLUGIN_DATA/$session

# It names the Codex process, as a connection ends with that: a thread resumed in
# another has nothing to bring back.
connected() { [ "$(cat "$state/connected" 2>/dev/null)" = "$PPID" ]; }

field() { # key path, JSON
	printf '%s' "$2" | plutil -extract "$1" raw -o - - 2>/dev/null
}
