# Sourced first by each hook. Hooks run outside Codex's sandbox with the session's
# PATH, which can hold a folder the sandbox writes, such as an active venv's, so
# nothing may be found on it: not `ps`, not `blixel`, not `codex`. Spotlight goes
# for the same reason, as a workspace can hold a bundle with Blixel's id.
# BLIXEL_HOOK_PATH is for tests and development builds. A hook gets the environment
# of Codex itself, so sandboxed code cannot set it.
export PATH="${BLIXEL_HOOK_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export BLIXEL_SHIM_NO_SEARCH=1
input=$(cat)
session=${input#*\"session_id\":\"}
session=${session%%\"*}
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
export BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$session
export BLIXEL_AGENT_PROVIDER=codex BLIXEL_AGENT_NAME=Codex
blixel=$PLUGIN_ROOT/skills/connect-agent/scripts/blixel
