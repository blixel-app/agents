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
trap 'kill "$server" 2>/dev/null; rm -rf "$dir"' EXIT
failed=0
log=$dir/log
heard=$dir/heard
mkdir -p "$dir/bin" "$dir/planted" "$dir/handoffs" "$dir/work" "$dir/listen" "$dir/home" "$dir/config/opencode"
: >"$log"
: >"$heard"

# Stands in for `blixel`: logs each call with who made it, and a relay runs its submit on
# whatever lands in its session's folder under handoffs/.
cat >"$dir/bin/blixel" <<STANDIN
#!/bin/sh
dir=$dir
STANDIN
cat >>"$dir/bin/blixel" <<'STANDIN'
echo "$* pid=$BLIXEL_AGENT_PID key=$BLIXEL_AGENT_SESSION_KEY provider=$BLIXEL_AGENT_PROVIDER name=$BLIXEL_AGENT_NAME" >>"$dir/log"
case $2 in
relay)
	key=$BLIXEL_AGENT_SESSION_KEY
	mkdir -p "$dir/handoffs/$key"
	echo "$$" >"$dir/relay-$key"
	echo "$BLIXEL_OPENCODE_SOCKET" >"$dir/socket-$key"
	trap 'echo "relay stopped $key" >>"$dir/log"; [ ! -e "$dir/slow-stop" ] || sleep 0.4; exit 0' TERM
	while [ ! -e "$dir/end-relay" ]; do
		for file in "$dir/handoffs/$key"/*; do
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

model=$((30000 + $$ % 15000))
port=$((model + 1))
url=http://127.0.0.1:$port

# The model, as a plugin of its own: it runs what model-runs holds with the shell tool,
# and hears each request after the plugin under test added to it.
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
			fs.writeFileSync("$dir/last-input", String(last.content));
			hear({ sent: JSON.stringify(last), rules: body.includes("they connected it to receive handoffs"), skill: body.includes("connect-agent") });
			if (fs.existsSync("$dir/hold")) hear({ held: true });
			while (fs.existsSync("$dir/hold")) await new Promise((wake) => setTimeout(wake, 20));
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (parsed.tools && last.role !== "tool" && fs.existsSync("$dir/model-runs")) {
			const command = fs.readFileSync("$dir/model-runs", "utf8");
			fs.rmSync("$dir/model-runs");
			const call = { index: 0, id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command, description: "run it" }) } };
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
	},
};
LISTEN

cat >"$dir/config/opencode/opencode.json" <<CONFIG
{
  "update": "disable",
  "model": "stub/none",
  "plugins": ["$dir/listen", "$root"],
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

api() { curl -s -m 20 -u "opencode:test" -H 'content-type: application/json' "$@"; }
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
	submits=$(grep -c '^submit exit=' "$log")
	printf '%s' "$2" >"$dir/next"
	mv "$dir/next" "$dir/handoffs/$1/next"
	waits_for submitted || fail "no submit for: $2"
}
submitted() { [ "$(grep -c '^submit exit=' "$log")" -gt "$submits" ]; }

alive() { kill -0 "$(cat "$dir/relay-$1" 2>/dev/null)" 2>/dev/null; }
gone() { ! alive "$1"; }

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

# Nothing runs in a session until the user connects

one=$(new_session)
prompt "$one" "good morning"
waits_for sent "good morning" || fail "a prompt never reached the model"
[ ! -s "$log" ] || fail "ran before any connect: $(cat "$log")"
holds "$heard" '"rules":false' || fail "a session not connected carries the rules"

says "$one" blixel:connect tomorrow "Usage: /blixel:connect [ask|direct]"
[ ! -s "$log" ] || fail "a bad approval ran: $(cat "$log")"

echo '{"data":{"meeting_id":"m-1","session":{}}}' >"$dir/status"
says "$one" blixel:status "" "not connected to the Blixel meeting"
logged "agent status pid=$pid key=$one provider=opencode name=OpenCode" || fail "status: wrong session: $(cat "$log")"
rm "$dir/status"

# Connect, and the handoff after it, which is one turn with the answer before it

two=$(new_session)
: >"$log"
: >"$heard"
says "$two" blixel:connect direct "Connected to the Blixel meeting"
logged "agent relay --submit $root/opencode/submit.sh pid=$pid key=$two provider=opencode name=OpenCode" || fail "relay: $(cat "$log")"
logged "agent connect --approval direct pid=$pid key=$two provider=opencode name=OpenCode" || fail "connect: $(cat "$log")"

text='First line.
Second line, after a break.

  -dash "quoted" $HOME `tick` é✦'
handoff "$two" "$text"
logged "submit exit=0" || fail "a handoff OpenCode took was not queued: $(cat "$log")"
waits_for sent "First line." || fail "the handoff is no prompt"
[ "$(cat "$dir/last-input")" = "$text" ] || fail "the handoff changed on the way: $(cat "$dir/last-input")"
[ "$(turns)" = 1 ] || fail "the handoff after an answer took $(turns) turns"
holds "$heard" '"rules":true' || fail "the rules did not reach a connected session"
holds "$heard" '"skill":true' || fail "the model is not told of the skill"

# Whatever a handoff says, it is a prompt

: >"$log"
for said in "disconnect blixel" "/blixel:disconnect" "BLIXEL STATUS"; do
	handoff "$two" "$said"
	waits_for sent "$said" || fail "$said: not a prompt"
done
never "a handoff saying a phrase" "agent disconnect"
never "a handoff saying a phrase" "agent status"
alive "$two" || fail "a handoff saying a phrase stopped the relay"

# OpenCode taking a moment over a prompt is no doubt that it took it

: >"$dir/slow-prompt"
: >"$log"
handoff "$two" "taken slowly"
rm "$dir/slow-prompt"
logged "submit exit=0" || fail "a handoff OpenCode took slowly was not queued: $(cat "$log")"

# A handoff during a turn reaches the model, and takes the rules with it

: >"$dir/hold"
: >"$heard"
prompt "$two" "a turn in progress"
waits_for holds "$heard" '{"held":true}' || fail "no turn in progress"
handoff "$two" "during that turn"
rm "$dir/hold"
waits_for sent "during that turn" || fail "a handoff during a turn never reached the model"
if holds "$heard" '"rules":false'; then fail "a turn of a connected session lost the rules"; fi

# Each session on one server has its own connection

three=$(new_session)
says "$three" blixel:connect "" "Connected to the Blixel meeting"
waits_for alive "$three" || fail "a second session has no relay"
alive "$two" || fail "connecting a second session stopped the first's relay"
: >"$heard"
handoff "$three" "for the third"
waits_for sent "for the third" || fail "a handoff never reached its session"
case $(messages "$three") in *"for the third"*) ;; *) fail "the handoff is not in the session it was for" ;; esac
case $(messages "$two") in *"for the third"*) fail "the handoff reached another session" ;; esac

# Disconnect stops everything, for that session alone

: >"$heard"
says "$two" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$two" || fail "disconnect left the relay running"
[ ! -e "$(cat "$dir/socket-$two")" ] || fail "disconnect left the socket"
prompt "$two" "after disconnecting"
waits_for sent "after disconnecting" || fail "a prompt never reached the model"
if holds "$heard" '"rules":true'; then fail "the rules outlived the connection"; fi
alive "$three" || fail "disconnecting one session stopped another's relay"
says "$three" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$three" || fail "disconnect left the relay running"

# A connect that fails leaves nothing

four=$(new_session)
echo '{"error":{"message":"Blixel is not in a meeting","hint":"Join a room first."}}' >"$dir/connect"
says "$four" blixel:connect "" "Blixel did not connect: Blixel is not in a meeting Join a room first."
waits_for gone "$four" || fail "a failed connect left the relay running"
: >"$dir/slow-stop"
says "$four" blixel:connect "" "Blixel did not connect"
rm "$dir/connect"
says "$four" blixel:connect "" "Connected to the Blixel meeting"
rm "$dir/slow-stop"
sleep 0.6
alive "$four" || fail "the relay a failed connect stopped took its successor along"

# Another session taking over ends the relay

: >"$log"
: >"$dir/end-relay"
waits_for gone "$four" || fail "the relay did not end"
sleep 0.1
says "$four" blixel:connect "" "Connected to the Blixel meeting"
waits_for alive "$four" || fail "connecting again after a takeover started no relay"

# The server ending ends the connection, as the relay stops with it

: >"$log"
stop_server
waits_for logged "relay stopped $four" || fail "the server ending left the relay running"
[ ! -e "$(cat "$dir/socket-$four")" ] || fail "the server ending left the socket"

# The model does all of it by itself, in a session nothing else has touched

model_runs() { # session, a command for the model's shell tool
	: >"$heard"
	printf '%s' "$2" >"$dir/model-runs"
	prompt "$1" "do it"
	waits_for ran_once || fail "the model ran nothing: $2"
}
ran_once() { [ ! -e "$dir/model-runs" ] && [ "$(turns)" -ge 2 ]; }

: >"$log"
start_server
pid=$server
five=$(new_session)
model_runs "$five" 'grep "blixel agent connect" /dev/null'
never "a mention of connect" "agent relay"

model_runs "$five" "\"$dir/bin/blixel\" agent status"
logged "agent status pid=$pid key=$five provider=opencode name=OpenCode" || fail "the model's status: wrong session: $(cat "$log")"
model_runs "$five" "\"$dir/bin/blixel\" agent connect"
logged "agent connect pid=$pid key=$five provider=opencode name=OpenCode" || fail "the model's connect: wrong session: $(cat "$log")"
logged "agent relay --submit $root/opencode/submit.sh pid=$pid key=$five provider=opencode name=OpenCode" ||
	fail "the model's connect started no relay: $(cat "$log")"
waits_for alive "$five" || fail "the model's connect left no relay running"
: >"$log"
model_runs "$five" "\"$dir/bin/blixel\" agent connect"
[ "$(grep -c 'agent relay' "$log")" = 0 ] || fail "the model's second connect started a second relay"
handoff "$five" "after the model connected"
logged "submit exit=0" || fail "a handoff did not reach OpenCode after the model connected"
model_runs "$five" "\"$dir/bin/blixel\" agent disconnect"
logged "agent disconnect pid=$pid key=$five" || fail "the model's disconnect: wrong session: $(cat "$log")"
: >"$dir/end-relay"
waits_for gone "$five" || fail "the relay outlived the model's disconnect"

# Identical shell commands in overlapping sessions retain their own identity.

both_answered() { [ "$(grep -acF '\"role\":\"tool\"' "$heard")" -ge 2 ]; }
other=$(new_session)
: >"$dir/delay"
: >"$log"
: >"$heard"
printf '"%s/bin/blixel" agent status' "$dir" >"$dir/model-runs"
prompt "$five" "check first"
waits_for test -e "$dir/delayed" || fail "the first shell did not wait"
printf '"%s/bin/blixel" agent status' "$dir" >"$dir/model-runs"
prompt "$other" "check second"
waits_for logged "agent status pid=$pid key=$other" || fail "the second status lost its session"
rm "$dir/delay"
waits_for logged "agent status pid=$pid key=$five" || fail "the first status lost its session"
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
	tui "{BLIXEL:CONNECT ask}"
	logged "agent connect --approval ask" || fail "a phrase with an approval: $(cat "$log")"
	[ "$(turns)" = 0 ] || fail "a connect phrase took a model turn: $(cat "$heard")"

	: >"$log"
	tui "{connect blixel please}" "{blixel status direct}"
	waits_for sent "connect blixel please" || fail "words beside a phrase never reached the model"
	waits_for sent "blixel status direct" || fail "an approval on status never reached the model"
	never "words beside a phrase" "agent connect"
	never "words beside a phrase" "agent status"

	: >"$log"
	rm -f "$dir/planted-ran"
	tui "!" "{blixel status}"
	waits_for test -e "$dir/planted-ran" || fail "a shell command that reads as a phrase never ran as typed"
	never "a shell command that reads as a phrase" "agent status"
	rm -f "$dir/planted-ran"
else
	echo "opencode: terminal checks skipped, expect is not installed"
fi

# A meeting quiet for longer than OpenCode keeps a location loaded stays connected. This
# waits for OpenCode's own sweep, up to two minutes, as nothing else unloads one.

stop_server
sed 's/"update": "disable",/"update": "disable", "experimental": { "location_idle_timeout": "1 second" },/' \
	"$dir/config/opencode/opencode.json" >"$dir/config.json"
mv "$dir/config.json" "$dir/config/opencode/opencode.json"
start_server --print-logs --log-level info
seven=$(new_session)
waits_for lists command blixel:connect || fail "not installed after a restart"
says "$seven" blixel:connect "" "Connected to the Blixel meeting"
waits_for alive "$seven" || fail "no relay"
tries=0
until holds "$dir/out" "location services evicted" || [ "$tries" -ge 130 ]; do
	tries=$((tries + 1))
	sleep 1
done
holds "$dir/out" "location services evicted" || fail "OpenCode never unloaded the location"
alive "$seven" || fail "OpenCode unloading the location ended the connection"
: >"$log"
: >"$heard"
handoff "$seven" "after a quiet hour"
logged "submit exit=0" || fail "a handoff after the location unloaded was not queued: $(cat "$log")"
never "OpenCode unloading the location" "agent disconnect"
waits_for sent "after a quiet hour" || fail "a handoff after the location unloaded never reached the model"
if holds "$heard" '"rules":false'; then fail "the rules did not survive the location unloading"; fi
says "$seven" blixel:disconnect "" "Disconnected from the Blixel meeting"
waits_for gone "$seven" || fail "disconnect after the location unloaded left the relay running"

# Nobody to take a handoff: that is doubt, never queued

BLIXEL_OPENCODE_SOCKET=$dir/nobody "$root/opencode/submit.sh" "text" 2>/dev/null
[ "$?" = 1 ] || fail "a submit with nothing listening must answer 1"
stop_server

# The CLI never comes from PATH

unset BLIXEL_HOOK_PATH
export BLIXEL_HOME=$dir/blixel-home BLIXEL_TOKEN_STORAGE=file
start_server
six=$(new_session)
api -o /dev/null -X POST "$url/api/session/$six/command" -d '{"name":"blixel:status","text":""}'
stop_server
[ ! -e "$dir/planted-ran" ] || fail "ran the blixel on PATH: $(cat "$dir/planted-ran")"

[ "$failed" = 0 ] && echo "opencode: pass"
exit "$failed"
