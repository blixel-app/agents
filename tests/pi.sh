#!/bin/sh
# The pi package, installed into real pi and driven over its RPC mode, against a
# stand-in `blixel` and a stand-in model: `claude plugin test` has no processes, and no
# fake of pi can show what pi does with a prompt.
root=$(cd "$(dirname "$0")/.." && pwd -P)
command -v pi >/dev/null || {
	echo "pi: skipped, pi is not installed"
	exit 0
}
dir=$(mktemp -d)
dir=$(cd "$dir" && pwd -P)
trap 'exec 3>&-; kill "$pi" 2>/dev/null; pkill -f "$dir/bin/blixel"; rm -rf "$dir"' EXIT
failed=0
log=$dir/log
heard=$dir/heard
mkdir "$dir/bin" "$dir/planted" "$dir/handoffs" "$dir/agent" "$dir/gate"

# Stands in for `blixel`, as the real CLI answers: the session is the one PI_SESSION_ID
# names, or the variable `--session-env` names; a meeting has one connection, and
# connecting replaces another session's; `receive` refuses a session with no connection
# (`not_connected`, exit 5), ends at once with `received_elsewhere` beside a live
# receiver, and otherwise prints `receiving`, runs its program once for each file in
# handoffs/, and ends with `ended` when the connection does. The test makes it stop with
# a word by writing `ended <reason>` or `error <code> <exit status>` to stops; SIGTERM
# stops it with none, exit 143. Attaching and stopping take a moment, as the real
# one's do. Each call is logged with its session and parent.
cat >"$dir/bin/blixel" <<STANDIN
#!/bin/sh
dir=$dir
STANDIN
cat >>"$dir/bin/blixel" <<'STANDIN'
key=$PI_SESSION_ID
named=
for arg; do
	[ "$named" != next ] || eval "key=\${$arg}" named=
	[ "$arg" != --session-env ] || named=next
done
echo "$1 $2${3:+ $3}${4:+ $4} session=$key parent=$PPID" >>"$dir/log"
event() { printf '{"data":%s,"event":"%s","schema_version":1}\n' "$2" "$1"; }
live() { [ -f "$dir/receiver" ] && kill -0 "$(cat "$dir/receiver")" 2>/dev/null; }
receiving() { if live && [ -f "$dir/attached" ]; then echo true; else echo false; fi; }
connected=$(cat "$dir/connection" 2>/dev/null)
case $2 in
connect)
	echo '{"data":{"request_id":"r-1"},"event":"request_id","schema_version":1}' >&2
	if [ -f "$dir/connect" ]; then
		cat "$dir/connect" >&2
		exit 5
	fi
	replaced=false
	[ -z "$connected" ] || [ "$connected" = "$key" ] || replaced=true
	echo "$key" >"$dir/connection"
	printf '{"data":{"outcome":"connected","receiving":%s,"replaced":%s,"connection":{"connection_id":"c-%s","provider":"pi"}},"schema_version":1}\n' \
		"$(receiving)" "$replaced" "$key"
	;;
status)
	session='{}'
	[ "$connected" != "$key" ] || session="{\"connected\":true,\"receiving\":$(receiving),\"connection_id\":\"c-$key\"}"
	[ -z "$connected" ] || connection=",\"connection\":{\"connection_id\":\"c-$connected\"}"
	printf '{"data":{"meeting_id":"m-1","session":%s%s},"schema_version":1}\n' "$session" "$connection"
	;;
disconnect)
	if [ -n "$connected" ] && [ "$connected" = "$key" ]; then
		rm -f "$dir/connection"
		echo '{"data":{"outcome":"disconnected","connection_id":"c-'"$key"'"},"schema_version":1}'
	else
		echo '{"data":{"outcome":"not_connected"},"schema_version":1}'
	fi
	;;
receive)
	if [ -z "$connected" ] || [ "$connected" != "$key" ]; then
		echo '{"error":{"code":"not_connected","message":"This session is not connected to the meeting","hint":"Run `blixel agent connect` first."}}' >&2
		exit 5
	fi
	if live; then
		event ended '{"reason":"received_elsewhere"}'
		exit 0
	fi
	echo "$$" >"$dir/receiver"
	echo "$BLIXEL_PI_SOCKET" >"$dir/socket"
	trap 'echo "receive stopped" >>"$dir/log"; sleep 0.3; rm -f "$dir/receiver" "$dir/attached"; exit 143' TERM
	sleep 0.2
	: >"$dir/attached"
	event receiving "{\"connection_id\":\"c-$key\"}"
	n=0
	while :; do
		now=$(cat "$dir/connection" 2>/dev/null)
		if [ "$now" != "$key" ]; then
			rm -f "$dir/receiver" "$dir/attached"
			if [ -n "$now" ]; then event ended '{"reason":"replaced"}'; else event ended '{"reason":"disconnected"}'; fi
			exit 0
		fi
		if [ -f "$dir/stops" ]; then
			read -r how code status <"$dir/stops"
			rm -f "$dir/stops" "$dir/receiver" "$dir/attached"
			case $how in
			ended) event ended "{\"reason\":\"$code\"}"; exit 0 ;;
			*) echo "{\"error\":{\"code\":\"$code\",\"message\":\"It stopped\",\"hint\":\"Try again.\"}}" >&2; exit "$status" ;;
			esac
		fi
		for file in "$dir"/handoffs/*; do
			[ -f "$file" ] || continue
			n=$((n + 1))
			BLIXEL_HANDOFF_ID=$n BLIXEL_HANDOFF_SENDER=Ana BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$key \
				BLIXEL_AGENT_PROVIDER=pi "$4" "$(cat "$file")" </dev/null >/dev/null 2>&1
			code=$?
			echo "submit exit=$code" >>"$dir/log"
			case $code in 0) state=delivered ;; 69) state=failed ;; *) state=unknown ;; esac
			event delivered "{\"id\":\"$n\",\"state\":\"$state\"}"
			rm -f "$file"
		done
		sleep 0.02
	done
	;;
esac
STANDIN
chmod +x "$dir/bin/blixel"
cli=$dir/bin/blixel

printf '#!/bin/sh\necho "$*" >>"%s/planted-ran"\n' "$dir" >"$dir/planted/blixel"
chmod +x "$dir/planted/blixel"

echo '{"retry":{"enabled":false}}' >"$dir/agent/settings.json"
port=$((30000 + $$ % 20000))
cat >"$dir/agent/models.json" <<MODELS
{"providers":{"stub":{"baseUrl":"http://127.0.0.1:$port/v1","api":"openai-completions","apiKey":"none","models":[{"id":"none"}]}}}
MODELS

# Hears each input before the package does, and each request after it.
cat >"$dir/listen.ts" <<LISTEN
import * as fs from "node:fs";
import * as http from "node:http";

// The model: runs what model-runs holds with the bash tool, and answers nothing else.
const chunk = (delta: any, finish_reason: any = null) =>
	"data: " + JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
const server = http.createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		if (!fs.existsSync("$dir/model-runs")) return void request.socket.destroy();
		const command = fs.readFileSync("$dir/model-runs", "utf8");
		fs.rmSync("$dir/model-runs");
		const call = { index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
	});
});
// A reload loads this file again, and its server is already listening.
server.on("error", () => {});
server.listen($port, "127.0.0.1");
server.unref();

export default function (pi: any) {
	const hear = (o: any) => fs.appendFileSync("$heard", JSON.stringify(o) + "\n");
	pi.on("input", (e: any) => {
		// Before it is heard, as the test reads it once it is.
		fs.writeFileSync("$dir/last-input", e.text);
		hear({ input: e.text, source: e.source, behind: e.streamingBehavior });
	});
	pi.on("before_provider_request", async (e: any) => {
		if (fs.existsSync("$dir/hold")) hear({ held: true });
		while (fs.existsSync("$dir/hold")) await new Promise((wake) => setTimeout(wake, 20));
		const last = e.payload.messages.at(-1);
		hear({ sent: JSON.stringify(last) });
		if (last.role === "tool") fs.writeFileSync("$dir/model-read", typeof last.content === "string" ? last.content : JSON.stringify(last.content));
	});
	pi.registerCommand("test-reload", { handler: async (_args: any, ctx: any) => ctx.reload() });
}
LISTEN

# A permission gate, as a package installed after Blixel's, so it decides after anything
# Blixel's extension does in tool_call: with gate-blocks it blocks every bash call.
echo '{"name":"gate","pi":{"extensions":["./gate.ts"]}}' >"$dir/gate/package.json"
cat >"$dir/gate/gate.ts" <<GATE
import * as fs from "node:fs";

export default function (pi: any) {
	pi.on("tool_call", () => (fs.existsSync("$dir/gate-blocks") ? { block: true, reason: "Blocked by user" } : undefined));
}
GATE

fail() { echo "FAIL: $1"; failed=1; }

waits_for() { # the check, as a command
	tries=0
	until "$@"; do
		tries=$((tries + 1))
		[ "$tries" -lt 400 ] || return 1
		sleep 0.02
	done
}

holds() { grep -qF -- "$2" "$1" 2>/dev/null; }
logged() { holds "$log" "$1"; }
never() { # name, text
	if logged "$2"; then fail "$1: ran \"$2\""; fi
}
count() { grep -c -- "$1" "$log"; }

start_pi() {
	: >"$dir/out"
	rm -f "$dir/in"
	mkfifo "$dir/in"
	(cd "$dir" && exec env PI_CODING_AGENT_DIR="$dir/agent" PI_SKIP_VERSION_CHECK=1 PATH="$dir/planted:$PATH" "$@" \
		pi --mode rpc --no-session --tools bash --model stub/none -e "$dir/listen.ts" <"$dir/in" >>"$dir/out" 2>"$dir/err") &
	pi=$!
	exec 3>"$dir/in"
	rpc '{"type":"get_state","id":"state"}'
	waits_for holds "$dir/out" '"id":"state"' || fail "pi did not start: $(tail -n 3 "$dir/err")"
	key=$(sed -n 's/.*"id":"state".*"sessionId":"\([^"]*\)".*/\1/p' "$dir/out")
}

# SIGTERM, as Node on macOS hears no end of input on a FIFO.
stop_pi() {
	exec 3>&-
	kill "$pi"
	wait "$pi"
}

rpc() { printf '%s\n' "$1" >&3; }

says() { # what is typed; what pi must show. Pi's answer is the only one since the last.
	: >"$dir/out"
	rpc "{\"type\":\"prompt\",\"message\":\"$1\"}"
	waits_for holds "$dir/out" '"method":"notify"' || fail "$1: no answer"
	holds "$dir/out" "$2" || fail "$1: no \"$2\" in $(grep -aF '"notify"' "$dir/out")"
}

reaches_pi() { # what is typed; pi must take it as a prompt, and nothing of ours answer
	: >"$dir/out"
	rpc "{\"type\":\"prompt\",\"message\":\"$1\"}"
	waits_for holds "$dir/out" '"type":"agent_end"' || fail "$1: no run ended"
	sent "$1" || fail "$1: never reached the model"
}
sent() { grep -aF '{"sent":' "$heard" | grep -qF -- "$1"; }

handoff() { # the text; waits for its submit
	submits=$(count '^submit exit=')
	printf '%s' "$1" >"$dir/next"
	mv "$dir/next" "$dir/handoffs/next"
	waits_for submitted || fail "no submit for: $1"
}
submitted() { [ "$(count '^submit exit=')" -gt "$submits" ]; }

alive() { kill -0 "$(cat "$dir/receiver" 2>/dev/null)" 2>/dev/null; }
gone() { ! alive; }
stops() { # how the receiver stops: `ended <reason>` or `error <code> <exit status>`
	echo "$1" >"$dir/stops"
	waits_for test ! -e "$dir/stops" || fail "the receiver never read: $1"
}
receives_again() { # name; a new receive since the log was emptied, and no connect
	waits_for logged "agent receive" || fail "$1: no receive again"
	never "$1" "agent connect"
	waits_for alive || fail "$1: no receiver"
}
stays_stopped() { # name; nothing receives past where a restart would come: 1 s after a
	# receiver that attached, 2 s after one that never did
	sleep 2.3
	never "$1" "agent receive"
	gone || fail "$1: a receiver runs"
}

# Install

PI_CODING_AGENT_DIR="$dir/agent" pi install "$root" >/dev/null 2>"$dir/err" || fail "pi install: $(cat "$dir/err")"
PI_CODING_AGENT_DIR="$dir/agent" pi install "$dir/gate" >/dev/null 2>"$dir/err" || fail "pi install gate: $(cat "$dir/err")"

export BLIXEL_HOOK_PATH="$dir/bin:/usr/bin:/bin:/usr/sbin:/sbin"
: >"$log"
start_pi

: >"$dir/out"
rpc '{"type":"get_commands","id":"commands"}'
waits_for holds "$dir/out" '"id":"commands"' || fail "no commands"
for name in blixel:connect blixel:status blixel:disconnect skill:blixel skill:connect-agent; do
	holds "$dir/out" "\"name\":\"$name\"" || fail "not installed: $name"
done
if holds "$dir/out" "[ask|direct]"; then fail "a command still offers ask or direct"; fi

# Nothing runs in a session until the user connects

reaches_pi "good morning"
[ ! -s "$log" ] || fail "ran before any connect: $(cat "$log")"

says "/blixel:connect direct" "Usage: /blixel:connect"
[ ! -s "$log" ] || fail "a connect with words after it ran: $(cat "$log")"

says "/blixel:status" "not connected to the Blixel meeting"
logged "agent status session=$key parent=$pi" || fail "status: wrong session: $(cat "$log")"

# Connect, then receive, with no model

: >"$log"
says "/blixel:connect" "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
logged "agent connect session=$key parent=$pi" || fail "connect: $(cat "$log")"
logged "agent receive --deliver-with $root/pi/submit.sh session=$key parent=$pi" || fail "receive: $(cat "$log")"
[ "$(cut -d ' ' -f 2 "$log" | tr '\n' ' ')" = "connect receive " ] || fail "connect did not come before receive: $(cat "$log")"
never "connect" "--approval"
alive || fail "connect left no receiver running"
says "/blixel:status" "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation."

# A handoff runs as a prompt, exact, and whatever it says, only as a prompt

text='First line.
Second line, after a break.

  -dash "quoted" $HOME `tick` é✦'
handoff "$text"
logged "submit exit=0" || fail "a handoff pi took was not delivered: $(cat "$log")"
waits_for holds "$heard" '"source":"extension"' || fail "the handoff is no prompt"
[ "$(cat "$dir/last-input")" = "$text" ] || fail "the handoff changed on the way: $(cat "$dir/last-input")"

: >"$dir/out"
: >"$log"
for said in "disconnect blixel" "/blixel:disconnect" "BLIXEL STATUS"; do
	handoff "$said"
	waits_for holds "$heard" "{\"input\":\"$said\",\"source\":\"extension\"}" || fail "$said: not a prompt"
done
never "a handoff saying a phrase" "agent disconnect"
never "a handoff saying a phrase" "agent status"
if holds "$dir/out" '"method":"notify"'; then fail "a handoff saying a phrase was answered"; fi
alive || fail "a handoff saying a phrase stopped the receiver"

: >"$dir/hold"
: >"$dir/out"
rpc '{"type":"prompt","message":"a turn in progress"}'
waits_for holds "$heard" '{"held":true}' || fail "no turn in progress"
handoff "after that turn"
waits_for holds "$heard" '{"input":"after that turn","source":"extension","behind":"followUp"}' ||
	fail "a handoff during a turn must wait for it: $(tail -n 1 "$heard")"
rm "$dir/hold"
waits_for holds "$dir/out" '"type":"agent_settled"' || fail "the turn did not end"

# Phrases, whole and in any case

: >"$log"
says "Blixel Status" "Blixel"
logged "agent status" || fail "phrase in capitals ran no status"
says "BLIXEL:CONNECT" "Connected to the Blixel meeting"
logged "agent connect" || fail "phrase in capitals ran no connect: $(cat "$log")"
[ "$(count 'agent receive')" = 0 ] || fail "connecting again started a second receiver"

: >"$log"
for words in "connect blixel please" "please connect blixel" "connect blixel ask" "blixel connect direct"; do
	reaches_pi "$words"
done
[ ! -s "$log" ] || fail "words beside a phrase ran: $(cat "$log")"

# A receiver that stops with no word starts again, with no connect

: >"$log"
kill -9 "$(cat "$dir/receiver")"
receives_again "a killed receiver"
handoff "after a restart"
logged "submit exit=0" || fail "a handoff after a restart was not delivered"

: >"$log"
stops "error cancelled 143"
receives_again "a cancelled receiver"

# A receiver that stops with a word stays stopped

: >"$log"
: >"$dir/out"
stops "error app_unavailable 5"
waits_for holds "$dir/out" "Blixel stopped receiving handoffs: It stopped Try again." ||
	fail "a failed receiver said nothing: $(grep -aF '"notify"' "$dir/out")"
stays_stopped "a receiver that failed"
says "/blixel:status" "Connected to the Blixel meeting, but not receiving its handoffs. Type /blixel:connect to receive them."
says "connect blixel" "Connected to the Blixel meeting. Handoffs from people in it will arrive"
alive || fail "connecting again started no receiver"

: >"$log"
stops "ended meeting_ended"
stays_stopped "a receiver whose meeting ended"

says "connect blixel" "Connected to the Blixel meeting"
: >"$log"
: >"$dir/out"
rm "$dir/connection"
kill -9 "$(cat "$dir/receiver")"
waits_for logged "agent receive" || fail "no receive after a kill"
: >"$log"
stays_stopped "a receiver refused not_connected"
if holds "$dir/out" "Blixel stopped receiving handoffs"; then fail "a receiver refused not_connected said it failed"; fi

# Another receiver holds the session

says "connect blixel" "Connected to the Blixel meeting"
kill -9 "$(cat "$dir/receiver")"
sleep 30 &
echo "$!" >"$dir/receiver"
other=$!
: >"$log"
waits_for logged "agent receive" || fail "no receive after a kill"
: >"$log"
sleep 2.3
never "a receiver beside another" "agent receive"
says "connect blixel" "Connected to the Blixel meeting. Another receiver in this session takes its handoffs."
kill "$other"
wait "$other" 2>/dev/null
rm -f "$dir/receiver"

# Disconnect stops everything

says "connect blixel" "Connected to the Blixel meeting"
: >"$log"
says "disconnect blixel" "Disconnected from the Blixel meeting"
waits_for gone || fail "disconnect left the receiver running"
[ ! -e "$(cat "$dir/socket")" ] || fail "disconnect left the socket"
stays_stopped "a disconnected session"
says "connect blixel" "Connected to the Blixel meeting"
says "disconnect blixel" "Disconnected from the Blixel meeting"
says "connect blixel" "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
alive || fail "connecting again at once after a disconnect started no receiver"
says "disconnect blixel" "Disconnected from the Blixel meeting"
waits_for gone || fail "disconnect left the receiver running"

# A connect that fails leaves nothing

echo '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting","hint":"Join a room first."}}' >"$dir/connect"
: >"$log"
says "connect blixel" "Blixel did not connect: Blixel is not in a meeting Join a room first."
never "a failed connect" "agent receive"
rm "$dir/connect"

# Another session taking over ends the receiver, and quitting then has nothing to end

says "connect blixel" "Connected to the Blixel meeting"
: >"$log"
echo other >"$dir/connection"
waits_for gone || fail "the receiver did not end"
stays_stopped "a replaced session"
stop_pi
never "a session another one replaced" "agent disconnect"
rm "$dir/connection"

# A reload receives again, with no connect

start_pi
says "/blixel:connect" "Connected to the Blixel meeting"
: >"$log"
: >"$dir/out"
rpc '{"type":"prompt","message":"/test-reload"}'
waits_for logged "receive stopped" || fail "the reload left the old receiver running"
receives_again "a reload"
never "a reload" "agent disconnect"
handoff "after a reload"
waits_for holds "$heard" '{"input":"after a reload","source":"extension"' || fail "a handoff after a reload never reached pi"

# Quitting ends the connection

: >"$log"
stop_pi
logged "agent disconnect session=$key" || fail "quitting did not disconnect: $(cat "$log")"
waits_for logged "receive stopped" || fail "quitting left the receiver running"
[ ! -e "$(cat "$dir/socket")" ] || fail "quitting left the socket"

# The model does all of it by itself, in a session nothing else has touched

model_runs() { # a command for the model's bash tool
	: >"$dir/out"
	: >"$heard"
	printf '%s' "$1" >"$dir/model-runs"
	rpc "{\"type\":\"prompt\",\"message\":\"do it\"}"
	waits_for holds "$dir/out" '"type":"tool_execution_end"' || fail "the model ran nothing: $1"
	waits_for holds "$dir/out" '"type":"agent_end"' || fail "no run ended: $1"
}
model_read() { holds "$dir/model-read" "$1"; }

: >"$log"
start_pi
model_runs 'grep "blixel agent connect" /dev/null'
[ ! -s "$log" ] || fail "a mention of connect ran: $(cat "$log")"

model_runs "\"$cli\" agent status"
logged "agent status session=$key" || fail "the model's status: wrong session: $(cat "$log")"

: >"$dir/gate-blocks"
: >"$log"
model_runs "\"$cli\" agent connect"
rm "$dir/gate-blocks"
[ ! -s "$log" ] || fail "a connect a permission gate blocked ran: $(cat "$log")"
model_read "Blocked by user" || fail "the model did not read the gate's answer"
[ ! -e "$dir/connection" ] || fail "a connect a permission gate blocked connected"

: >"$log"
model_runs "env -u PI_SESSION_ID OTHER=o-1 \"$cli\" agent connect --session-env OTHER"
logged "agent connect --session-env OTHER session=o-1" || fail "the model's connect for another session did not run: $(cat "$log")"
never "a connect for another session" "agent receive"
[ "$(count 'agent connect')" = 1 ] || fail "a connect for another session connected this one: $(cat "$log")"
model_read '"connection_id":"c-o-1"' || fail "the model did not read its own connect's answer"
rm "$dir/connection"

echo '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting"}}' >"$dir/connect"
: >"$log"
model_runs "\"$cli\" agent connect"
rm "$dir/connect"
never "a connect that failed" "agent receive"

: >"$log"
model_runs "\"$cli\" agent connect"
logged "agent connect session=$key" || fail "the model's connect: wrong session: $(cat "$log")"
logged "agent receive --deliver-with $root/pi/submit.sh session=$key parent=$pi" ||
	fail "the model's connect was not taken over: $(cat "$log")"
model_read '"receiving":true' || fail "the model read no receiving: $(cat "$dir/model-read")"
alive || fail "the model's connect left no receiver running"
: >"$log"
model_runs "\"$cli\" agent connect"
[ "$(count 'agent receive')" = 0 ] || fail "the model's second connect started a second receiver"
handoff "after the model connected"
logged "submit exit=0" || fail "a handoff did not reach pi after the model connected"
: >"$log"
model_runs "\"$cli\" agent disconnect"
logged "agent disconnect session=$key" || fail "the model's disconnect: wrong session: $(cat "$log")"
waits_for gone || fail "the receiver outlived the model's disconnect"
stays_stopped "after the model's disconnect"
stop_pi

# Nobody to take a handoff: that is doubt, never delivered

BLIXEL_PI_SOCKET=$dir/nobody "$root/pi/submit.sh" "text" 2>/dev/null
[ "$?" = 1 ] || fail "a submit with nothing listening must answer 1"

# The CLI never comes from PATH

unset BLIXEL_HOOK_PATH
export BLIXEL_HOME=$dir/home BLIXEL_TOKEN_STORAGE=file
start_pi
: >"$dir/out"
rpc '{"type":"prompt","message":"/blixel:status"}'
waits_for holds "$dir/out" '"method":"notify"' || fail "status with no stand-in: no answer"
stop_pi
[ ! -e "$dir/planted-ran" ] || fail "ran the blixel on PATH: $(cat "$dir/planted-ran")"

[ "$failed" = 0 ] && echo "pi: pass"
exit "$failed"
