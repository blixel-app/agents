# Sourced first by each script that may run outside Claude Code's sandbox and runs
# anything by name. Hooks, the plugin's monitor and the mod run there with the session's
# PATH, which can hold a folder the sandbox writes, such as an active venv's, so nothing
# may be found on it: not `plutil`, not `blixel`. Spotlight goes for the same reason, as
# a workspace can hold a bundle with Blixel's id. BLIXEL_HOOK_PATH is for tests and
# development builds. These get Claude Code's environment, which sandboxed code cannot
# change: only a settings file adds to it, and one it could write could add a hook too.
export PATH="${BLIXEL_HOOK_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
export BLIXEL_SHIM_NO_SEARCH=1
