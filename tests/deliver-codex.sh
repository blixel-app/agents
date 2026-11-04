#!/bin/sh
# The Codex deliver program, run for real against a stand-in Codex session: a copy of
# bash named `codex` is the agent process, so its image is a `codex`, and its `queue`
# argument runs $dir/bin/queue, which says what the real `codex queue` says.
root=$(cd "$(dirname "$0")/.." && pwd -P)
deliver=$root/skills/connect-agent/scripts/deliver/codex.sh
dir=$(mktemp -d)
trap 'pkill -P "$agent"; kill "$agent" 2>/dev/null; wait "$agent" 2>/dev/null; rm -rf "$dir"' EXIT
failed=0
thread=01a19327-87e5-71b0-838d-13985efedb4a
other=01a19327-b6e5-7282-b42a-fa627ce665f4
text='-one "two" '"'three'"' $HOME `four` é
five\six'

fail() { echo "FAIL: $1"; failed=1; }

mkdir "$dir/session" "$dir/bin" "$dir/plant"
cp /bin/bash "$dir/session/codex"
codesign -f -s - "$dir/session/codex" 2>/dev/null
# What a sandboxed process could have put on PATH.
for name in codex lsof sed; do
	printf '#!/bin/sh\necho "%s $*" >>"%s/planted"\nexit 0\n' "$name" "$dir" >"$dir/plant/$name"
	chmod +x "$dir/plant/$name"
done
cat >"$dir/bin/queue" <<STANDIN
for a in "\${0##*/}" "\$@"; do printf '[%s]\n' "\$a"; done >"$dir/asked"
cat "$dir/says"
exit "\$(cat "$dir/exit")"
STANDIN
printf '/bin/sleep 600\nexit 0\n' >"$dir/bin/agent"
PATH="$dir/bin:/usr/bin:/bin" "$dir/session/codex" agent 2>/dev/null &
agent=$!

says() { # what `codex queue` prints, then its exit status
	printf '%s\n' "$1" >"$dir/says"
	echo "${2:-0}" >"$dir/exit"
	rm -f "$dir/asked"
}

delivers() { # name, the exit it must end with, then the agent pid and thread to claim
	PATH="$dir/plant:$dir/bin:/usr/bin:/bin" BLIXEL_AGENT_PID=${3-$agent} BLIXEL_AGENT_SESSION_KEY=${4-$thread} \
		BLIXEL_AGENT_PROVIDER=codex BLIXEL_HANDOFF_ID=7 "$deliver" "$text" </dev/null >"$dir/out" 2>&1
	said=$?
	[ "$said" = "$2" ] || fail "$1: exited $said, not $2"
	[ ! -s "$dir/out" ] || fail "$1: printed $(cat "$dir/out")"
	[ ! -s "$dir/planted" ] || fail "$1: ran from PATH: $(cat "$dir/planted")"
	: >"$dir/planted"
}

says "Queued message 1 for thread $thread"
delivers "queued" 0
[ "$(cat "$dir/asked")" = "[queue]
[--thread=$thread]
[--message=$text]" ] || fail "asked Codex: $(cat "$dir/asked")"

says "Queued message 1 for thread $other"
delivers "another thread queued it" 1
says "ok"
delivers "exit 0 without saying it queued" 1
says "Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id $thread (code -32603)" 1
delivers "a thread with no first turn" 69
says "Error: No active session found matching '$thread'" 1
delivers "no such session" 69
says "Error: something else" 1
delivers "another failure" 1
says "" 126
delivers "a codex it cannot run" 69
says "" 127
delivers "no codex" 69
says "Killed" 137
delivers "signalled" 1
says "x" 69
delivers "Codex's own 69 is not a refusal" 1

says "Queued message 1 for thread $thread"
delivers "an agent that is not Codex" 69 $$
[ ! -e "$dir/asked" ] || fail "an agent that is not Codex: asked $(cat "$dir/asked")"
delivers "an agent that is gone" 69 999999
delivers "no thread" 69 "$agent" ""
[ ! -e "$dir/asked" ] || fail "no thread: asked $(cat "$dir/asked")"

[ "$failed" = 0 ] && echo "deliver-codex: pass"
exit "$failed"
