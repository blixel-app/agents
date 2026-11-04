#!/bin/sh
# Every Claude Code route to Blixel, against a folder on the session's PATH planted
# with what a sandboxed process could write there. Hooks and the mod run outside the
# sandbox, so none may reach it.
root=$(cd "$(dirname "$0")/.." && pwd -P)
scripts=$root/skills/connect-agent/scripts
manifest=$root/.claude-plugin/plugin.json
dir=$(mktemp -d)
# A Monitor's receiver under this shell, so the SessionStart hook goes on to ask the app.
perl -e 'sleep 600' 'agent receive --print-handoffs' &
receiver=$!
trap 'kill "$receiver"; wait "$receiver" 2>/dev/null; rm -rf "$dir"' EXIT
failed=0

fail() { echo "FAIL: $1"; failed=1; }

mkdir "$dir/plant" "$dir/dev"
for name in blixel plutil pgrep sed cat dirname mdfind ps; do
	printf '#!/bin/sh\necho "%s $*" >>"%s/planted"\nexit 0\n' "$name" "$dir" >"$dir/plant/$name"
	chmod +x "$dir/plant/$name"
done
printf '#!/bin/sh\necho "$$ $*" >"%s/ran"\nexec sleep "${SLEEPS-0}"\n' "$dir" >"$dir/dev/blixel"
chmod +x "$dir/dev/blixel"

# Every run names the stand-in, so no test here reaches an installed Blixel. A receiver
# from one would never exit.
export BLIXEL_HOOK_PATH="$dir/dev:/usr/bin:/bin"
export PATH=/usr/bin:/bin
unset CLAUDE_PID

planted() { # name of the route, then the command, with the plant first on PATH
	name=$1
	shift
	PATH="$dir/plant:$PATH" "$@" >/dev/null 2>&1 </dev/null
	[ ! -s "$dir/planted" ] || fail "$name ran the plant: $(cat "$dir/planted")"
	: >"$dir/planted"
}

ran() { # what the stand-in was asked, once
	cut -d' ' -f2- "$dir/ran" 2>/dev/null
	rm -f "$dir/ran"
}

CLAUDE_PID=$$ planted "the SessionStart hook" "$scripts/session-start.sh"
[ "$(ran)" = "agent status" ] || fail "the SessionStart hook passed over the stand-in"
planted "app-cli" "$scripts/app-cli" agent status
[ "$(ran)" = "agent status" ] || fail "app-cli passed over the stand-in"

# Every command in the manifest, as Claude Code expands it, so a new one is covered too.
/usr/bin/sed -n 's/^ *"command": "\(.*\)",\{0,1\}$/\1/p' "$manifest" |
	/usr/bin/sed "s/\\\\\"/\"/g; s|\${CLAUDE_PLUGIN_ROOT}|$root|" >"$dir/commands"
[ "$(/usr/bin/wc -l <"$dir/commands")" -ge 1 ] || fail "read too few commands from the manifest"
while read -r command; do
	CLAUDE_PID=$$ planted "$command" /bin/sh -c "$command"
	rm -f "$dir/ran"
done <"$dir/commands"

# Without the setting, only system folders are searched.
path=$(env -u BLIXEL_HOOK_PATH /bin/sh -c '. "$1/path.sh"; echo "$PATH"' sh "$scripts")
[ "$path" = /usr/bin:/bin:/usr/sbin:/sbin ] || fail "PATH without the setting: $path"

# The mod stops its receiver by the pid it started.
SLEEPS=30 "$scripts/app-cli" agent receive --print-events --confirm-each &
started=$!
i=0
while [ ! -s "$dir/ran" ] && [ "$i" -lt 500 ]; do
	/usr/bin/perl -e 'select undef, undef, undef, 0.01'
	i=$((i + 1))
done
[ "$(cut -d' ' -f1 "$dir/ran")" = "$started" ] || fail "app-cli left a process between the mod and the CLI"
kill "$started"
wait "$started" 2>/dev/null

# Only a rule on a path no sandboxed process can write approves a command that may
# run outside the sandbox: a model's dangerouslyDisableSandbox comes through it.
cli=Blixel.app/Contents/Resources/bin/blixel
for file in "$root"/skills/*/SKILL.md "$root"/commands/*.md; do
	/usr/bin/awk '/^---$/ { n++; next } n == 1' "$file" | /usr/bin/grep -oE 'Bash(\([^)]*\))?' | while read -r rule; do
		case $rule in
		"Bash(/Applications/$cli agent "* | "Bash(~/Applications/$cli agent "*) ;;
		*) echo "FAIL: $file approves $rule"; touch "$dir/rule" ;;
		esac
	done
done
[ ! -e "$dir/rule" ] || failed=1

# A `receive` rule that takes more would approve `--deliver-with`, which runs any program
# outside the sandbox.
for file in "$root"/skills/*/SKILL.md "$root"/commands/*.md; do
	/usr/bin/awk '/^---$/ { n++; next } n == 1' "$file" | /usr/bin/grep -oE 'Bash\([^)]* agent receive[^)]*\)' | while read -r rule; do
		case $rule in
		*"/$cli agent receive --print-handoffs)" | *"/$cli agent receive --print-handoffs --once)") ;;
		*) echo "FAIL: $file approves $rule" && touch "$dir/receive-rule" ;;
		esac
	done
done
[ ! -e "$dir/receive-rule" ] || failed=1

for verb in 'connect*' 'status*' 'disconnect*' 'receive --print-handoffs' 'receive --print-handoffs --once'; do
	for folder in /Applications '~/Applications'; do
		/usr/bin/grep -qF "Bash($folder/$cli agent $verb)" "$root/skills/connect-agent/SKILL.md" ||
			fail "the skill has no rule for $folder $verb"
	done
done

# What the model is told to run. Skill text, as a rule cannot stop what it asks for.
for file in "$root"/skills/connect-agent/SKILL.md "$root"/skills/connect-agent/references/*.md; do
	/usr/bin/grep -q 'blixel agent' "$file" && ! /usr/bin/grep -qF "/Applications/$cli\`, by that full path" "$file" &&
		fail "$file does not give the full path"
	/usr/bin/grep -n 'run `*scripts/blixel\|use `*scripts/blixel' "$file" >"$dir/shim" &&
		fail "$file sends the model to the shim: $(cat "$dir/shim")"
done

/usr/bin/cmp -s "$root/skills/blixel/scripts/blixel" "$scripts/blixel" || fail "the two shims differ"

# A copy, as the shim itself would find any Blixel installed on this Mac.
/usr/bin/sed 's|/Applications/Blixel.app|/nowhere/Blixel.app|' "$scripts/blixel" >"$dir/shim"
told=$(HOME=$dir PATH=/usr/bin:/bin BLIXEL_SHIM_NO_SEARCH=1 /bin/sh "$dir/shim" agent connect 2>&1)
status=$?
[ "$status" = 127 ] || fail "with no Blixel in an Applications folder: exit $status"
case $told in
*"Move it to one, or get it at https://blixel.app"*) ;;
*) fail "with no Blixel in an Applications folder, says: $told" ;;
esac

[ "$failed" = 0 ] && echo "claude-routes: pass"
exit "$failed"
