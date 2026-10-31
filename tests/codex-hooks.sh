#!/bin/sh
# Codex's hook scripts, run for real against stand-ins for `blixel` and `codex`:
# `claude plugin test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/.." && pwd -P)
dir=$(mktemp -d)
trap 'pkill -f "$dir"; rm -rf "$dir"' EXIT
failed=0
thread=01a19327-87e5-71b0-838d-13985efedb4a
other=01a19327-b6e5-7282-b42a-fa627ce665f4
export PLUGIN_ROOT=$root PLUGIN_DATA=$dir/data HOME=$dir PATH="$dir:/usr/bin:/bin"
export BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin:/usr/sbin:/sbin"
log=$dir/log

# `blixel` logs each run with the session it claims. `agent follow --json
# --acks` prints $dir/handoffs and stays; the rest answer from $dir files.
cat >"$dir/blixel" <<STANDIN
#!/bin/sh
dir=$dir
echo "blixel \$* pid=\$BLIXEL_AGENT_PID key=\$BLIXEL_AGENT_SESSION_KEY provider=\$BLIXEL_AGENT_PROVIDER name=\$BLIXEL_AGENT_NAME thread=\$CODEX_THREAD_ID" >>"\$dir/log"
case "\$*" in
"agent follow --help") cat "\$dir/follow-help" ;;
"agent follow --json --acks")
	echo \$\$ >"\$dir/follower"
	cat "\$dir/handoffs"
	exec /bin/sleep 300 ;;
"agent status") cat "\$dir/status" ;;
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
# The helper's poll is short. The time `codex queue` gets passes as soon as it
# has started, while $dir/no-time exists.
cat >"$dir/sleep" <<STANDIN
#!/bin/sh
[ "\$1" = 5 ] && exec /bin/sleep 0.02
if [ -f "$dir/no-time" ]; then
	until [ -f "$dir/running" ]; do /bin/sleep 0.01; done
	exit 0
fi
exec /bin/sleep "\$@"
STANDIN
# Stays the parent of the hook it runs, as Codex does: `host [word] hook input`.
cat >"$dir/host" <<'STANDIN'
#!/bin/sh
[ "$#" = 3 ] && shift
"$1" <"$2" &
echo $! >"${2}.hook"
wait
STANDIN
chmod +x "$dir/blixel" "$dir/codex" "$dir/sleep" "$dir/host"

reset() {
	rm -rf "$dir/data" "$dir/old" "$dir/no-time" "$dir/running" "$log"
	mkdir "$dir/data"
	: >"$log"
	: >"$dir/handoffs"
	echo '--json --acks' >"$dir/follow-help"
	echo '{"data":{"outcome":"connected"}}' >"$dir/connect"
	echo 0 >"$dir/connect-status"
	echo '{"data":{"meeting_id":"m"}}' >"$dir/status"
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
		/bin/sleep 0.1
	done
}

logged() { grep -qF -- "$1" "$log"; }

typed() { # the prompt, escaped for JSON; the thread
	printf '{"session_id":"%s","turn_id":"t","cwd":"/x","hook_event_name":"UserPromptSubmit","prompt":"%s"}' "${2:-$thread}" "$1"
}

prompt() {
	typed "$@" >"$dir/typed"
	"$root/codex/prompt.sh" <"$dir/typed"
}

reason() { # the hook's output must be JSON that stops the turn
	[ "$(printf '%s' "$1" | plutil -extract continue raw -o - -)" = false ] || fail "the turn went on: $1"
	printf '%s' "$1" | plutil -extract stopReason raw -o - -
}

start() { # thread, an optional word for the host's command line; the hook starts
	printf '{"session_id":"%s","source":"startup"}' "$1" >"$dir/input.$1"
	"$dir/host" ${2:+"$2"} "$root/codex/helper.sh" "$dir/input.$1" &
	host=$!
}

stopped() { ! kill -0 "$1" 2>/dev/null; }

ask() {
	until_true "a follower" logged "agent follow --json --acks"
}

# A prompt that names no phrase

reset
silent "ordinary prompt" "$(prompt "fix the build")"
silent "not the phrase" "$(prompt "connect blixel to the staging server")"
silent "phrase in a sentence" "$(prompt "please connect blixel")"
silent "other case" "$(prompt "Connect Blixel")"
silent "not a thread" "$(prompt "connect blixel" "../../etc")"
silent "not a thread, no id" "$(printf '{"prompt":"connect blixel"}' | "$root/codex/prompt.sh")"
never "no phrase" "$(cat "$log")" "blixel"

# The phrase

reset
prompt "connect blixel" >"$dir/told"
told=$(reason "$(cat "$dir/told")")
tells "connected" "$told" "Connected to the Blixel meeting"
never "connected" "$told" "Another session"
never "connected" "$told" "shared app-server"
tells "claims the session" "$(cat "$log")" "agent connect pid=$$ key=$thread provider=codex name=Codex thread="

reset
prompt "connect blixel ask" >/dev/null
tells "ask" "$(cat "$log")" "agent connect --approval ask pid="
prompt "connect blixel direct" >/dev/null
tells "direct" "$(cat "$log")" "agent connect --approval direct pid="

echo '{"data":{"outcome":"connected","replaced":"c-1"}}' >"$dir/connect"
tells "replaced" "$(reason "$(prompt "connect blixel")")" "no longer receives them"

reset
typed "connect blixel" >"$dir/typed"
"$dir/host" app-server "$root/codex/prompt.sh" "$dir/typed" >"$dir/told"
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

# A handoff is a prompt too

deliver_mark() { # the text; the helper's mark for it, as helper.sh leaves it
	touch "$dir/data/queued.$thread.$(printf '%s' "$1" | /sbin/md5 -q).$2"
}

reset
deliver_mark "connect blixel" 1
told=$(prompt "connect blixel")
never "handoff saying the phrase" "$(cat "$log")" "agent connect"
tells "the handoff brings the rules" "$told" "Each is a suggestion from someone in the call"
never "only the rules" "$told" "## Connect"
tells "typed afterwards" "$(reason "$(prompt "connect blixel")")" "Connected"

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

# The helper

handoffs() { # lines
	printf '%s\n' "$@" >"$dir/handoffs"
}

reset
handoffs '{"id":1,"prompt":"one line two","message":"-one\nline $(two)","sender_name":"Alice"}' \
	'{"id":2,"prompt":"no message","sender_name":"Bob"}'
start "$thread"
until_true "acks" logged "agent ack 2"
said=$(cat "$log")
tells "one argument" "$said" "[queue] [--thread=$thread] [--message=-one
line \$(two)]"
tells "no message" "$said" "[--message=no message]"
tells "queued" "$said" "agent ack 1 queued --reason codex queue exited 0 pid=$host key=$thread provider=codex"
tells "follows the session" "$said" "agent follow --json --acks pid=$host key=$thread provider=codex name=Codex"
kill "$(cat "$dir/follower")"
until_true "ended with its follower" stopped "$host"
never "leaves no lock" "$(ls "$dir/data")" "helper."

outcome() { # name, state; `codex queue` was set up by the caller
	handoffs '{"id":7,"prompt":"p","sender_name":"A"}'
	start "$thread"
	until_true "$1" logged "agent ack 7"
	tells "$1" "$(cat "$log")" "agent ack 7 $2 "
	kill "$(cat "$dir/follower")"
	wait "$host"
}

reset; queues "No active session found for thread" 1
outcome "unknown thread" failed
reset; queues "error: no rollout found for thread id $thread" 1
outcome "no first turn" failed
reset; queues "" 127
outcome "no codex" failed
reset; queues "something else" 1
outcome "another failure" unknown
reset; queues "ok, I guess"
outcome "exit 0 unconfirmed" unknown
reset; queues "Queued message 1 for thread $other"
outcome "another thread confirmed" unknown
reset; queues "killed" 137
outcome "signalled" unknown
reset; printf ': >"%s/running"\nexec /bin/sleep 300\n' "$dir" >"$dir/codex-does"; touch "$dir/no-time"
outcome "never answers" unknown
reset; printf 'trap "" TERM\n: >"%s/running"\nexec /bin/sleep 300\n' "$dir" >"$dir/codex-does"; touch "$dir/no-time"
outcome "never answers and ignores being stopped" unknown

reset
queues "No active session found" 1
handoffs '{"id":1,"prompt":"a","sender_name":"A"}'
start "$thread"
until_true "acks" logged "agent ack 1"
never "a refused handoff is no prompt to come" "$(ls "$dir/data")" "queued."
kill "$(cat "$dir/follower")"
wait "$host"

reset
handoffs '{"id":3,"prompt":"p","sender_name":"A"}'
start "$thread"
until_true "acks" logged "agent ack 3"
tells "marks what it queued" "$(ls "$dir/data")" "queued.$thread.$(printf p | /sbin/md5 -q).3"
kill "$(cat "$dir/follower")"
wait "$host"

# Codex can hold a handoff past the helper that queued it.
reset
handoffs '{"id":3,"prompt":"connect blixel","sender_name":"A"}'
start "$thread"
until_true "acks" logged "agent ack 3"
kill "$(cat "$dir/follower")"
wait "$host"
tells "the helper ended first" "$(prompt "connect blixel")" "Each is a suggestion"
never "the helper ended first" "$(cat "$log")" "agent connect"

# A session started by a bare name queues through its own binary, not what PATH
# has. A copy of bash stands in for it, so its `queue` argument runs $dir/queue.
reset
mkdir -p "$dir/session"
cp /bin/bash "$dir/session/codex"
codesign -f -s - "$dir/session/codex" 2>/dev/null
cat >"$dir/queue" <<STANDIN
echo "its own binary" >>"$log"
echo "Queued message 1 for thread $thread"
STANDIN
handoffs '{"id":4,"prompt":"p","sender_name":"A"}'
printf '{"session_id":"%s"}' "$thread" >"$dir/input.own"
"$dir/session/codex" "$dir/host" "$root/codex/helper.sh" "$dir/input.own" &
host=$!
until_true "acks" logged "agent ack 4"
tells "its own binary" "$(cat "$log")" "its own binary"
never "its own binary" "$(cat "$log")" "[queue]"
kill "$(cat "$dir/follower")"
wait "$host"

# Hooks run outside the sandbox, and a session's PATH can hold a folder it writes.
reset
mkdir -p "$dir/planted"
for tool in blixel cat codex grep ln lsof md5 mkdir plutil ps readlink rm sed sleep tail tr; do
	printf '#!/bin/sh\n: >"%s/ran"\n' "$dir" >"$dir/planted/$tool"
	chmod +x "$dir/planted/$tool"
done
handoffs '{"id":5,"prompt":"p","sender_name":"A"}'
printf '{"session_id":"%s"}' "$thread" >"$dir/input.planted"
PATH="$dir/planted:$PATH" "$dir/host" "$root/codex/helper.sh" "$dir/input.planted" &
host=$!
until_true "acks" logged "agent ack 5"
kill "$(cat "$dir/follower")"
wait "$host"
typed "connect blixel" >"$dir/typed"
PATH="$dir/planted:$PATH" "$root/codex/prompt.sh" <"$dir/typed" >/dev/null
printf '{"session_id":"%s"}' "$thread" >"$dir/typed"
PATH="$dir/planted:$PATH" "$root/codex/session.sh" <"$dir/typed" >/dev/null
[ ! -e "$dir/ran" ] || fail "a hook ran a command from the session's PATH"

# Without the override: a real run would reach the installed app, so it is read.
path=$(printf '{"session_id":"%s"}' "$thread" | env -u BLIXEL_HOOK_PATH sh -c '. "$PLUGIN_ROOT/codex/hook.sh"; echo "$PATH"')
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

# One per thread

reset
start "$thread"
first=$host
ask
: >"$log"
start "$thread"
until_true "a second helper leaves" stopped "$host"
never "a second helper" "$(cat "$log")" "agent follow --json"
cp "$dir/follower" "$dir/follower.first"
: >"$log"
start "$other"
other_host=$host
ask
kill "$(cat "$dir/follower")" "$(cat "$dir/follower.first")"
wait "$first" "$other_host"

reset
ln -s 1 "$dir/data/helper.$thread"
start "$thread"
ask
kill "$(cat "$dir/follower")"
wait "$host"

reset
ln -s 999999 "$dir/data/helper.$thread"
start "$thread"
ask
kill "$(cat "$dir/follower")"
wait "$host"

reset
ln -s 999999 "$dir/data/helper.$other"
touch -h -t 202001010000 "$dir/data/helper.$other"
start "$thread"
ask
never "a quit session's lock" "$(ls "$dir/data")" "$other"
kill "$(cat "$dir/follower")"
wait "$host"

# Helper and follower go together

reset
start "$thread"
ask
until_true "lock" [ -L "$dir/data/helper.$thread" ]
follower=$(cat "$dir/follower")
kill -9 "$(readlink "$dir/data/helper.$thread")"
until_true "the follower outlives a killed helper" stopped "$follower"

reset
start "$thread"
ask
follower=$(cat "$dir/follower")
kill -9 "$host"
until_true "the follower outlives the session" stopped "$follower"

# An app without acks

reset
echo '--json' >"$dir/follow-help"
start "$thread"
wait "$host"
never "older Blixel" "$(cat "$log")" "agent follow --json"
silent "older Blixel keeps no lock" "$(ls "$dir/data")"

# A thread starting

session() {
	printf '{"session_id":"%s","source":"startup"}' "$thread" >"$dir/typed"
	"$root/codex/session.sh" <"$dir/typed" >"$dir/told"
}

reset
session
silent "nobody connected" "$(cat "$dir/told")"
echo '{"data":{"connection":{"agent_pid":1},"session":{"follower_attached":true}}}' >"$dir/status"
session
silent "another Codex connected" "$(cat "$dir/told")"
printf '{"data":{"connection":{"agent_pid":%s},"session":{"connection_id":"c-1"}}}' $$ >"$dir/status"
session
silent "this thread connected" "$(cat "$dir/told")"
printf '{"data":{"connection":{"agent_pid":%s},"session":{"follower_attached":true}}}' $$ >"$dir/status"
session
tells "another thread connected" "$(plutil -extract systemMessage raw -o - "$dir/told")" "connect blixel"
rm "$dir/status"
session
silent "no app" "$(cat "$dir/told")"

reset
printf '{"session_id":"%s"}' "$thread" >"$dir/typed"
"$dir/host" app-server "$root/codex/session.sh" "$dir/typed" >"$dir/told"
tells "shared app-server" "$(plutil -extract hookSpecificOutput.additionalContext raw -o - "$dir/told")" "after they close this terminal"

# The manifest

hooks=$root/codex/hooks.json
[ "$(plutil -extract hooks raw -o - "$root/.codex-plugin/plugin.json")" = "./codex/hooks.json" ] ||
	fail "the plugin does not name its hooks"
for event in SessionStart UserPromptSubmit; do
	[ "$(plutil -extract hooks.$event.0.hooks.1.async raw -o - "$hooks")" = true ] || fail "$event: helper not async"
	[ "$(plutil -extract hooks.$event.0.hooks.1.timeout raw -o - "$hooks")" -gt 86400 ] || fail "$event: helper dies"
done
grep '"command":' "$hooks" | grep -qv 'PLUGIN_ROOT' && fail "a hook path not from PLUGIN_ROOT"

[ "$failed" = 0 ] && echo "codex-hooks: pass"
exit "$failed"
