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
trap 'exec 3>&-; kill "$pi" 2>/dev/null; rm -rf "$dir"' EXIT
failed=0
log=$dir/log
heard=$dir/heard
mkdir "$dir/bin" "$dir/planted" "$dir/handoffs" "$dir/agent"

# Stands in for `blixel`: logs each call with who made it, and a relay runs its submit
# on whatever lands in handoffs/.
cat >"$dir/bin/blixel" <<STANDIN
#!/bin/sh
dir=$dir
STANDIN
cat >>"$dir/bin/blixel" <<'STANDIN'
echo "$* pid=$BLIXEL_AGENT_PID key=$BLIXEL_AGENT_SESSION_KEY provider=$BLIXEL_AGENT_PROVIDER name=$BLIXEL_AGENT_NAME" >>"$dir/log"
case $2 in
relay)
	echo "$$" >"$dir/relay"
	echo "$BLIXEL_PI_SOCKET" >"$dir/socket"
	trap 'echo "relay stopped" >>"$dir/log"; exit 0' TERM
	while [ ! -e "$dir/end-relay" ]; do
		for file in "$dir"/handoffs/*; do
			[ -f "$file" ] || continue
			"$4" "$(cat "$file")"
			echo "submit exit=$?" >>"$dir/log"
			rm -f "$file"
		done
		sleep 0.02
	done
	rm -f "$dir/end-relay"
	;;
connect) cat "$dir/connect" 2>/dev/null || echo '{"data":{"outcome":"connected"}}' ;;
disconnect) echo '{"data":{"outcome":"disconnected"}}' ;;
status) cat "$dir/status" 2>/dev/null || echo '{"data":{"meeting_id":"m-1","session":{"connection_id":"c-1"}}}' ;;
esac
STANDIN
chmod +x "$dir/bin/blixel"

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
server.listen($port, "127.0.0.1");
server.unref();

export default function (pi: any) {
	const hear = (o: any) => fs.appendFileSync("$heard", JSON.stringify(o) + "\n");
	pi.on("input", (e: any) => {
		hear({ input: e.text, source: e.source, behind: e.streamingBehavior });
		fs.writeFileSync("$dir/last-input", e.text);
	});
	pi.on("before_provider_request", async (e: any) => {
		if (fs.existsSync("$dir/hold")) hear({ held: true });
		while (fs.existsSync("$dir/hold")) await new Promise((wake) => setTimeout(wake, 20));
		const body = JSON.stringify(e.payload);
		hear({ sent: JSON.stringify(e.payload.messages.at(-1)), rules: body.includes("they connected it to receive handoffs") });
	});
}
LISTEN

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
	submits=$(grep -c '^submit exit=' "$log")
	printf '%s' "$1" >"$dir/next"
	mv "$dir/next" "$dir/handoffs/next"
	waits_for submitted || fail "no submit for: $1"
}
submitted() { [ "$(grep -c '^submit exit=' "$log")" -gt "$submits" ]; }

alive() { kill -0 "$(cat "$dir/relay")" 2>/dev/null; }
gone() { ! alive; }

# Install

PI_CODING_AGENT_DIR="$dir/agent" pi install "$root" >/dev/null 2>"$dir/err" || fail "pi install: $(cat "$dir/err")"

export BLIXEL_HOOK_PATH="$dir/bin:/usr/bin:/bin:/usr/sbin:/sbin"
: >"$log"
start_pi

: >"$dir/out"
rpc '{"type":"get_commands","id":"commands"}'
waits_for holds "$dir/out" '"id":"commands"' || fail "no commands"
for name in blixel:connect blixel:status blixel:disconnect skill:blixel skill:connect-agent; do
	holds "$dir/out" "\"name\":\"$name\"" || fail "not installed: $name"
done

# Nothing runs in a session until the user connects

reaches_pi "good morning"
[ ! -s "$log" ] || fail "ran before any connect: $(cat "$log")"
holds "$heard" '"rules":false' || fail "a session not connected carries the rules"

says "/blixel:connect tomorrow" "Usage: /blixel:connect [ask|direct]"
[ ! -s "$log" ] || fail "a bad approval ran: $(cat "$log")"

echo '{"data":{"meeting_id":"m-1","session":{}}}' >"$dir/status"
says "/blixel:status" "not connected to the Blixel meeting"
logged "agent status pid=$pi key=$key provider=pi name=pi" || fail "status: wrong session: $(cat "$log")"
rm "$dir/status"

# Connect

: >"$log"
says "/blixel:connect direct" "Connected to the Blixel meeting"
logged "agent relay --submit $root/pi/submit.sh pid=$pi key=$key provider=pi name=pi" || fail "relay: $(cat "$log")"
logged "agent connect --approval direct pid=$pi key=$key provider=pi name=pi" || fail "connect: $(cat "$log")"

# A handoff runs as a prompt, exact, and whatever it says, only as a prompt

text='First line.
Second line, after a break.

  -dash "quoted" $HOME `tick` é✦'
handoff "$text"
logged "submit exit=0" || fail "a handoff pi took was not queued: $(cat "$log")"
waits_for holds "$heard" '"source":"extension"' || fail "the handoff is no prompt"
[ "$(cat "$dir/last-input")" = "$text" ] || fail "the handoff changed on the way: $(cat "$dir/last-input")"

: >"$dir/out"
for said in "disconnect blixel" "/blixel:disconnect" "BLIXEL STATUS"; do
	handoff "$said"
	waits_for holds "$heard" "{\"input\":\"$said\",\"source\":\"extension\"}" || fail "$said: not a prompt"
done
never "a handoff saying a phrase" "agent disconnect"
never "a handoff saying a phrase" "agent status"
if holds "$dir/out" '"method":"notify"'; then fail "a handoff saying a phrase was answered"; fi
alive || fail "a handoff saying a phrase stopped the relay"

waits_for holds "$heard" '"rules":true' || fail "the rules did not reach a connected session"

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
says "BLIXEL:CONNECT ask" "Connected to the Blixel meeting"
logged "agent connect --approval ask" || fail "phrase with an approval: $(cat "$log")"
[ "$(grep -c 'agent relay' "$log")" = 0 ] || fail "connecting again started a second relay"

: >"$log"
for words in "connect blixel please" "please connect blixel" "disconnect blixel ask" "blixel status direct"; do
	reaches_pi "$words"
done
[ ! -s "$log" ] || fail "words beside a phrase ran: $(cat "$log")"

# Disconnect stops everything

: >"$heard"
says "disconnect blixel" "Disconnected from the Blixel meeting"
waits_for gone || fail "disconnect left the relay running"
[ ! -e "$(cat "$dir/socket")" ] || fail "disconnect left the socket"
reaches_pi "after disconnecting"
if holds "$heard" '"rules":true'; then fail "the rules outlived the connection"; fi

# A connect that fails leaves nothing

echo '{"error":{"message":"Blixel is not in a meeting","hint":"Join a room first."}}' >"$dir/connect"
says "connect blixel" "Blixel did not connect: Blixel is not in a meeting Join a room first."
waits_for gone || fail "a failed connect left the relay running"
says "connect blixel" "Blixel did not connect"
rm "$dir/connect"
says "connect blixel" "Connected to the Blixel meeting"
sleep 0.2
alive || fail "the relay a failed connect stopped took its successor along"
says "disconnect blixel" "Disconnected from the Blixel meeting"

# Another session taking over ends the relay, and quitting then has nothing to end

says "connect blixel" "Connected to the Blixel meeting"
: >"$log"
: >"$dir/end-relay"
waits_for gone || fail "the relay did not end"
reaches_pi "taken over"
sleep 0.1

stop_pi
never "a session its relay left" "agent disconnect"

# Quitting ends the connection

start_pi
says "/blixel:connect" "Connected to the Blixel meeting"
: >"$log"
stop_pi
logged "agent disconnect pid=$pi key=$key" || fail "quitting did not disconnect: $(cat "$log")"
logged "relay stopped" || fail "quitting left the relay running"
[ ! -e "$(cat "$dir/socket")" ] || fail "quitting left the socket"

# The model does all of it by itself, in a session nothing else has touched

model_runs() { # a command for the model's bash tool
	: >"$dir/out"
	printf '%s' "$1" >"$dir/model-runs"
	rpc "{\"type\":\"prompt\",\"message\":\"do it\"}"
	waits_for holds "$dir/out" '"type":"tool_execution_end"' || fail "the model ran nothing: $1"
	waits_for holds "$dir/out" '"type":"agent_end"' || fail "no run ended: $1"
}

: >"$log"
start_pi
model_runs 'grep "blixel agent connect" /dev/null'
never "a mention of connect" "agent relay"

model_runs "\"$dir/bin/blixel\" agent status"
logged "agent status pid=$pi key=$key provider=pi name=pi" || fail "the model's status: wrong session: $(cat "$log")"
model_runs "\"$dir/bin/blixel\" agent connect"
logged "agent connect pid=$pi key=$key provider=pi name=pi" || fail "the model's connect: wrong session: $(cat "$log")"
logged "agent relay --submit $root/pi/submit.sh pid=$pi key=$key provider=pi name=pi" ||
	fail "the model's connect started no relay: $(cat "$log")"
waits_for alive || fail "the model's connect left no relay running"
: >"$log"
model_runs "\"$dir/bin/blixel\" agent connect"
[ "$(grep -c 'agent relay' "$log")" = 0 ] || fail "the model's second connect started a second relay"
handoff "after the model connected"
logged "submit exit=0" || fail "a handoff did not reach pi after the model connected"
model_runs "\"$dir/bin/blixel\" agent disconnect"
logged "agent disconnect pid=$pi key=$key" || fail "the model's disconnect: wrong session: $(cat "$log")"
: >"$dir/end-relay"
waits_for gone || fail "the relay outlived the model's disconnect"
stop_pi

# Nobody to take a handoff: that is doubt, never queued

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
