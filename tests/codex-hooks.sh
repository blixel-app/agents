#!/bin/sh
# Codex's hook scripts, run for real against a stand-in for `blixel`: `claude plugin
# test` has no processes, so this one runs on its own.
root=$(cd "$(dirname "$0")/../codex" && pwd -P)
dir=$(mktemp -d)
trap 'pkill -f "$dir"; rm -rf "$dir"' EXIT
failed=0
thread=01a19327-87e5-71b0-838d-13985efedb4a
other=01a19327-b6e5-7282-b42a-fa627ce665f4
deliver=$root/skills/connect-agent/scripts/deliver/codex.sh
export PLUGIN_ROOT=$root PLUGIN_DATA=$dir/data HOME=$dir PATH="$dir:/usr/bin:/bin"
export BLIXEL_HOOK_PATH="$dir:/usr/bin:/bin:/usr/sbin:/sbin"
log=$dir/log

# `blixel` logs each run with the session it claims, and answers as the real CLI does:
# a connect connects the session, `receive` refuses a session with no connection
# (`not_connected`, exit 5), ends at once with `received_elsewhere` beside a live
# receiver, and otherwise prints `receiving` and runs its program once per line of
# $dir/handoffs. It then stays until the test writes how it stops to $dir/stops:
# `ended <reason>` or `error <code> <exit status>`.
cat >"$dir/blixel" <<STANDIN
#!/bin/sh
dir=$dir
echo "blixel \$* pid=\$BLIXEL_AGENT_PID key=\$BLIXEL_AGENT_SESSION_KEY provider=\$BLIXEL_AGENT_PROVIDER name=\$BLIXEL_AGENT_NAME thread=\$CODEX_THREAD_ID input=\${BLIXEL_HOOK_INPUT:+leaked}" >>"\$dir/log"
event() { printf '{"data":%s,"event":"%s","schema_version":1}\n' "\$2" "\$1"; }
case "\$*" in
"agent receive"*)
	if [ ! -f "\$dir/connection" ]; then
		echo '{"error":{"code":"not_connected","message":"This session is not connected to the meeting","context":{"last_ended":"disconnected"}}}' >&2
		exit 5
	fi
	for live in "\$dir"/receiver.*; do
		if [ -f "\$live" ] && kill -0 "\$(cat "\$live")" 2>/dev/null; then
			event ended '{"reason":"received_elsewhere"}'
			exit 0
		fi
	done
	echo \$\$ >"\$dir/receiver.\$\$"
	event receiving '{"connection_id":"c-1"}'
	while IFS= read -r handoff; do
		BLIXEL_HANDOFF_ID=\${handoff%% *} "\$4" "\${handoff#* }" </dev/null >/dev/null 2>&1
		echo "deliver \${handoff%% *} exited \$?" >>"\$dir/log"
		event delivered "{\"id\":\"\${handoff%% *}\",\"state\":\"delivered\"}"
	done <"\$dir/handoffs"
	until [ -f "\$dir/stops" ]; do /bin/sleep 0.01; done
	read -r how code status <"\$dir/stops"
	rm -f "\$dir/receiver.\$\$"
	case \$how in
	ended) event ended "{\"reason\":\"\$code\"}"; exit 0 ;;
	*) echo "{\"error\":{\"code\":\"\$code\",\"message\":\"Stopped\"}}" >&2; exit "\$status" ;;
	esac ;;
"agent status")
	# With status-live, the app's answer for a connected session that receives
	# while a receiver is live.
	if [ -f "\$dir/status-live" ]; then
		receiving=false
		for live in "\$dir"/receiver.*; do
			[ -f "\$live" ] && kill -0 "\$(cat "\$live")" 2>/dev/null && receiving=true
		done
		printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1","receiving":%s}}}' "\$receiving"
	else
		cat "\$dir/status"
	fi ;;
"agent disconnect")
	rm -f "\$dir/connection"
	cat "\$dir/disconnect" ;;
"agent connect"*)
	echo '{"data":{"request_id":"r-1"},"event":"request_id","schema_version":1}' >&2
	status=\$(cat "\$dir/connect-status")
	if [ "\$status" = 0 ]; then
		touch "\$dir/connection"
		cat "\$dir/connect"
	else
		cat "\$dir/connect" >&2
	fi
	exit "\$status" ;;
esac
STANDIN
# Stays the parent of the hook, as Codex does, and runs it as Codex does:
# `host [word] command input`.
cat >"$dir/host" <<'STANDIN'
#!/bin/sh
[ "$#" = 3 ] && shift
echo $$ >"$2.host"
PATH=${SESSION_PATH:-$PATH}
"${HOOK_SHELL:-/bin/zsh}" -c "$1" <"$2" &
wait $!
STANDIN
chmod +x "$dir/blixel" "$dir/host"

hooks=$root/hooks.json
answers=$(plutil -extract hooks.UserPromptSubmit.0.hooks.0.command raw -o - "$hooks")
receives=$(plutil -extract hooks.UserPromptSubmit.0.hooks.1.command raw -o - "$hooks")

reset() {
	pkill -f "$dir/blixel agent receive" 2>/dev/null
	rm -rf "$dir/data" "$dir/stops" "$dir"/receiver.* "$dir/connection" "$log"
	mkdir "$dir/data"
	: >"$log"
	: >"$dir/handoffs"
	echo '{"data":{"outcome":"connected","receiving":false,"replaced":false},"schema_version":1}' >"$dir/connect"
	echo 0 >"$dir/connect-status"
	echo '{"data":{"meeting_id":"m"}}' >"$dir/status"
	echo '{"data":{"outcome":"disconnected"}}' >"$dir/disconnect"
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

prompt() { # hook 1 alone, as Codex's host
	typed "$@" >"$dir/typed"
	"$dir/host" "$answers" "$dir/typed"
}

# Both hooks of one prompt, from this shell, as one Codex process runs a session's:
# hook 1 first, hook 2 first, or side by side. Hook 2 is left running in $host.
both() { # order: answers-first, receives-first or together; the prompt; the thread
	order=$1
	shift
	typed "$@" >"$dir/asked"
	case $order in
	answers-first)
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$answers" <"$dir/asked" >"$dir/told"
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$receives" <"$dir/asked" &
		host=$!
		;;
	receives-first)
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$receives" <"$dir/asked" &
		host=$!
		until_true "hook 2 connected first" logged "agent connect"
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$answers" <"$dir/asked" >"$dir/told"
		;;
	*)
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$answers" <"$dir/asked" >"$dir/told" &
		PATH=${SESSION_PATH:-$PATH} /bin/zsh -c "$receives" <"$dir/asked" &
		host=$!
		wait %1
		;;
	esac
}

receiving() { # name
	until_true "$1" logged "agent receive --deliver-with $deliver"
	until_true "$1: attached" ls "$dir"/receiver.* >/dev/null 2>&1
}

stops() { # how the receiver stops (`ended <reason>` or `error <code> <status>`); waits for hook 2
	echo "$1" >"$dir/stops"
	wait "$host"
	rm -f "$dir/stops"
}

receives() { grep -c "agent receive" "$log"; }

# The answer goes to the model as a note, and the model tells the user: Codex desktop
# shows a stopped turn's text nowhere, and a blocked one only as a warning.
reason() { # the hook's output must be JSON that lets the turn go on with the answer
	for key in continue stopReason systemMessage decision reason; do
		if printf '%s' "$1" | plutil -extract "$key" raw -o - - >/dev/null 2>&1; then
			echo "FAIL: $key beside the answer"
			return
		fi
	done
	[ "$(printf '%s' "$1" | plutil -extract hookSpecificOutput.hookEventName raw -o - -)" = UserPromptSubmit ] ||
		{ echo "FAIL: no UserPromptSubmit note"; return; }
	note=$(printf '%s' "$1" | plutil -extract hookSpecificOutput.additionalContext raw -o - -)
	case $note in *"run no command"*) ;; *) echo "FAIL: the note lets the model run a command"; return ;; esac
	printf '%s' "$note"
}

stopped() { ! kill -0 "$1" 2>/dev/null; }

flagged() { [ -e "$dir/data/$thread/connected" ]; }

# Nothing runs before a connect: in a session that never connected, the filters in
# hooks.json settle every other prompt with no script to run, which an empty
# PLUGIN_ROOT would turn into an error.

filtered() { # name; the input is in $dir/typed
	reset
	for command in "$answers" "$receives"; do
		said=$(PLUGIN_ROOT=$dir/nowhere "$dir/host" "$command" "$dir/typed" 2>&1) || fail "$1: failed"
		silent "$1" "$said"
	done
	silent "$1: wrote" "$(ls "$dir/data")"
}

# Codex runs them with the login shell where it knows it.
for HOOK_SHELL in /bin/zsh /bin/bash; do
	export HOOK_SHELL
	for words in "fix the build" "please connect blixel" \
		"blixel transcripts" "connect to blixel" "connect" 'say \"prompt\":\"connect blixel\"'; do
		typed "$words" >"$dir/typed"
		filtered "$HOOK_SHELL, ordinary prompt: $words"
	done

	reset
	for words in "connect blixel" "Blixel:Connect" '$blixel:connect'; do
		tells "$HOOK_SHELL: $words" "$(reason "$(prompt "$words")")" "Connected to the Blixel meeting"
	done
done
unset HOOK_SHELL

# The hooks.json filters let a phrase with words after it through to the script,
# which reads the whole prompt; a prompt that is not a phrase stays filtered even
# once a thread is connected, as no handoff needs a marker.
reset
mkdir -p "$dir/data/$thread"
echo $$ >"$dir/data/$thread/connected"
typed "fix the build" >"$dir/typed"
silent "an ordinary prompt in a connected thread" "$(PLUGIN_ROOT=$dir/nowhere "$dir/host" "$answers" "$dir/typed" 2>&1)"

reset
silent "ordinary prompt" "$(prompt "fix the build")"
silent "not a thread" "$(prompt "connect blixel" "../../etc")"
silent "not a thread, no id" "$(printf '{"prompt":"connect blixel"}' >"$dir/typed"; "$dir/host" "$answers" "$dir/typed")"
never "no phrase" "$(cat "$log")" "blixel"

# Typed commands, answered with no model

reset
for words in "connect blixel" "Connect Blixel" "blixel connect" "BLIXEL CONNECT" "blixel:connect" \
	'$blixel:connect' "Blixel:Connect"; do
	: >"$log"
	tells "connects: $words" "$(reason "$(prompt "$words")")" "Connected to the Blixel meeting"
	logged "agent connect pid=" || fail "connects: $words"
done

reset
prompt "connect blixel" >"$dir/told"
told=$(reason "$(cat "$dir/told")")
tells "connected" "$told" "Connected to the Blixel meeting"
never "connected" "$told" "Another session"
never "connected" "$told" "shared app-server"
tells "claims the session" "$(cat "$log")" "blixel agent connect pid=$(cat "$dir/typed.host") key=$thread provider=codex name=Codex thread= input="

echo '{"data":{"outcome":"connected","receiving":false,"replaced":true},"schema_version":1}' >"$dir/connect"
tells "replaced" "$(reason "$(prompt "connect blixel")")" "no longer receives them"

# Codex desktop sends a command picked from the list as a link to its skill, with
# a space and a line break after it.
desktop() { printf '[$blixel:%s](/Applications/Codex.app/plugins/blixel/codex-skills/%s/SKILL.md) \\n' "$1" "$1"; }

reset
: >"$log"
tells "desktop connect" "$(reason "$(prompt "$(desktop connect)")")" "Connected to the Blixel meeting"
logged "agent connect pid=" || fail "desktop connect: asked nothing"
tells "desktop status" "$(reason "$(prompt "$(desktop status)")")" "Blixel"
tells "desktop disconnect" "$(reason "$(prompt "$(desktop disconnect)")")" "Disconnected"

reset
both answers-first "$(desktop connect)"
receiving "a desktop connect"
stops "ended disconnected"

reset
silent "desktop, words after it go to the model" "$(prompt "$(desktop connect) please")"
silent "desktop, another skill goes to the model" "$(prompt '[$blixel:blixel](/x/SKILL.md) \\n')"
never "desktop, words after it go to the model" "$(cat "$log")" "blixel agent"

reset
for words in "connect blixel please" '$blixel:connect please' '$blixel:connect ask' "connect blixel direct" \
	'$blixel:status now' "disconnect blixel please" "blixel status direct"; do
	silent "words beside it go to the model: $words" "$(prompt "$words")"
done
never "words beside it go to the model" "$(cat "$log")" "blixel agent"

reset
typed "connect blixel" >"$dir/typed"
"$dir/host" app-server "$answers" "$dir/typed" >"$dir/told"
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

# Status and disconnect

status_says() { # name, what it must hold
	: >"$log"
	tells "$1" "$(reason "$(prompt '$blixel:status')")" "$2"
	logged "agent status pid=" || fail "$1: asked nothing"
}

reset
status_says "not connected" "not connected"
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1","receiving":true}}}' >"$dir/status"
status_says "this thread" "Handoffs from people in it arrive in this conversation"
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1","receiving":false}}}' >"$dir/status"
status_says "this thread, not receiving" 'not receiving its handoffs. Type $blixel:connect'
# The thread's flag says hook 2 starts its receiver again on this same prompt; one
# that never attaches is still not receiving.
mkdir -p "$dir/data/$thread"
echo "$$" >"$dir/data/$thread/connected"
typed '$blixel:status' >"$dir/typed"
/bin/zsh -c "$answers" <"$dir/typed" >"$dir/told"
tells "this thread, no receiver comes back" "$(reason "$(cat "$dir/told")")" 'not receiving its handoffs. Type $blixel:connect'
rm -rf "$dir/data/$thread"
echo '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connected":false}}}' >"$dir/status"
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
tells "another conversation here" "$(reason "$("$dir/status-host" "$answers" "$dir/typed")")" 'Type $blixel:connect here to move them'

reset
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1","receiving":true}}}' >"$dir/status"
typed '$blixel:status' >"$dir/typed"
"$dir/host" app-server "$answers" "$dir/typed" >"$dir/told"
tells "status on shared" "$(reason "$(cat "$dir/told")")" "after you close this terminal"

reset
tells "disconnected" "$(reason "$(prompt '$blixel:disconnect')")" "Disconnected"
logged "agent disconnect pid=" || fail "disconnect: asked nothing"
for words in "status blixel" "Blixel Status" "blixel:status"; do
	tells "status by phrase: $words" "$(reason "$(prompt "$words")")" "Blixel"
done
for words in "disconnect blixel" "Disconnect Blixel" "blixel disconnect" "BLIXEL DISCONNECT" "blixel:disconnect"; do
	tells "disconnect by phrase: $words" "$(reason "$(prompt "$words")")" "Disconnected"
done
echo '{"data":{"outcome":"not_connected"}}' >"$dir/disconnect"
tells "had none" "$(reason "$(prompt '$blixel:disconnect')")" "not connected"
tells "had none, by phrase" "$(reason "$(prompt "disconnect blixel")")" "not connected"
echo '{"error":{"code":"app_unavailable","message":"Blixel is not running"}}' >"$dir/disconnect"
tells "no app" "$(reason "$(prompt '$blixel:disconnect')")" "Blixel is not running"

# Receiving: hook 2 connects, then receives, after a typed connect

reset
for order in answers-first receives-first together; do
	for words in "connect blixel" '$blixel:connect' "Blixel Connect"; do
		reset
		both "$order" "$words"
		tells "$order, $words: answered" "$(reason "$(cat "$dir/told")")" "Connected to the Blixel meeting"
		receiving "$order, $words"
		[ "$(grep -c "agent connect" "$log")" = 2 ] || fail "$order, $words: both hooks connect: $(cat "$log")"
		never "$order, $words: receive before its own connect" "$(cat "$log")" "not_connected"
		tells "$order, $words: the session's own" "$(grep "agent receive" "$log")" \
			"pid=$$ key=$thread provider=codex name=Codex thread= input="
		flagged || fail "$order, $words: no connected flag while receiving"
		stops "ended disconnected"
	done
done

# Hook 2's own connect comes first in its script, whatever hook 1 did: here hook 1's
# never ran, so a receive before it would be refused.
reset
typed "connect blixel" >"$dir/asked"
/bin/zsh -c "$receives" <"$dir/asked" &
host=$!
receiving "hook 2 alone"
[ "$(sed -n 1p "$log" | cut -d' ' -f2-3)" = "agent connect" ] || fail "hook 2 alone: received before connecting: $(cat "$log")"
stops "ended disconnected"

reset
for words in '$blixel:status' '$blixel:disconnect' "fix the build"; do
	typed "$words" >"$dir/asked"
	/bin/zsh -c "$receives" <"$dir/asked" &
	wait $!
done
silent "only a connect starts a receiver" "$(cat "$log")"

reset
echo 5 >"$dir/connect-status"
echo '{"error":{"code":"not_in_meeting","message":"Not in a meeting"}}' >"$dir/connect"
typed "connect blixel" >"$dir/asked"
/bin/zsh -c "$receives" <"$dir/asked" &
host=$!
until_true "a failed connect" stopped "$host"
[ "$(receives)" = 0 ] || fail "a failed connect started a receiver: $(cat "$log")"
silent "a failed connect leaves no state" "$(ls "$dir/data")"

# A handoff is a prompt like any other. Codex cannot tell one from what the user
# typed, so one that is a phrase runs it, as decided.
reset
both answers-first "connect blixel"
receiving "a connect"
printf '{"data":{"meeting_id":"m","connection":{"connection_id":"c-1","agent_pid":1},"session":{"connection_id":"c-1","receiving":true}}}' >"$dir/status"
for words in '$blixel:status' "disconnect blixel"; do
	: >"$log"
	typed "$words" >"$dir/typed"
	"$dir/host" "$answers" "$dir/typed" >"$dir/told"
	tells "a handoff saying $words" "$(reason "$(cat "$dir/told")")" "Blixel"
	logged "agent ${words#*:}" || logged "agent ${words% blixel}" || fail "a handoff saying $words ran nothing"
done
stops "ended disconnected"

# The receiver delivers through the skill's deliver program for Codex.
reset
printf '3 add a test\n' >"$dir/handoffs"
both answers-first "connect blixel"
until_true "a deliver" logged "deliver 3 exited"
stops "ended disconnected"

# Receiving again: a later prompt brings back a receiver that stopped without an end

again() { # name; a prompt after the receiver stopped must start it again
	: >"$log"
	typed "${2:-fix the build}" >"$dir/asked"
	/bin/zsh -c "$receives" <"$dir/asked" &
	host=$!
	receiving "$1"
	never "$1: connects again" "$(cat "$log")" "agent connect"
	stops "ended disconnected"
}

not_again() { # name; a prompt after the receiver ended must start nothing
	: >"$log"
	typed "fix the build" >"$dir/asked"
	/bin/zsh -c "$receives" <"$dir/asked" &
	host=$!
	until_true "$1" stopped "$host"
	silent "$1: ran" "$(cat "$log")"
	flagged && fail "$1: the connected flag stays"
}

reset
both answers-first "connect blixel"
receiving "a connect"
kill -9 "$(cat "$dir"/receiver.*)"
wait "$host"
rm -f "$dir"/receiver.*
flagged || fail "a killed receiver drops the connected flag"
again "an ordinary prompt brings back a killed receiver"

reset
both answers-first "connect blixel"
receiving "a connect"
stops "error cancelled 143"
again "a cancelled receiver comes back"

reset
both answers-first "connect blixel"
receiving "a connect"
kill -9 "$(cat "$dir"/receiver.*)"
wait "$host"
rm -f "$dir"/receiver.*
again "a status prompt brings it back too" '$blixel:status'

# Hook 1 answers that status prompt with the app's word once hook 2's receiver is back.
reset
touch "$dir/status-live"
both answers-first "connect blixel"
receiving "a connect"
kill -9 "$(cat "$dir"/receiver.*)"
wait "$host"
rm -f "$dir"/receiver.*
typed '$blixel:status' >"$dir/asked"
/bin/zsh -c "$receives" <"$dir/asked" &
host=$!
/bin/zsh -c "$answers" <"$dir/asked" >"$dir/told"
told=$(reason "$(cat "$dir/told")")
tells "a status prompt that brings it back" "$told" "Handoffs from people in it arrive in this conversation"
never "a status prompt that brings it back" "$told" "not receiving"
receiving "a status prompt that brings it back"
stops "ended disconnected"
rm -f "$dir/status-live"

for how in "ended disconnected" "ended replaced" "ended meeting_ended" "ended agent_exited" "error not_connected 5" \
	"error agent_unverified 4"; do
	reset
	both answers-first "connect blixel"
	receiving "a connect"
	stops "$how"
	not_again "after $how, nothing comes back"
	silent "after $how, no state" "$(ls "$dir/data")"
done

# A disconnect ends the receiver, and nothing restarts it.
reset
both answers-first "connect blixel"
receiving "a connect"
first=$host
both together '$blixel:disconnect'
wait "$host"
host=$first
stops "ended disconnected"
not_again "after a typed disconnect, nothing comes back"

# Another receiver of this session is live: the second ends at once and keeps the flag.
reset
both answers-first "connect blixel"
receiving "a connect"
first=$host
: >"$log"
typed "fix the build" >"$dir/asked"
/bin/zsh -c "$receives" <"$dir/asked" &
until_true "a second receiver" stopped $!
logged "agent receive" || fail "a second receiver was not tried"
flagged || fail "received elsewhere drops the flag"
host=$first
stops "ended disconnected"

# A connection ends with its Codex process, which can quit with no chance to clear this.
reset
mkdir "$dir/data/$thread"
echo 1 >"$dir/data/$thread/connected"
not_again "a thread resumed in another process"
silent "a thread resumed in another process drops its state" "$(ls "$dir/data")"

mkdir "$dir/data/$thread"
echo 1 >"$dir/data/$thread/connected"
both answers-first "connect blixel"
receiving "a resumed thread connects"
[ "$(cat "$dir/data/$thread/connected")" = $$ ] || fail "the flag names another process"
stops "ended disconnected"

reset
both answers-first "connect blixel"
receiving "a connect"
first=$host
: >"$log"
typed "fix the build" "$other" >"$dir/asked"
/bin/zsh -c "$receives" <"$dir/asked" &
wait $!
silent "another thread" "$(cat "$log")"
host=$first
stops "ended disconnected"

reset
mkdir "$dir/data/$other"
touch -t 202001010000 "$dir/data/$other"
both answers-first "connect blixel"
receiving "a connect"
never "a quit session's state" "$(ls "$dir/data")" "$other"
stops "ended disconnected"

# Whatever a prompt says stays data, in a session whose filters read it.
reset
mkdir "$dir/data/$thread"
echo "$$" >"$dir/data/$thread/connected"
mark="touch $dir/pwned"
for words in "\$($mark)" "\`$mark\`" "; $mark" "\$blixel:\$($mark)" "\\\"; $mark; \\\""; do
	silent "$words" "$(prompt "$words")"
done
[ ! -e "$dir/pwned" ] || fail "a hook ran text"

# Past the filter's limit `exec` would fail, and the hook with it.
reset
mkdir "$dir/data/$thread"
echo "$$" >"$dir/data/$thread/connected"
python3 -c 'import sys; print("{\"session_id\":\"%s\",\"prompt\":\"connect blixel%s\"}" % (sys.argv[1], " " * 1200000), end="")' "$thread" >"$dir/typed"
for command in "$answers" "$receives"; do
	said=$("$dir/host" "$command" "$dir/typed" 2>&1) || fail "a huge prompt failed its hook"
	silent "a huge prompt" "$said"
done
silent "a huge prompt" "$(cat "$log")"

# The receiver writes to the hook, which reads to the end, never to the streams Codex
# gave the hook: nothing there need read them for it to go on.
reset
both answers-first "connect blixel" >"$dir/hook-out" 2>&1
receiving "a connect"
receiver=$(cat "$dir"/receiver.*)
stream() { /usr/sbin/lsof -a -p "$1" -d "$2" -Fdin | sed 1d | tr '\n' ' '; }
for fd in 1 2; do
	[ "$(stream "$receiver" "$fd")" != "$(stream "$host" 1)" ] || fail "the receiver's fd $fd is Codex's"
	[ "$(stream "$receiver" "$fd")" != "$(stream "$host" 2)" ] || fail "the receiver's fd $fd is Codex's"
done
stops "ended disconnected"

# Hooks run outside the sandbox, and a session's PATH can hold a folder it writes.
reset
mkdir -p "$dir/planted"
for tool_name in blixel cat codex find grep lsof md5 mkdir plutil ps rm rmdir sed tail touch tr; do
	printf '#!/bin/sh\necho %s "$*" >>"%s/planted.ran"\n' "$tool_name" "$dir" >"$dir/planted/$tool_name"
	chmod +x "$dir/planted/$tool_name"
done
export SESSION_PATH="$dir/planted:$PATH"
both answers-first "connect blixel"
receiving "a connect"
stops "ended disconnected"
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
[ "$(plutil -extract hooks raw -o - "$hooks")" = UserPromptSubmit ] || fail "hooks other than UserPromptSubmit: $(plutil -extract hooks raw -o - "$hooks")"
[ "$(plutil -extract hooks.UserPromptSubmit raw -o - "$hooks")" = 1 ] &&
	[ "$(plutil -extract hooks.UserPromptSubmit.0.hooks raw -o - "$hooks")" = 2 ] || fail "not two hooks"
plutil -extract hooks.UserPromptSubmit.0.hooks.0.async raw -o - "$hooks" >/dev/null 2>&1 &&
	fail "hook 1 is async, so cannot end the turn"
[ "$(plutil -extract hooks.UserPromptSubmit.0.hooks.1.async raw -o - "$hooks")" = true ] || fail "hook 2 not async"
[ "$(plutil -extract hooks.UserPromptSubmit.0.hooks.1.timeout raw -o - "$hooks")" -ge 2592000 ] || fail "hook 2 dies"
# Review hooks shows these; the plan words them.
[ "$(plutil -extract hooks.UserPromptSubmit.0.hooks.0.statusMessage raw -o - "$hooks")" = \
	"Blixel: connect, status and disconnect when you type them" ] || fail "hook 1's statusMessage"
[ "$(plutil -extract hooks.UserPromptSubmit.0.hooks.1.statusMessage raw -o - "$hooks")" = \
	"Blixel: receive handoffs after you type connect" ] || fail "hook 2's statusMessage"

# Codex's trust covers its whole root, so that root holds a copy of what it shares
# with Claude Code: `scripts/codex-skills.sh` writes it.
diff -r "$root/../skills" "$root/skills" >"$dir/copy" || fail "codex/skills is stale: $(cat "$dir/copy")"
for skill in connect status disconnect; do
	[ -f "$root/codex-skills/$skill/SKILL.md" ] || fail "no \$blixel:$skill"
	grep -q 'allow_implicit_invocation: false' "$root/codex-skills/$skill/agents/openai.yaml" ||
		fail "the model can pick \$blixel:$skill"
done
[ ! -e "$root/commands" ] || fail "Codex would make skills of commands/"
grep -n -i 'ask\b\|direct\|--approval\|monitor_not_running' "$root/codex-skills/connect/SKILL.md" >"$dir/stale" &&
	fail "the connect entry offers what is gone: $(cat "$dir/stale")"
grep -q 'references/codex.md' "$root/codex-skills/connect/SKILL.md" ||
	fail "the connect entry does not send the model to the Codex reference"

# A command Codex runs outside its sandbox and looks up on PATH runs what a folder
# there holds, which the sandbox may have written: what the skills give it is a path.
full=/Applications/Blixel.app/Contents/Resources/bin/blixel
for file in skills/connect-agent/references/codex.md codex-skills/connect/SKILL.md; do
	grep -qF "$full" "$root/$file" || fail "$file: no full path to connect by"
done
grep -q "prefix_rule: \[\"$full\", \"agent\", \"connect\"\]" "$root/skills/connect-agent/references/codex.md" ||
	fail "the rule a session saves is not on the full path"
grep -rn 'prefix_rule[^[]*\["blixel"\|require_escalated.*`blixel \|run `blixel agent connect` at once' "$root/skills" "$root/codex-skills" >"$dir/bare" &&
	fail "a bare blixel outside the sandbox: $(cat "$dir/bare")"

[ "$failed" = 0 ] && echo "codex-hooks: pass"
exit "$failed"
