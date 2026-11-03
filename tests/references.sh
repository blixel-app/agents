#!/bin/sh
# The skill reads `references/<provider>.md` for the `provider` that
# `blixel agent connect` answers, and the generic recipe in SKILL.md for any other.
root=$(cd "$(dirname "$0")/.." && pwd -P)
skill=$root/skills/connect-agent
failed=0

fail() { echo "FAIL: $1"; failed=1; }

# Every fixed `provider` the CLI answers, one per session variable it knows. Any other
# comes from BLIXEL_AGENT_PROVIDER, or is `agent`, and takes the generic recipe.
providers='claude codex opencode pi hermes'

for provider in $providers; do
	[ -s "$skill/references/$provider.md" ] || fail "no reference for the provider $provider"
done
for file in "$skill"/references/*.md; do
	name=${file##*/}
	case " $providers " in
	*" ${name%.md} "*) ;;
	*) fail "references/$name is named for no provider, so the skill never reads it" ;;
	esac
done

grep -qF 'read `references/<provider>.md` beside this file' "$skill/SKILL.md" ||
	fail "SKILL.md does not send the model to the provider's reference"
grep -qF 'tell the user their agent can'"'"'t receive handoffs' "$skill/SKILL.md" ||
	fail "SKILL.md has no last resort for an agent with no reference"

# SKILL.md is what every agent shares; each agent's part is in its reference.
awk '/^---$/ { n++; next } n >= 2' "$skill/SKILL.md" |
	grep -nwE 'Claude|Codex|OpenCode|Hermes|pi|Kimi' >"${TMPDIR:-/tmp}/references.$$" &&
	fail "SKILL.md names an agent: $(cat "${TMPDIR:-/tmp}/references.$$")"
rm -f "${TMPDIR:-/tmp}/references.$$"

# Commands and fields the CLI no longer has.
grep -rnE 'agent (follow|relay|ack)\b|--approval|context\.reference|monitor_stopped|follower_attached' \
	"$skill/SKILL.md" "$skill/references" >"${TMPDIR:-/tmp}/references.$$" &&
	fail "the skill uses what the CLI no longer has: $(cat "${TMPDIR:-/tmp}/references.$$")"
rm -f "${TMPDIR:-/tmp}/references.$$"

[ "$failed" = 0 ] && echo "references: pass"
exit "$failed"
