#!/bin/sh
# Codex's hook scripts, run for real against stand-ins for `blixel` and `codex`:
# `claude plugin test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/../codex" && pwd -P)
dir=$(mktemp -d)
trap 'pkill -f "$dir"; rm -rf "$dir"' EXIT
failed=0
thread=01a19327-87e5-71b0-838d-13985efedb4a
other=01a19327-b6e5-7282-b42a-fa627ce665f4
export PLUGIN_ROOT=$root PLUGIN_DATA=$dir/data HOME=$dir PATH="$dir:/usr/bin:/bin"
export BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin:/usr/sbin:/sbin"
log=$dir/log

# `blixel` logs each run with the session it claims. `agent relay` runs its submit
# once per line of $dir/handoffs, as the real one does, then stays until the test
# writes the status it leaves with to $dir/relay-exit.
cat >"$dir/blixel" <<STANDIN
#!/bin/sh
dir=$dir
echo "blixel \$* pid=\$BLIXEL_AGENT_PID key=\$BLIXEL_AGENT_SESSION_KEY provider=\$BLIXEL_AGENT_PROVIDER name=\$BLIXEL_AGENT_NAME thread=\$CODEX_THREAD_ID input=\${BLIXEL_HOOK_INPUT:+leaked}" >>"\$dir/log"
case "\$*" in
"agent relay"*)
	echo \$\$ >"\$dir/relay.\$\$"
	while IFS= read -r handoff; do
		BLIXEL_HANDOFF_ID=\${handoff%% *} "\$4" "\${handoff#* }" </dev/null >/dev/null 2>&1
		echo "submit \${handoff%% *} exited \$?" >>"\$dir/log"
	done <"\$dir/handoffs"
	until [ -f "\$dir/relay-exit" ]; do /bin/sleep 0.01; done
	exit "\$(cat "\$dir/relay-exit")" ;;
"agent status") cat "\$dir/status" ;;
"agent disconnect") cat "\$dir/disconnect" ;;
"agent connect"*)
	if [ -f "\$dir/old" ]; then
		echo '{"error":{"code":"not_in_agent_session","message":"Not a session"}}' >&2
		exit 2
	fi
	echo '{"event":"request_id"}' >&2
	cat "\$dir/connect" >&2
	exit "\$(cat "\$dir/connect-status")" ;;
esac
STANDIN
# `codex` logs its arguments, one by one, and does what $dir/codex-does says.
cat >"$dir/codex" <<STANDIN
#!/bin/sh
dir=$dir
for a in "\$@"; do printf '[%s] ' "\$a"; done >>"\$dir/log"
echo >>"\$dir/log"
. "\$dir/codex-does"
STANDIN
# Stays the parent of the hook, as Codex does, and runs it as Codex does:
# `host [word] command input`.
cat >"$dir/host" <<'STANDIN'
#!/bin/sh
[ "$#" = 3 ] && shift
echo $$ >"$2.host"
PATH=${SESSION_PATH:-$PATH}
/bin/zsh -c "$1" <"$2" &
wait $!
STANDIN
chmod +x "$dir/blixel" "$dir/codex" "$dir/host"

hooks=$root/hooks.json
connects=$(plutil -extract hooks.UserPromptSubmit.0.hooks.0.command raw -o - "$hooks")
restarts=$(plutil -extract hooks.UserPromptSubmit.0.hooks.1.command raw -o - "$hooks")
tool=$(plutil -extract hooks.PreToolUse.0.hooks.0.command raw -o - "$hooks")

reset() {
	rm -rf "$dir/data" "$dir/old" "$dir/relay-exit" "$dir"/relay.* "$log"
	mkdir "$dir/data"
	: >"$log"
	: >"$dir/handoffs"
	echo '{"data":{"outcome":"connected"}}' >"$dir/connect"
	echo 0 >"$dir/connect-status"
	echo '{"data":{"meeting_id":"m"}}' >"$dir/status"
	echo '{"data":{"outcome":"disconnected"}}' >"$dir/disconnect"
	queues "Queued message 1 for thread $thread"
}

queues() { # what `codex queue` prints; exit status
	printf 'echo "%s"\nexit %s\n' "$1" "${2:-0}" >"$dir/codex-does"
}

fail() { echo "FAIL: $1"; failed=1; }

tells() { # name, text, what it must hold
	case $2 in
	*"$3"*) ;;
	*) fail "$1: no \"$3\" in: $2" ;;
	esac
}

never() { # name, text, what it must not hold
	case $2 in
	*"$3"*) fail "$1: \"$3\" in: $2" ;;
	esac
}

silent() { # name, text
	[ -z "$2" ] || fail "$1: printed \"$2\""
}

until_true() { # name, command...
	name=$1
	shift
	tries=0
	until "$@"; do
		tries=$((tries + 1))
		[ "$tries" -lt 150 ] || { fail "$name: never happened"; return 1; }
		/bin/sleep 0.02
	done
}

logged() { grep -qF -- "$1" "$log"; }

typed() { # the prompt, escaped for JSON; the thread
	printf '{"session_id":"%s","turn_id":"t","cwd":"/x","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "${2:-$thread}" "$1"
}

ran() { # the Bash command, escaped for JSON; the thread
	printf '{"session_id":"%s","turn_id":"t","cwd":"/x","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "${2:-$thread}" "$1"
}

prompt() {
	typed "$@" >"$dir/typed"
	"$dir/host" "$connects" "$dir/typed"
}

# These two run their hooks from this shell, as one Codex process runs a session's.
relay_for() { # the same, through both handlers, side by side as Codex runs them
	typed "$@" >"$dir/asked"
	PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$connects" <"$dir/asked" >/dev/null &
	PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$restarts" <"$dir/asked" &
	host=$!
}

bash_call() { # the Bash command, escaped for JSON; the thread
	ran "$@" >"$dir/ran"
	PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$tool" <"$dir/ran" &
	host=$!
}

leaves() { # the status the relay exits with; waits for its hook
	echo "$1" >"$dir/relay-exit"
	wait "$host"
	rm -f "$dir/relay-exit"
}

relays() { grep -c "agent relay" "$log"; }

reason() { # the hook's output must be JSON that stops the turn
	[ "$(printf '%s' "$1" | plutil -extract continue raw -o - -)" = false ] || fail "the turn went on: $1"
	printf '%s' "$1" | plutil -extract stopReason raw -o - -
}

stopped() { ! kill -0 "$1" 2>/dev/null; }

# A session that never invoked Blixel: the filters in hooks.json settle it, with
# no script to run, which an empty PLUGIN_ROOT would turn into an error.

filtered() { # name; the input is in $dir/typed
	reset
	for command in "$connects" "$restarts" "$tool"; do
		said=$(PLUGIN_ROOT=$dir/nowhere "$dir/host" "$command" "$dir/typed" 2>&1) || fail "$1: failed"
		silent "$1" "$said"
	done
	silent "$1: wrote" "$(ls "$dir/data")"
}

for words in "fix the build" "please connect blixel" \
	"blixel transcripts" "connect to blixel" "connect" 'say \"prompt\":\"connect blixel\"'; do
	typed "$words" >"$dir/typed"
	filtered "ordinary prompt: $words"
done
ran "git status" >"$dir/typed"
filtered "ordinary command"
ran 'echo \"prompt\":\"connect blixel' >"$dir/typed"
filtered "a command quoting a phrase's key"

reset
silent "ordinary prompt" "$(prompt "fix the build")"
silent "not a thread" "$(prompt "connect blixel" "../../etc")"
silent "not a thread, no id" "$(printf '{"prompt":"connect blixel"}' >"$dir/typed"; "$dir/host" "$connects" "$dir/typed")"
never "no phrase" "$(cat "$log")" "blixel"

reset
for words in "connect blixel" "Connect Blixel" "blixel connect" "BLIXEL CONNECT" "blixel:connect" \
	'$blixel:connect' "Blixel:Connect"; do
	: >"$log"
	tells "connects: $words" "$(reason "$(prompt "$words")")" "Connected to the Blixel meeting"
	logged "agent connect pid=" || fail "connects: $words"
done

# The phrases

reset
prompt "connect blixel" >"$dir/told"
told=$(reason "$(cat "$dir/told")")
tells "connected" "$told" "Connected to the Blixel meeting"
never "connected" "$told" "Another session"
never "connected" "$told" "shared app-server"
tells "claims the session" "$(cat "$log")" "agent connect pid=$(cat "$dir/typed.host") key=$thread provider=codex name=Codex thread= input="

reset
for pair in "connect blixel ask:ask" "blixel connect direct:direct" "Blixel:Connect ASK:ask" \
	'$blixel:connect direct:direct'; do
	: >"$log"
	prompt "${pair%:*}" >/dev/null
	tells "${pair%:*}" "$(cat "$log")" "agent connect --approval ${pair##*:} pid="
done

echo '{"data":{"outcome":"connected","replaced":"c-1"}}' >"$dir/connect"
tells "replaced" "$(reason "$(prompt "connect blixel")")" "no longer receives them"

reset
for words in "connect blixel please" '$blixel:connect please' '$blixel:connect ask direct' '$blixel:status now'; do
	silent "words beside it go to the model: $words" "$(prompt "$words")"
done
never "words beside it go to the model" "$(cat "$log")" "blixel agent"

reset
typed "connect blixel" >"$dir/typed"
"$dir/host" app-server "$connects" "$dir/typed" >"$dir/told"
tells "shared app-server" "$(reason "$(cat "$dir/told")")" "after you close this terminal"

reset
echo 5 >"$dir/connect-status"
echo '{"error":{"code":"not_in_meeting","message":"The app is not in a \"meeting\"","hint":"Join from the app."}}' >"$dir/connect"
told=$(reason "$(prompt "connect blixel")")
tells "refused" "$told" 'Blixel did not connect: The app is not in a "meeting". Join from the app.'

printf '%s\n' '{"error":{"code":"x","message":"Line\tone\nline two"}}' >"$dir/connect"
tells "control characters" "$(reason "$(prompt "connect blixel")")" "Line one line two"

rm "$dir/connect"
echo "Blixel isn't installed. Get it at https://blixel.app" >"$dir/connect"
tells "no Blixel" "$(reason "$(prompt "connect blixel")")" "Get it at https://blixel.app"

# Its connect is the skill's, which is also what brings the rules. The app queues
# into the thread there, so this is also a handoff that says the phrase.
reset
touch "$dir/old"
silent "older Blixel" "$(prompt "connect blixel")"
[ "$(grep -c "agent connect" "$log")" = 1 ] || fail "older Blixel: connected twice: $(cat "$log")"

# Status and disconnect

status_says() { # name, what it must hold
	: >"$log"
	tells "$1" "$(reason "$(prompt '$blixel:status')")" "$2"
	logged "agent status pid=" || fail "$1: asked nothing"
}

reset
status_says "not connected" "not connected"
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":%s},"session":{"connection_id":"c-1"}}}' 1 >"$dir/status"
status_says "this thread" "Connected to the Blixel meeting"
echo '{"data":{"connection":{"connection_id":"c-1","agent_pid":1},"session":{"follower_attached":false}}}' >"$dir/status"
status_says "another session" "Another session"
echo '{"data":{}}' >"$dir/status"
status_says "no meeting" "not in a meeting"
echo '{"error":{"code":"app_unavailable","message":"Blixel is not running","hint":"Open it."}}' >"$dir/status"
status_says "no app" "Blixel is not running"

# Another thread of this process: the host writes the status, naming itself.
reset
typed '$blixel:status' >"$dir/typed"
cat >"$dir/status-host" <<STANDIN
#!/bin/sh
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":%s},"session":{}}}' \$\$ >"$dir/status"
exec "$dir/host" "\$@"
STANDIN
chmod +x "$dir/status-host"
tells "another conversation here" "$(reason "$("$dir/status-host" "$connects" "$dir/typed")")" 'Type $blixel:connect here to move them'

reset
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1"}}}' >"$dir/status"
typed '$blixel:status' >"$dir/typed"
"$dir/host" app-server "$connects" "$dir/typed" >"$dir/told"
tells "status on shared" "$(reason "$(cat "$dir/told")")" "after you close this terminal"

reset
tells "disconnected" "$(reason "$(prompt '$blixel:disconnect')")" "Disconnected"
logged "agent disconnect pid=" || fail "disconnect: asked nothing"
echo '{"data":{"outcome":"not_connected"}}' >"$dir/disconnect"
tells "had none" "$(reason "$(prompt '$blixel:disconnect')")" "not connected"
echo '{"error":{"code":"app_unavailable","message":"Blixel is not running"}}' >"$dir/disconnect"
tells "no app" "$(reason "$(prompt '$blixel:disconnect')")" "Blixel is not running"
touch "$dir/old"
echo '{"error":{"code":"not_in_agent_session","message":"Not a session"}}' >"$dir/disconnect"
silent "older Blixel" "$(prompt '$blixel:disconnect')"
echo '{"error":{"code":"not_in_agent_session","message":"Not a session"}}' >"$dir/status"
silent "older Blixel" "$(prompt '$blixel:status')"

# A handoff is a prompt too

deliver_mark() { # the text; the submit's mark for it
	mkdir -p "$dir/data/$thread"
	touch "$dir/data/$thread/queued.$(printf '%s' "$1" | /sbin/md5 -q).$2"
}

reset
for words in "connect blixel" "BLIXEL CONNECT" "blixel:connect ask" '$blixel:connect direct' '$blixel:status' '$blixel:disconnect'; do
	: >"$log"
	deliver_mark "$words" 1
	told=$(prompt "$words")
	silent "a handoff saying $words" "$(cat "$log")"
	tells "the handoff brings the rules" "$told" "Each is a suggestion from someone in the call"
	never "only the rules" "$told" "## Connect"
done
tells "typed afterwards" "$(reason "$(prompt "connect blixel")")" "Connected"

# The handlers race, so the marker may be gone before this one looks.
reset
deliver_mark "connect blixel" 1
prompt "connect blixel" >/dev/null
typed "connect blixel" >"$dir/asked"
"$dir/host" "$restarts" "$dir/asked" &
host=$!
until_true "a handoff saying a phrase starts no relay" stopped "$host"
echo 0 >"$dir/relay-exit"
silent "a handoff saying a phrase starts no relay" "$(cat "$log")"

reset
deliver_mark "add a test" 1
deliver_mark "add a test" 2
tells "the same text twice" "$(prompt "add a test")" "Each is a suggestion"
tells "the same text twice" "$(prompt "add a test")" "Each is a suggestion"
silent "typed afterwards" "$(prompt "add a test")"

reset
deliver_mark "add a test" 1
silent "typed while one is queued" "$(prompt "something else")"
tells "that one still comes" "$(prompt "add a test")" "Each is a suggestion"

# Starting a relay

started() { # name
	until_true "$1" logged "agent relay --submit $root/submit.sh"
}

reset
for words in "connect blixel" '$blixel:connect' "Blixel Connect direct" "blixel:connect ask"; do
	relay_for "$words"
	started "$words"
	tells "the session's own" "$(cat "$log")" "pid=$$ key=$thread provider=codex name=Codex thread= input="
	leaves 0
	: >"$log"
done

reset
for words in '$blixel:status' '$blixel:disconnect' "fix the build"; do
	relay_for "$words"
	wait "$host"
done
silent "only a connect starts one" "$(cat "$log")"

for command in 'blixel agent connect' '/x/skills/connect-agent/scripts/blixel agent connect --approval ask' \
	'\"/x y/scripts/blixel\" agent connect' "cd /x && blixel agent connect" "'/x y/blixel' agent connect"; do
	reset
	bash_call "$command"
	started "the model runs $command"
	leaves 0
done

for command in 'grep -rn \"blixel agent connect\" docs' "grep -rn 'blixel agent connect' docs" 'blixel agent status'; do
	reset
	bash_call "$command"
	wait "$host"
	silent "a command that only quotes it: $command" "$(cat "$log")"
done

# Only a session with a relay to bring back

reset
relay_for "fix the build"
wait "$host"
silent "an ordinary prompt, not connected" "$(cat "$log")"

restarted() { # name; a connect's relay was just killed, or says it is another's
	: >"$log"
	relay_for "fix the build"
	started "$1"
	leaves 0
}

reset
relay_for "connect blixel"
started "a connect"
kill -9 "$(cat "$dir"/relay.*)"
wait "$host"
rm "$dir"/relay.*
restarted "an ordinary prompt brings back a killed relay"

reset
bash_call "blixel agent connect"
started "a model-run connect"
leaves 143
restarted "the same for a model-run connect"

# Exit 5 is another follower, which may be this session's own older relay.
reset
relay_for "connect blixel"
started "a connect"
leaves 5
restarted "another follower keeps the marker"

# A connection ends with its Codex process, which can quit with no chance to clear this.
reset
mkdir "$dir/data/$thread"
echo 1 >"$dir/data/$thread/connected"
typed "fix the build" >"$dir/asked"
/bin/zsh -c "$restarts" <"$dir/asked" &
host=$!
until_true "a thread resumed in another process" stopped "$host"
silent "a thread resumed in another process runs nothing" "$(cat "$log")"
silent "a thread resumed in another process drops its state" "$(ls "$dir/data")"

mkdir "$dir/data/$thread"
echo 1 >"$dir/data/$thread/connected"
relay_for "connect blixel"
started "a resumed thread connects"
[ "$(cat "$dir/data/$thread/connected")" = $$ ] || fail "the marker names another process"
leaves 0

for status in 0 2 4; do
	reset
	relay_for "connect blixel"
	started "a connect"
	leaves "$status"
	: >"$log"
	relay_for "fix the build"
	wait "$host"
	silent "exit $status leaves nothing to bring back" "$(cat "$log")"
	silent "exit $status leaves no state" "$(ls "$dir/data")"
done

reset
relay_for "connect blixel"
started "a connect"
first=$host
: >"$log"
relay_for "fix the build" "$other"
wait "$host"
silent "another thread" "$(cat "$log")"
host=$first
leaves 0

reset
mkdir "$dir/data/$other"
touch -t 202001010000 "$dir/data/$other"
touch "$dir/data/queued.old"
touch -t 202001010000 "$dir/data/queued.old"
relay_for "connect blixel"
started "a connect"
never "a quit session's state" "$(ls "$dir/data")" "$other"
never "a quit session's state" "$(ls "$dir/data")" "queued.old"
leaves 0

# Past the filter's limit `exec` would fail, and the hook with it.
reset
mkdir "$dir/data/$thread"
echo "$$" >"$dir/data/$thread/connected"
python3 -c 'import sys; print("{\"session_id\":\"%s\",\"prompt\":\"%s\",\"tool_input\":{\"command\":\"blixel agent connect\"}}" % (sys.argv[1], "x" * 1200000), end="")' "$thread" >"$dir/typed"
for command in "$connects" "$restarts" "$tool"; do
	said=$("$dir/host" "$command" "$dir/typed" 2>&1) || fail "a huge prompt failed its hook"
	silent "a huge prompt" "$said"
done
silent "a huge prompt" "$(cat "$log")"

# The relay's stderr has no reader, and a relay's streams must not hold Codex's.
reset
relay_for "connect blixel"
started "a connect"
relay=$(cat "$dir"/relay.*)
[ "$(/usr/sbin/lsof -a -p "$relay" -d 2 -Fn | sed -n 's/^n//p')" = /dev/null ] || fail "the relay's stderr goes somewhere"
leaves 0

# The submit

submits() { # the text, then its exit status is the function's
	PATH=$BLIXEL_HOOK_PATH BLIXEL_AGENT_SESSION_KEY=$thread BLIXEL_AGENT_PID=$$ BLIXEL_HANDOFF_ID=7 \
		"$root/submit.sh" "$1" </dev/null >/dev/null 2>&1
}

exits() { # name, status
	submits p
	said=$?
	[ "$said" = "$2" ] || fail "$1: exited $said, not $2"
}

reset
mkdir "$dir/data/$thread"
submits '-one
line $(two)'
tells "one argument" "$(cat "$log")" "[queue] [--thread=$thread] [--message=-one
line \$(two)]"
exits "Codex confirmed it" 0
tells "marks what it queued" "$(ls "$dir/data/$thread")" "queued.$(printf p | /sbin/md5 -q).7"
reset; mkdir "$dir/data/$thread"; queues "No active session found for thread" 1
exits "unknown thread" 69
never "a refused handoff is no prompt to come" "$(ls "$dir/data/$thread")" "queued."
reset; mkdir "$dir/data/$thread"; queues "error: no rollout found for thread id $thread" 1
exits "no first turn" 69
reset; mkdir "$dir/data/$thread"; queues "" 127
exits "no codex" 69
reset; mkdir "$dir/data/$thread"; queues "" 126
exits "a codex it cannot run" 69
reset; mkdir "$dir/data/$thread"; queues "something else" 1
exits "another failure" 1
tells "may yet arrive" "$(ls "$dir/data/$thread")" "queued."
reset; mkdir "$dir/data/$thread"; queues "ok, I guess"
exits "exit 0 unconfirmed" 1
reset; mkdir "$dir/data/$thread"; queues "Queued message 1 for thread $other"
exits "another thread confirmed" 1
reset; mkdir "$dir/data/$thread"; queues "killed" 137
exits "signalled" 1
reset; mkdir "$dir/data/$thread"; queues "x" 69
exits "Codex's own 69 is not a refusal" 1

# Codex can hold a handoff past its relay.
reset
printf '3 connect blixel\n' >"$dir/handoffs"
relay_for "connect blixel"
until_true "a submit" logged "submit 3 exited 0"
leaves 0
: >"$log"
tells "the relay ended first" "$(prompt "connect blixel")" "Each is a suggestion"
never "the relay ended first" "$(cat "$log")" "agent connect"

# A session started by a bare name queues through its own binary, not what PATH
# has. A copy of bash stands in for it, so its `queue` argument runs $dir/queue.
reset
mkdir -p "$dir/session" "$dir/data/$thread"
cp /bin/bash "$dir/session/codex"
codesign -f -s - "$dir/session/codex" 2>/dev/null
cat >"$dir/queue" <<STANDIN
echo "its own binary" >>"$log"
echo "Queued message 1 for thread $thread"
STANDIN
cat >"$dir/own" <<STANDIN
BLIXEL_AGENT_SESSION_KEY=$thread BLIXEL_AGENT_PID=\$\$ PATH="$dir:/usr/bin:/bin:/usr/sbin:/sbin" BLIXEL_HANDOFF_ID=4 "$root/submit.sh" p
echo "submit exited \$?" >>"$log"
STANDIN
"$dir/session/codex" "$dir/own"
tells "its own binary" "$(cat "$log")" "its own binary"
tells "its own binary" "$(cat "$log")" "submit exited 0"
never "its own binary" "$(cat "$log")" "[queue]"

# Hooks run outside the sandbox, and a session's PATH can hold a folder it writes.
reset
mkdir -p "$dir/planted"
for tool_name in blixel cat codex find grep lsof md5 mkdir plutil ps rm rmdir sed tail touch tr; do
	printf '#!/bin/sh\necho %s "$*" >>"%s/planted.ran"\n' "$tool_name" "$dir" >"$dir/planted/$tool_name"
	chmod +x "$dir/planted/$tool_name"
done
printf '5 p\n' >"$dir/handoffs"
export SESSION_PATH="$dir/planted:$PATH"
relay_for "connect blixel"
until_true "a submit" logged "submit 5 exited 0"
leaves 0
bash_call "blixel agent connect"
leaves 0
prompt "connect blixel" >/dev/null
prompt '$blixel:status' >/dev/null
prompt "fix the build" >/dev/null
unset SESSION_PATH
[ ! -e "$dir/planted.ran" ] || fail "a hook ran a command from the session's PATH: $(cat "$dir/planted.ran")"

# Without the override: a real run would reach the installed app, so it is read.
path=$(env -u BLIXEL_HOOK_PATH BLIXEL_HOOK_INPUT="{\"session_id\":\"$thread\"}" sh -c '. "$PLUGIN_ROOT/hook.sh"; echo "$PATH"')
[ "$path" = /usr/bin:/bin:/usr/sbin:/sbin ] || fail "hook PATH: $path"

# A bundle Spotlight found can be one a workspace holds. /Applications is swapped
# out of a copy of the shim, as the check would pass on any Mac with Blixel on it.
mkdir -p "$dir/spotlight"
printf '#!/bin/sh\necho searched >>"%s"\n' "$log" >"$dir/spotlight/mdfind"
chmod +x "$dir/spotlight/mdfind"
sed 's#/Applications/Blixel.app#/nowhere#' "$root/skills/connect-agent/scripts/blixel" >"$dir/shim"
: >"$log"
PATH="$dir/spotlight:/usr/bin:/bin" sh "$dir/shim" 2>/dev/null
tells "the skill's shim searches" "$(cat "$log")" "searched"
: >"$log"
BLIXEL_SHIM_NO_SEARCH=1 PATH="$dir/spotlight:/usr/bin:/bin" sh "$dir/shim" 2>/dev/null
silent "a hook's shim does not" "$(cat "$log")"

# The manifest

manifest=$root/.codex-plugin/plugin.json
[ "$(plutil -extract hooks raw -o - "$manifest")" = "./hooks.json" ] || fail "the plugin does not name its hooks"
[ "$(plutil -extract plugins.0.source.path raw -o - "$root/../.agents/plugins/marketplace.json")" = "./codex" ] ||
	fail "the marketplace does not name Codex's root"
plutil -extract hooks.SessionStart raw -o - "$hooks" >/dev/null 2>&1 && fail "something runs at session start"
for handler in UserPromptSubmit.0.hooks.1 PreToolUse.0.hooks.0; do
	[ "$(plutil -extract "hooks.$handler.async" raw -o - "$hooks")" = true ] || fail "$handler: relay not async"
	[ "$(plutil -extract "hooks.$handler.timeout" raw -o - "$hooks")" -gt 86400 ] || fail "$handler: relay dies"
done
[ "$(plutil -extract hooks.PreToolUse.0.matcher raw -o - "$hooks")" = '^Bash$' ] || fail "PreToolUse watches more than Bash"

# Codex's trust covers its whole root, so that root holds a copy of what it shares
# with Claude Code: `scripts/codex-skills.sh` writes it.
diff -r "$root/../skills" "$root/skills" >"$dir/copy" || fail "codex/skills is stale: $(cat "$dir/copy")"
for skill in connect status disconnect; do
	[ -f "$root/codex-skills/$skill/SKILL.md" ] || fail "no \$blixel:$skill"
	grep -q 'allow_implicit_invocation: false' "$root/codex-skills/$skill/agents/openai.yaml" ||
		fail "the model can pick \$blixel:$skill"
done
[ ! -e "$root/commands" ] || fail "Codex would make skills of commands/"

[ "$failed" = 0 ] && echo "codex-hooks: pass"
exit "$failed"
