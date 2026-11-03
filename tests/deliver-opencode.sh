#!/bin/sh
# The OpenCode deliver program, run for real against a stand-in OpenCode server: a
# `service.json` like the real one, and an HTTP server answering the session's
# prompt route with the codes the real one gives.
root=$(cd "$(dirname "$0")/.." && pwd -P)
deliver=$root/skills/connect-agent/scripts/deliver/opencode.sh
dir=$(mktemp -d)
failed=0
session=ses_e5e02bef9ffeodDV1klTiKIdqJ
# Real passwords are URL-safe base64; this one also has what curl's config quotes.
password='2ItDTybdiJNc-5s6"ZUCX\gqxUG2bCG21ECccp_zmjz9Y'
text='-one "two" '"'three'"' $HOME `four` é
five\six'

fail() { echo "FAIL: $1"; failed=1; }

mkdir -p "$dir/state/opencode" "$dir/plant"
for name in curl plutil sed; do
	printf '#!/bin/sh\necho "%s $*" >>"%s/planted"\nexit 0\n' "$name" "$dir" >"$dir/plant/$name"
	chmod +x "$dir/plant/$name"
done

# Logs each request as JSON and answers with the code in $dir/code, after $dir/delay
# seconds. Python reads the password from the file, so no argv here holds it.
cat >"$dir/server.py" <<'STANDIN'
import base64, http.server, json, sys, time
dir = sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        auth = self.headers.get("authorization", "")
        user = base64.b64decode(auth[6:]).decode() if auth.startswith("Basic ") else ""
        with open(dir + "/requests", "a") as f:
            f.write(json.dumps({"path": self.path, "user": user, "type": self.headers.get("content-type"),
                                "body": json.loads(body)}) + "\n")
        time.sleep(float(open(dir + "/delay").read()))
        code = int(open(dir + "/code").read())
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":{}}' if code < 300 else b'{"_tag":"SessionNotFoundError"}')
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
open(dir + "/port", "w").write(str(server.server_port))
server.serve_forever()
STANDIN
echo 0 >"$dir/delay"
/usr/bin/python3 -I "$dir/server.py" "$dir" &
server=$!
trap 'kill "$server" 2>/dev/null; wait "$server" 2>/dev/null; rm -rf "$dir"' EXIT
i=0
while [ ! -s "$dir/port" ] && [ "$i" -lt 500 ]; do
	/usr/bin/perl -e 'select undef, undef, undef, 0.01'
	i=$((i + 1))
done
url=http://127.0.0.1:$(cat "$dir/port")

service() { # the server's pid and URL, as `opencode serve --service` writes them
	printf '{"id":"24317825-784e-404f-9a90-47fcb34c84b5","version":"2.2.5","url":"%s","pid":%s,"password":"%s"}' \
		"$2" "$1" "$(printf '%s' "$password" | /usr/bin/sed 's/[\\"]/\\&/g')" >"$dir/state/opencode/service.json"
}

answers() { # the HTTP code the server gives
	echo "$1" >"$dir/code"
	rm -f "$dir/requests"
}

delivers() { # name, the exit it must end with, then the agent pid to claim
	PATH="$dir/plant:/usr/bin:/bin" XDG_STATE_HOME=$dir/state BLIXEL_AGENT_PID=${3-4242} \
		BLIXEL_AGENT_SESSION_KEY=$session BLIXEL_AGENT_PROVIDER=opencode BLIXEL_HANDOFF_ID=7 \
		"$deliver" "$text" </dev/null >"$dir/out" 2>&1
	said=$?
	[ "$said" = "$2" ] || fail "$1: exited $said, not $2"
	[ ! -s "$dir/out" ] || fail "$1: printed $(cat "$dir/out")"
	[ ! -s "$dir/planted" ] || fail "$1: ran from PATH: $(cat "$dir/planted")"
	: >"$dir/planted"
}

asked() { # the one request's field, as JSON
	[ "$(/usr/bin/wc -l <"$dir/requests" 2>/dev/null)" -eq 1 ] || { echo "requests: $(cat "$dir/requests" 2>/dev/null)"; return; }
	/usr/bin/python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]], sort_keys=True))' "$dir/requests" "$1"
}

service 4242 "$url/"
answers 200
delivers "taken" 0
[ "$(asked path)" = "\"/api/session/$session/prompt\"" ] || fail "posted to $(asked path)"
[ "$(asked user)" = "$(printf '%s' "opencode:$password" | /usr/bin/python3 -I -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" ] ||
	fail "signed in as $(asked user)"
[ "$(asked type)" = '"application/json"' ] || fail "sent $(asked type)"
[ "$(asked body)" = "$(printf '%s' "$text" | /usr/bin/python3 -I -c 'import json,sys; print(json.dumps({"delivery": "queue", "text": sys.stdin.read()}, sort_keys=True))')" ] ||
	fail "sent $(asked body)"

answers 204
delivers "taken with no body" 0
for code in 400 401 404; do
	answers "$code"
	delivers "refused with $code" 69
done
answers 500
delivers "a server error" 1

# With no XDG_STATE_HOME, the service is under ~/.local/state.
mkdir "$dir/.local"
ln -s ../state "$dir/.local/state"
answers 200
env -u XDG_STATE_HOME HOME="$dir" PATH=/usr/bin:/bin BLIXEL_AGENT_PID=4242 BLIXEL_AGENT_SESSION_KEY=$session \
	"$deliver" "$text" </dev/null || fail "with no XDG_STATE_HOME: exited $?"
[ "$(asked path)" = "\"/api/session/$session/prompt\"" ] || fail "with no XDG_STATE_HOME: posted to $(asked path)"

# The password is in no process's arguments while the request is out.
answers 200
echo 1 >"$dir/delay"
delivers "slow" 0 &
slow=$!
: >"$dir/ps"
while kill -0 "$slow" 2>/dev/null; do
	/bin/ps -axww -o pid=,args= >>"$dir/ps"
done
wait "$slow"
echo 0 >"$dir/delay"
/usr/bin/grep -q '/usr/bin/curl' "$dir/ps" || fail "never saw curl in ps, so the check below proves nothing"
/usr/bin/grep -F "$password" "$dir/ps" >"$dir/seen" && fail "the password in ps: $(cat "$dir/seen")"
/usr/bin/grep -F 'ZUCX' "$dir/ps" >"$dir/seen" && fail "part of the password in ps: $(cat "$dir/seen")"
/usr/bin/grep -F "$(printf '%s' "opencode:$password" | /usr/bin/base64)" "$dir/ps" >"$dir/seen" &&
	fail "the password, encoded, in ps: $(cat "$dir/seen")"

answers 200
delivers "another server's pid" 69 4343
[ ! -e "$dir/requests" ] || fail "another server's pid: posted $(cat "$dir/requests")"

kill "$server"
wait "$server" 2>/dev/null
delivers "the server is gone" 1

rm "$dir/state/opencode/service.json"
delivers "no service" 69

[ "$failed" = 0 ] && echo "deliver-opencode: pass"
exit "$failed"
