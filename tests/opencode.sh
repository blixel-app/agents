#!/bin/sh
# The OpenCode plugin, loaded into a real private server and its real terminal UI, against
# a stand-in `blixel` and a stand-in model: no fake of OpenCode can show what it does with
# a prompt. It never touches the user's own config, data or background service.
root=$(cd "$(dirname "$0")/.." && pwd -P)
command -v opencode >/dev/null || {
	echo "opencode: skipped, opencode is not installed"
	exit 0
}
dir=$(mktemp -d)
dir=$(cd "$dir" && pwd -P)
trap 'kill "$server" 2>/dev/null; pkill -f "$dir/bin/blixel"; rm -rf "$dir"' EXIT
failed=0
log=$dir/log
heard=$dir/heard
mkdir -p "$dir/bin" "$dir/planted" "$dir/handoffs" "$dir/work" "$dir/listen" "$dir/home" "$dir/config/opencode"
: >"$log"
: >"$heard"

# Stands in for `blixel`, as the real CLI answers: the session is the one
# OPENCODE_SESSION_ID names, or the variable `--session-env` names; a meeting has one
# connection, and connecting replaces another session's; `receive` refuses a session
# with no connection (`not_connected`, exit 5), ends at once with `received_elsewhere`
# beside a live receiver of that session, and otherwise prints `receiving`, runs its
# program once for each file in handoffs/<session>/, and ends with `ended` when the
# connection does. The test makes it stop with a word by writing `ended <reason>` or
# `error <code> <exit status>` to stops-<session>; SIGTERM stops it with none, exit 143.
# Attaching and stopping take a moment, as the real one's do. The program gets the
# agent process as the CLI finds it: the server. Each call is logged with its session
# and parent.
cat >"$dir/bin/blixel" <<STANDIN
#!/bin/sh
dir=$dir
STANDIN
cat >>"$dir/bin/blixel" <<'STANDIN'
key=$OPENCODE_SESSION_ID
named=
for arg; do
	[ "$named" != next ] || eval "key=\${$arg}" named=
	[ "$arg" != --session-env ] || named=next
done
echo "$1 $2${3:+ $3}${4:+ $4} session=$key parent=$PPID" >>"$dir/log"
event() { printf '{"data":%s,"event":"%s","schema_version":1}\n' "$2" "$1"; }
live() { [ -f "$dir/receiver-$key" ] && kill -0 "$(cat "$dir/receiver-$key")" 2>/dev/null; }
receiving() { if live && [ -f "$dir/attached-$key" ]; then echo true; else echo false; fi; }
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
	printf '{"data":{"outcome":"connected","receiving":%s,"replaced":%s,"connection":{"connection_id":"c-%s","provider":"opencode"}},"schema_version":1}\n' \
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
	agent=$PPID
	while [ "$agent" -gt 1 ]; do
		case $(ps -o comm= -p "$agent") in opencode | */opencode) break ;; esac
		agent=$(ps -o ppid= -p "$agent" | tr -d ' ')
	done
	mkdir -p "$dir/handoffs/$key"
	echo "$$" >"$dir/receiver-$key"
	echo "$BLIXEL_OPENCODE_SOCKET" >"$dir/socket-$key"
	trap 'echo "receive stopped $key" >>"$dir/log"; sleep 0.3; rm -f "$dir/receiver-$key" "$dir/attached-$key"; exit 143' TERM
	sleep 0.2
	: >"$dir/attached-$key"
	event receiving "{\"connection_id\":\"c-$key\"}"
	n=0
	while :; do
		now=$(cat "$dir/connection" 2>/dev/null)
		if [ "$now" != "$key" ]; then
			rm -f "$dir/receiver-$key" "$dir/attached-$key"
			if [ -n "$now" ]; then event ended '{"reason":"replaced"}'; else event ended '{"reason":"disconnected"}'; fi
			exit 0
		fi
		if [ -f "$dir/stops-$key" ]; then
			read -r how code status <"$dir/stops-$key"
			rm -f "$dir/stops-$key" "$dir/receiver-$key" "$dir/attached-$key"
			case $how in
			ended) event ended "{\"reason\":\"$code\"}"; exit 0 ;;
			*) echo "{\"error\":{\"code\":\"$code\",\"message\":\"It stopped\",\"hint\":\"Try again.\"}}" >&2; exit "$status" ;;
			esac
		fi
		for file in "$dir/handoffs/$key"/*; do
			[ -f "$file" ] || continue
			n=$((n + 1))
			BLIXEL_HANDOFF_ID=$n BLIXEL_HANDOFF_SENDER=Ana BLIXEL_AGENT_PID=$agent BLIXEL_AGENT_SESSION_KEY=$key \
				BLIXEL_AGENT_PROVIDER=opencode "$4" "$(cat "$file")" </dev/null >/dev/null 2>&1
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

model=$((30000 + $$ % 15000))
port=$((model + 1))
url=http://127.0.0.1:$port

# The model, as a plugin of its own: it runs what model-runs holds with the shell tool
# (in the background with model-background), and hears each request after the plugin
# under test added to it. Its permission hook answers each shell call as permission
# holds: `deny`, or `ask`, which waits for a reply. OpenCode asks inside the shell
# tool's `execute`, whichever plugin wraps it.
echo '{"name":"listen","main":"index.ts"}' >"$dir/listen/package.json"
cat >"$dir/listen/index.ts" <<LISTEN
import * as fs from "node:fs";
import * as http from "node:http";

const hear = (o: any) => fs.appendFileSync("$heard", JSON.stringify(o) + "\n");
const chunk = (delta: any, finish_reason: any = null) =>
	"data: " + JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
const server = http.createServer((request, response) => {
	let body = "";
	request.on("data", (data) => (body += data));
	request.on("end", async () => {
		const parsed = JSON.parse(body);
		const last = parsed.messages.at(-1);
		// A title has no tools: only a turn of the conversation counts.
		if (parsed.tools) {
			if (last.role === "tool") fs.writeFileSync("$dir/model-read", String(last.content));
			else fs.writeFileSync("$dir/last-input", String(last.content));
			hear({ sent: JSON.stringify(last), skill: body.includes("connect-agent") });
			if (fs.existsSync("$dir/hold")) hear({ held: true });
			while (fs.existsSync("$dir/hold")) await new Promise((wake) => setTimeout(wake, 20));
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (parsed.tools && last.role !== "tool" && fs.existsSync("$dir/model-runs")) {
			const command = fs.readFileSync("$dir/model-runs", "utf8");
			fs.rmSync("$dir/model-runs");
			const background = fs.existsSync("$dir/model-background") || undefined;
			const call = { index: 0, id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command, description: "run it", background }) } };
			return void response.end(chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
		}
		response.end(chunk({ role: "assistant", content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n");
	});
});
server.on("error", () => {});
server.listen($model, "127.0.0.1");
server.unref();

export default {
	id: "listen",
	async setup(ctx: any) {
		// Holds the first shell to start, between the tool call and the shell it makes.
		await ctx.shell.hook("create.before", async () => {
			if (!fs.existsSync("$dir/delay") || fs.existsSync("$dir/delayed")) return;
			fs.writeFileSync("$dir/delayed", "yes");
			while (fs.existsSync("$dir/delay")) await new Promise((wake) => setTimeout(wake, 20));
		});
		await ctx.session.hook("prompt", async () => {
			if (fs.existsSync("$dir/slow-prompt")) await new Promise((wake) => setTimeout(wake, 500));
		});
		await ctx.permission.hook("evaluate", async (event: any) => {
			if (event.action === "shell" && fs.existsSync("$dir/permission")) event.effect = fs.readFileSync("$dir/permission", "utf8");
		});
	},
};
LISTEN

config() { # the plugins, as JSON strings
	cat >"$dir/config/opencode/opencode.json" <<CONFIG
{
  "update": "disable",
  "model": "stub/none",
  "plugins": [$1],
  "providers": {
    "stub": {
      "name": "Stub",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "apiKey": "none", "baseURL": "http://127.0.0.1:$model/v1" },
      "models": {
        "none": {
          "name": "None",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "cost": { "input": 0, "output": 0 },
          "limit": { "context": 100000, "output": 1000 }
        }
      }
    }
  }
}
CONFIG
}
config "\"$dir/listen\", \"$root\""

export HOME=$dir/home XDG_CONFIG_HOME=$dir/config XDG_DATA_HOME=$dir/data XDG_CACHE_HOME=$dir/cache XDG_STATE_HOME=$dir/state
export OPENCODE_SERVER_PASSWORD=test
unset OPENCODE_SESSION_ID

fail() { echo "FAIL: $1"; failed=1; }

waits_for() { # the check, as a command
	tries=0
	until "$@"; do
		tries=$((tries + 1))
		[ "$tries" -lt 500 ] || return 1
		sleep 0.02
	done
}

holds() { grep -qF -- "$2" "$1" 2>/dev/null; }
logged() { holds "$log" "$1"; }
never() { # name, text
	if logged "$2"; then fail "$1: ran \"$2\""; fi
}
count() { grep -c -- "$1" "$log"; }

password=test
api() { curl -s -m 20 -u "opencode:$password" -H 'content-type: application/json' "$@"; }
listening() { api -o /dev/null "$url/api/session"; }

start_server() {
	(cd "$dir/work" && exec env PATH="$dir/planted:$PATH" opencode serve --port "$port" --hostname 127.0.0.1 "$@" >"$dir/out" 2>&1) &
	server=$!
	waits_for listening || fail "opencode did not start: $(tail -n 3 "$dir/out")"
}

# SIGTERM, which is how a service manager or a closing terminal ends a server.
stop_server() {
	kill "$server"
	wait "$server"
}

new_session() {
	api -X POST "$url/api/session" -d "{\"location\":{\"directory\":\"$dir/work\"}}" | grep -o 'ses_[A-Za-z0-9]*' | head -n 1
}

# What the session shows: an answer waits in the inbox until the next turn takes it.
messages() { api "$url/api/session/$1/message"; api "$url/api/session/$1/inbox"; }
prompt() { api -o /dev/null -X POST "$url/api/session/$1/prompt" -d "{\"text\":\"$2\"}"; }
sent() { grep -aF '{"sent":' "$heard" | grep -qF -- "$1"; }
turns() { grep -acF '{"sent":' "$heard"; }
shows() { messages "$1" | grep -qF -- "$2"; }

says() { # session, command, its argument; what the session must show. Answering takes no turn.
	before=$(turns)
	shown=$(messages "$1" | grep -oF -- "$4" | wc -l)
	api -o /dev/null -X POST "$url/api/session/$1/command" -d "{\"name\":\"$2\",\"text\":\"$3\"}"
	[ "$(messages "$1" | grep -oF -- "$4" | wc -l)" -gt "$shown" ] ||
		fail "$2 $3: no \"$4\" in $(messages "$1" | cut -c 1-400)"
	[ "$(turns)" = "$before" ] || fail "$2 $3: took a model turn"
}

lists() { api "$url/api/$1?directory=$dir/work" | grep -qF "\"name\":\"$2\""; }

handoff() { # session, the text; waits for its submit
	submits=$(count '^submit exit=')
	printf '%s' "$2" >"$dir/next"
	mv "$dir/next" "$dir/handoffs/$1/next"
	waits_for submitted || fail "no submit for: $2"
}
submitted() { [ "$(count '^submit exit=')" -gt "$submits" ]; }

alive() { kill -0 "$(cat "$dir/receiver-$1" 2>/dev/null)" 2>/dev/null; }
gone() { ! alive "$1"; }
stops() { # session; how its receiver stops: `ended <reason>` or `error <code> <exit status>`
	echo "$2" >"$dir/stops-$1"
	waits_for test ! -e "$dir/stops-$1" || fail "the receiver never read: $2"
}
receives_again() { # name, session; a new receive since the log was emptied, and no connect
	waits_for logged "agent receive --deliver-with $root/opencode/submit.sh session=$2" || fail "$1: no receive again"
	never "$1" "agent connect"
	waits_for alive "$2" || fail "$1: no receiver"
}
stays_stopped() { # name, session; nothing receives past where a restart would come: 1 s
	# after a receiver that attached, 2 s after one that never did
	sleep 2.3
	never "$1" "agent receive"
	gone "$2" || fail "$1: a receiver runs"
}

export BLIXEL_HOOK_PATH="$dir/bin:/usr/bin:/bin:/usr/sbin:/sbin"
start_server
pid=$server

# Install

# Plugins load with a location's first request, so the list fills in shortly after it.
for name in blixel:connect blixel:status blixel:disconnect; do
	waits_for lists command "$name" || fail "not installed: $name"
done
for name in blixel connect-agent; do
	waits_for lists skill "$name" || fail "no skill: $name"
done
if api "$url/api/command?directory=$dir/work" | grep -qF "[ask|direct]"; then fail "a command still offers ask or direct"; fi

# Nothing runs in a session until the user connects

one=$(new_session)
prompt "$one" "good morning"
waits_for sent "good morning" || fail "a prompt never reached the model"
[ ! -s "$log" ] || fail "ran before any connect: $(cat "$log")"

says "$one" blixel:connect direct "Usage: /blixel:connect"
[ ! -s "$log" ] || fail "a connect with words after it ran: $(cat "$log")"

says "$one" blixel:status "" "not connected to the Blixel meeting"
logged "agent status session=$one parent=$pid" || fail "status: wrong session: $(cat "$log")"

# Connect, then receive, and the handoff after it, which is one turn with the answer before it

two=$(new_session)
: >"$log"
: >"$heard"
says "$two" blixel:connect "" "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
logged "agent connect session=$two parent=$pid" || fail "connect: $(cat "$log")"
logged "agent receive --deliver-with $root/opencode/submit.sh session=$two parent=$pid" || fail "receive: $(cat "$log")"
[ "$(cut -d ' ' -f 2 "$log" | tr '\n' ' ')" = "connect receive " ] || fail "connect did not come before receive: $(cat "$log")"
never "connect" "--approval"
alive "$two" || fail "connect left no receiver running"
says "$two" blixel:status "" "Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation."

text='First line.
Second line, after a break.

  -dash "quoted" $HOME `tick` é✦'
handoff "$two" "$text"
logged "submit exit=0" || fail "a handoff OpenCode took was not delivered: $(cat "$log")"
waits_for sent "First line." || fail "the handoff is no prompt"
[ "$(cat "$dir/last-input")" = "$text" ] || fail "the handoff changed on the way: $(cat "$dir/last-input")"
[ "$(turns)" = 1 ] || fail "the handoff after an answer took $(turns) turns"
holds "$heard" '"skill":true' || fail "the model is not told of the skill"

# Whatever a handoff says, it is a prompt

: >"$log"
for said in "disconnect blixel" "/blixel:disconnect" "BLIXEL STATUS"; do
	handoff "$two" "$said"
	waits_for sent "$said" || fail "$said: not a prompt"
done
never "a handoff saying a phrase" "agent disconnect"
never "a handoff saying a phrase" "agent status"
alive "$two" || fail "a handoff saying a phrase stopped the receiver"

# OpenCode taking a moment over a prompt is no doubt that it took it

: >"$dir/slow-prompt"
: >"$log"
handoff "$two" "taken slowly"
rm "$dir/slow-prompt"
logged "submit exit=0" || fail "a handoff OpenCode took slowly was not delivered: $(cat "$log")"

# A handoff during a turn reaches the model

: >"$dir/hold"
: >"$heard"
prompt "$two" "a turn in progress"
waits_for holds "$heard" '{"held":true}' || fail "no turn in progress"
handoff "$two" "during that turn"
rm "$dir/hold"
waits_for sent "during that turn" || fail "a handoff during a turn never reached the model"

# Connecting another session on the same server replaces this one's connection

three=$(new_session)
: >"$log"
says "$three" blixel:connect "" "Another session was connected and no longer receives them."
waits_for alive "$three" || fail "the second session has no receiver"
waits_for gone "$two" || fail "the replaced session's receiver still runs"
: >"$log"
stays_stopped "a replaced session" "$two"
: >"$heard"
handoff "$three" "for the third"
waits_for sent "for the third" || fail "a handoff never reached its session"
shows "$three" "for the third" || fail "the handoff is not in the session it was for"
if shows "$two" "for the third"; then fail "the handoff reached another session"; fi

# A receiver that stops with no word starts again, with no connect

: >"$log"
kill -9 "$(cat "$dir/receiver-$three")"
receives_again "a killed receiver" "$three"
handoff "$three" "after a restart"
logged "submit exit=0" || fail "a handoff after a restart was not delivered"

: >"$log"
stops "$three" "error cancelled 143"
receives_again "a cancelled receiver" "$three"

# A receiver that stops with a word stays stopped

: >"$log"
stops "$three" "error app_unavailable 5"
waits_for gone "$three" || fail "the failed receiver still runs"
stays_stopped "a receiver that failed" "$three"
waits_for shows "$three" "Blixel stopped receiving handoffs: It stopped Try again." || fail "a failed receiver said nothing"
says "$three" blixel:status "" "Connected to the Blixel meeting, but not receiving its handoffs. Type /blixel:connect to receive them."
says "$three" blixel:connect "" "Connected to the Blixel meeting. Handoffs from people in it will arrive"
alive "$three" || fail "connecting again started no receiver"

: >"$log"
stops "$three" "ended meeting_ended"
stays_stopped "a receiver whose meeting ended" "$three"

says "$three" blixel:connect "" "Connected to the Blixel meeting"
: >"$log"
rm "$dir/connection"
kill -9 "$(cat "$dir/receiver-$three")"
waits_for logged "agent receive" || fail "no receive after a kill"
: >"$log"
stays_stopped "a receiver refused not_connected" "$three"
if shows "$three" "Blixel stopped receiving handoffs: This session is not connected"; then
	fail "a receiver refused not_connected said it failed"
fi

# Another receiver holds the session, as the model's own can

says "$three" blixel:connect "" "Connected to the Blixel meeting"
kill -9 "$(cat "$dir/receiver-$three")"
sleep 30 &
other=$!
echo "$other" >"$dir/receiver-$three"
: >"$log"
waits_for logged "agent receive" || fail "no receive after a kill"
: >"$log"
sleep 2.3
never "a receiver beside another" "agent receive"
says "$three" blixel:connect "" "Connected to the Blixel meeting. Another receiver in this session takes its handoffs."
kill "$other"
wait "$other" 2>/dev/null
rm -f "$dir/receiver-$three"

# Disconnect stops everything

says "$three" blixel:connect "" "Connected to the Blixel meeting. Handoffs from people in it will arrive"
: >"$log"
says "$three" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$three" || fail "disconnect left the receiver running"
[ ! -e "$(cat "$dir/socket-$three")" ] || fail "disconnect left the socket"
stays_stopped "a disconnected session" "$three"
says "$three" blixel:connect "" "Connected to the Blixel meeting"
says "$three" blixel:disconnect "" "Disconnected from the Blixel meeting"
says "$three" blixel:connect "" "Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation."
alive "$three" || fail "connecting again at once after a disconnect started no receiver"
says "$three" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$three" || fail "disconnect left the receiver running"

# A connect that fails leaves nothing

four=$(new_session)
echo '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting","hint":"Join a room first."}}' >"$dir/connect"
: >"$log"
says "$four" blixel:connect "" "Blixel did not connect: Blixel is not in a meeting Join a room first."
never "a failed connect" "agent receive"
rm "$dir/connect"

# The server ending ends the receiving, as its receivers stop with it

says "$four" blixel:connect "" "Connected to the Blixel meeting"
: >"$log"
stop_server
waits_for logged "receive stopped $four" || fail "the server ending left the receiver running"
[ ! -e "$(cat "$dir/socket-$four")" ] || fail "the server ending left the socket"
rm -f "$dir/connection"

# The model does all of it by itself, in a session nothing else has touched

model_runs() { # session, a command for the model's shell tool
	: >"$heard"
	rm -f "$dir/model-read"
	printf '%s' "$2" >"$dir/model-runs"
	prompt "$1" "do it"
	waits_for ran_once || fail "the model ran nothing: $2"
}
ran_once() { [ ! -e "$dir/model-runs" ] && [ "$(turns)" -ge 2 ]; }
model_read() { holds "$dir/model-read" "$1"; }

: >"$log"
start_server
pid=$server
five=$(new_session)
model_runs "$five" 'grep "blixel agent connect" /dev/null'
[ ! -s "$log" ] || fail "a mention of connect ran: $(cat "$log")"

model_runs "$five" "\"$cli\" agent status"
logged "agent status session=$five" || fail "the model's status: wrong session: $(cat "$log")"

printf deny >"$dir/permission"
: >"$log"
model_runs "$five" "\"$cli\" agent connect"
[ ! -s "$log" ] || fail "a connect the permission blocked ran: $(cat "$log")"
model_read "Permission denied" || fail "the model did not read the denial: $(cat "$dir/model-read")"
[ ! -e "$dir/connection" ] || fail "a connect the permission blocked connected"

printf ask >"$dir/permission"
: >"$heard"
printf '"%s" agent connect' "$cli" >"$dir/model-runs"
prompt "$five" "do it"
asked() { api "$url/api/session/$five/permission" | grep -o 'per_[A-Za-z0-9]*' | head -n 1; }
pending() { [ -n "$(asked)" ]; }
waits_for pending || fail "the connect asked for no permission"
sleep 0.3
[ ! -s "$log" ] || fail "something ran before the person answered: $(cat "$log")"
api -o /dev/null -X POST "$url/api/session/$five/permission/$(asked)/reply" -d '{"decision":"reject"}'
# A declined call ends the turn: the model is not asked again.
waits_for shows "$five" 'The user declined this tool call' || fail "the declined connect never ended: $(messages "$five" | cut -c 1-600)"
rm "$dir/permission"
[ ! -s "$log" ] || fail "a declined connect ran: $(cat "$log")"
[ ! -e "$dir/connection" ] || fail "a declined connect connected"

: >"$log"
model_runs "$five" "env -u OPENCODE_SESSION_ID OTHER=o-1 \"$cli\" agent connect --session-env OTHER"
logged "agent connect --session-env OTHER session=o-1" || fail "the model's connect for another session did not run: $(cat "$log")"
never "a connect for another session" "agent receive"
[ "$(count 'agent connect')" = 1 ] || fail "a connect for another session connected this one: $(cat "$log")"
model_read '"connection_id":"c-o-1"' || fail "the model did not read its own connect's answer: $(cat "$dir/model-read")"
rm "$dir/connection"

echo '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting"}}' >"$dir/connect"
: >"$log"
model_runs "$five" "\"$cli\" agent connect"
rm "$dir/connect"
never "a connect that failed" "agent receive"

: >"$log"
model_runs "$five" "\"$cli\" agent connect"
logged "agent connect session=$five" || fail "the model's connect: wrong session: $(cat "$log")"
logged "agent receive --deliver-with $root/opencode/submit.sh session=$five parent=$pid" ||
	fail "the model's connect was not taken over: $(cat "$log")"
model_read '"receiving":true' || fail "the model read no receiving: $(cat "$dir/model-read")"
alive "$five" || fail "the model's connect left no receiver running"
: >"$log"
model_runs "$five" "\"$cli\" agent connect"
[ "$(count 'agent receive')" = 0 ] || fail "the model's second connect started a second receiver"
handoff "$five" "after the model connected"
logged "submit exit=0" || fail "a handoff did not reach OpenCode after the model connected"
: >"$log"
model_runs "$five" "\"$cli\" agent disconnect"
logged "agent disconnect session=$five" || fail "the model's disconnect: wrong session: $(cat "$log")"
waits_for gone "$five" || fail "the receiver outlived the model's disconnect"
stays_stopped "after the model's disconnect" "$five"

# Identical shell commands in overlapping sessions retain their own identity.

both_answered() { [ "$(grep -acF '\"role\":\"tool\"' "$heard")" -ge 2 ]; }
other=$(new_session)
: >"$dir/delay"
: >"$log"
: >"$heard"
printf '"%s" agent status' "$cli" >"$dir/model-runs"
prompt "$five" "check first"
waits_for test -e "$dir/delayed" || fail "the first shell did not wait"
printf '"%s" agent status' "$cli" >"$dir/model-runs"
prompt "$other" "check second"
waits_for logged "agent status session=$other" || fail "the second status lost its session"
rm "$dir/delay"
waits_for logged "agent status session=$five" || fail "the first status lost its session"
waits_for both_answered || fail "the overlapping shells never finished"
rm "$dir/delayed"

# Phrases in the terminal, whole and in any case, on a screen with no session yet

tui() { # the keys for each prompt, one argument each, sent with Enter and a pause
	expect -c "
		set timeout 4
		log_user 0
		set stty_init {rows 40 columns 120}
		set env(TERM) xterm-256color
		cd {$dir/work}
		spawn opencode --server $url
		proc settle {seconds} { set timeout \$seconds; expect { eof {} timeout {} } }
		settle 4
		foreach keys {$*} {
			foreach key [split \$keys {}] { send -- \$key; after 15 }
			settle 0.6
			send \"\r\"
			settle 2
		}
		close
		catch wait
	" >/dev/null 2>&1
}
if command -v expect >/dev/null; then
	: >"$log"
	: >"$heard"
	tui "{Blixel Status}"
	logged "agent status" || fail "a phrase in the terminal ran no status: $(cat "$log")"
	[ "$(turns)" = 0 ] || fail "a phrase in the terminal took a model turn: $(cat "$heard")"

	: >"$log"
	tui "{BLIXEL:CONNECT}"
	logged "agent connect" || fail "a connect phrase in the terminal ran no connect: $(cat "$log")"
	[ "$(turns)" = 0 ] || fail "a connect phrase took a model turn: $(cat "$heard")"
	rm -f "$dir/connection"

	: >"$log"
	tui "{connect blixel please}" "{connect blixel ask}"
	waits_for sent "connect blixel please" || fail "words beside a phrase never reached the model"
	waits_for sent "connect blixel ask" || fail "an approval after a phrase never reached the model"
	never "words beside a phrase" "agent connect"

	: >"$log"
	rm -f "$dir/planted-ran"
	tui "!" "{blixel status}"
	waits_for test -e "$dir/planted-ran" || fail "a shell command that reads as a phrase never ran as typed"
	never "a shell command that reads as a phrase" "agent status"
	rm -f "$dir/planted-ran"
else
	echo "opencode: terminal checks skipped, expect is not installed"
fi

# A meeting quiet for longer than OpenCode keeps a location loaded keeps receiving. This
# waits for OpenCode's own sweep, up to two minutes, as nothing else unloads one.

stop_server
pkill -f "$dir/bin/blixel agent receive"
rm -f "$dir/connection"
sed 's/"update": "disable",/"update": "disable", "experimental": { "location_idle_timeout": "1 second" },/' \
	"$dir/config/opencode/opencode.json" >"$dir/config.json"
mv "$dir/config.json" "$dir/config/opencode/opencode.json"
start_server --print-logs --log-level info
seven=$(new_session)
waits_for lists command blixel:connect || fail "not installed after a restart"
says "$seven" blixel:connect "" "Connected to the Blixel meeting"
waits_for alive "$seven" || fail "no receiver"
tries=0
until holds "$dir/out" "location services evicted" || [ "$tries" -ge 130 ]; do
	tries=$((tries + 1))
	sleep 1
done
holds "$dir/out" "location services evicted" || fail "OpenCode never unloaded the location"
alive "$seven" || fail "OpenCode unloading the location stopped the receiver"
: >"$log"
: >"$heard"
handoff "$seven" "after a quiet hour"
logged "submit exit=0" || fail "a handoff after the location unloaded was not delivered: $(cat "$log")"
never "OpenCode unloading the location" "agent disconnect"
waits_for sent "after a quiet hour" || fail "a handoff after the location unloaded never reached the model"
says "$seven" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$seven" || fail "disconnect after the location unloaded left the receiver running"

# Nobody to take a handoff: that is doubt, never delivered

BLIXEL_OPENCODE_SOCKET=$dir/nobody "$root/opencode/submit.sh" "text" 2>/dev/null
[ "$?" = 1 ] || fail "a submit with nothing listening must answer 1"
stop_server

# Skills only: no plugin, and the model connects, then receives in a background shell,
# through the skill's program for OpenCode, as references/opencode.md says. Only the
# background service advertises where to reach it, so this server is one.

config "\"$dir/listen\""
: >"$log"
start_server --service
pid=$server
waits_for test -f "$dir/state/opencode/service.json" || fail "the server is no service"
# A service makes its own password, and tells it only there.
password=$(plutil -extract password raw -o - "$dir/state/opencode/service.json")
eight=$(new_session)
model_runs "$eight" "\"$cli\" agent connect"
logged "agent connect session=$eight" || fail "skills only: the model's connect: $(cat "$log")"
model_read '"receiving":false' || fail "skills only: the connect was answered for it: $(cat "$dir/model-read")"
deliver=$root/skills/connect-agent/scripts/deliver/opencode.sh
: >"$dir/model-background"
model_runs "$eight" "\"$cli\" agent receive --deliver-with \"$deliver\""
rm "$dir/model-background"
waits_for alive "$eight" || fail "skills only: no receiver: $(cat "$log")"
[ "$(ps -o ppid= -p "$(ps -o ppid= -p "$(cat "$dir/receiver-$eight")")" | tr -d ' ')" = "$pid" ] ||
	[ "$(ps -o ppid= -p "$(cat "$dir/receiver-$eight")" | tr -d ' ')" = "$pid" ] ||
	fail "skills only: the receiver is not the server's: $(ps -o ppid=,command= -p "$(cat "$dir/receiver-$eight")")"
: >"$heard"
handoff "$eight" "$text"
logged "submit exit=0" || fail "skills only: a handoff was not delivered: $(cat "$log")"
waits_for sent "First line." || fail "skills only: the handoff is no prompt"
[ "$(cat "$dir/last-input")" = "$text" ] || fail "skills only: the handoff changed on the way: $(cat "$dir/last-input")"
: >"$heard"
model_runs "$eight" "\"$cli\" agent disconnect"
waits_for gone "$eight" || fail "skills only: disconnect left the receiver running"
waits_for shows "$eight" '\"event\":\"ended\"' || fail "skills only: OpenCode did not say how the receiver ended"
stop_server
password=test

# The CLI never comes from PATH

config "\"$dir/listen\", \"$root\""
unset BLIXEL_HOOK_PATH
export BLIXEL_HOME=$dir/blixel-home BLIXEL_TOKEN_STORAGE=file
start_server
six=$(new_session)
api -o /dev/null -X POST "$url/api/session/$six/command" -d '{"name":"blixel:status","text":""}'
stop_server
[ ! -e "$dir/planted-ran" ] || fail "ran the blixel on PATH: $(cat "$dir/planted-ran")"

[ "$failed" = 0 ] && echo "opencode: pass"
exit "$failed"
