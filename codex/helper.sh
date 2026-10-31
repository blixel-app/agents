#!/bin/sh
# Follows this thread's handoffs and queues each into it, once. It runs as a
# hook because a hook is outside Codex's sandbox and knows the session; 30 days
# is its limit in hooks.json, as Codex kills a hook at its limit, by default 10
# minutes. Each prompt starts it again, so a helper that died comes back.
input=$(cat)
session=${input#*\"session_id\":\"}
session=${session%%\"*}
case $session in '' | *[!0-9a-f-]*) exit 0 ;; esac
export BLIXEL_AGENT_PID=$PPID BLIXEL_AGENT_SESSION_KEY=$session
export BLIXEL_AGENT_PROVIDER=codex BLIXEL_AGENT_NAME=Codex
blixel=$PLUGIN_ROOT/skills/connect-agent/scripts/blixel
agent=$PPID
helper=$$
lock=$PLUGIN_DATA/helper.$session
mkdir -p "$PLUGIN_DATA"
cd "$HOME" || exit 0

# A pid alone could be another process by now.
running() {
	case $(ps -o command= -p "$1" 2>/dev/null) in *codex/helper.sh*) ;; *) return 1 ;; esac
}

claim() {
	ln -s "$helper" "$lock" 2>/dev/null && return
	holder=$(readlink "$lock")
	running "$holder" && return 1
	# Renamed, not removed: of two helpers that found it stale, only one may
	# replace it, and the other may have taken the first one's new lock.
	mv "$lock" "$lock.$helper" 2>/dev/null || return 1
	if [ "$(readlink "$lock.$helper")" != "$holder" ]; then
		mv "$lock.$helper" "$lock"
		return 1
	fi
	rm -f "$lock.$helper"
	ln -s "$helper" "$lock" 2>/dev/null
}

claim || exit 0
trap 'rm -f "$lock" "$PLUGIN_DATA/queued.$session".*' EXIT
# Quitting Codex kills a helper before it can clean up after itself.
find "$PLUGIN_DATA" ! -type d -mtime +30 -delete

# An app without acks queues into the thread itself.
"$blixel" agent follow --help 2>/dev/null | grep -q -e --acks || exit 0

# The session's own, so the same version and CODEX_HOME answer.
codex=$(ps -o comm= -p "$agent" 2>/dev/null)
case $codex in */codex) [ -x "$codex" ] || codex=codex ;; *) codex=codex ;; esac

field() { # name, handoff
	printf '%s' "$2" | plutil -extract "$1" raw -o - - 2>/dev/null
}

queue() { # text; `=` keeps text that starts with - from reading as an option
	"$codex" queue --thread="$session" --message="$1" </dev/null 2>&1 &
	pid=$!
	{ sleep 30; kill "$pid"; } >/dev/null 2>&1 &
	timer=$!
	wait "$pid"
	status=$?
	kill "$timer" 2>/dev/null
	return "$status"
}

# Never retried: a refusal is failed, and any doubt is unknown. Exit 0 alone is
# not enough, Codex has to say it queued this thread's message.
deliver() { # handoff
	id=$(field id "$1") || return 0
	text=$(field message "$1") || text=$(field prompt "$1")
	# Tells prompt.sh this prompt is a handoff. A hash, so no text is on disk.
	mark=$PLUGIN_DATA/queued.$session.$(printf '%s' "$text" | /sbin/md5 -q).$id
	: >"$mark"
	said=$(queue "$text")
	status=$?
	state=unknown
	case $status in
	0)
		case $said in
		*"Queued message"*) case $said in *"$session"*) state=queued ;; esac ;;
		esac
		;;
	1)
		case $said in
		*"No active session found"* | *"no rollout found for thread id"*) state=failed ;;
		esac
		;;
	126 | 127) state=failed ;;
	esac
	[ "$state" = failed ] && rm -f "$mark"
	"$blixel" agent ack "$id" "$state" --reason "codex queue exited $status" >/dev/null 2>&1
}

# A follower never exits on its own, and sees that its reader went only when
# it next prints, so this keeps it from outliving the helper or the session.
(
	"$blixel" agent follow --json --acks 2>/dev/null &
	follower=$!
	while kill -0 "$follower" && kill -0 "$helper" && kill -0 "$agent"; do
		sleep 5 >/dev/null
	done 2>/dev/null
	kill "$follower" 2>/dev/null
) | while IFS= read -r handoff; do
	deliver "$handoff"
done
