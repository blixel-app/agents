# Blixel skills

Agent skills for [Blixel](https://blixel.app). They work with Claude Code, Codex
and any other agent that reads `SKILL.md` skills.

| Skill | What it does |
| --- | --- |
| [`blixel`](skills/blixel/SKILL.md) | Uses the `blixel` CLI to list rooms and who is in them, check the current meeting, read, follow and post to its chat, share windows into it, search, read, export or follow transcripts, and set up hooks that run a command when something happens. |
| [`connect-agent`](skills/connect-agent/SKILL.md) | Connects a Claude Code or Codex session to your current Blixel meeting, so people in the call can hand it spoken requests. |

## Requirements

[Blixel](https://blixel.app) 0.12 or later on this Mac. Installing the plugin, or
the skills, is the only setup: they find Blixel's `blixel` command themselves.

To type `blixel` in your own terminal, install Blixel with Homebrew
(`brew install --cask blixel-app/tap/blixel`) or with
`curl -fsSL https://blixel.app/install.sh | sh`; both also put the command on your
`PATH`.

## Install

Claude Code:

```sh
claude plugin marketplace add blixel-app/skills
claude plugin install blixel@blixel-app
```

Codex:

```sh
codex plugin marketplace add blixel-app/skills
codex plugin add blixel@blixel-app
```

Any other agent that reads `SKILL.md` skills:

```sh
npx skills add blixel-app/skills
```

Or copy `skills/blixel` into the agent's skills folder.

## Then ask your agent

- "Summarise my last Blixel call and post the action items to the chat."
- "What have people said in the call's chat so far?"
- "Who's in the design room right now?"
- "Share my Figma window into the call."
- "What did we decide about the release in yesterday's standup?"

The agent asks before anything that others in the call will see: chat messages
and window sharing.

## Connecting Claude Code or Codex to a call

Run `/blixel:connect` in the Claude Code session that should take requests while
Blixel is in a meeting, or ask it to connect to Blixel. People in the call can then speak or type a request
to it from Blixel; each arrives in that session through its "Blixel handoffs"
monitor as the message you set in Blixel's Settings › Agents, the request alone by
default. The skill tells the agent it is a colleague's suggestion rather than your
instruction, and the agent asks you before anything destructive. A meeting has one
connected session: connecting another replaces it. Leaving the room ends the
connection.

In Claude Code with mods on, in the terminal or the desktop app, the plugin's mod
delivers each handoff as a prompt of its own, after any turn in progress, worded
exactly as your message template in Blixel's Settings › Agents makes it. After you
stop a turn with Esc, Claude Code holds back new prompts until you send a message,
so a handoff waits for that, and the status line says so. `/blixel:connect
[ask|direct]`, `/blixel:status` and `/blixel:disconnect` connect, check and
disconnect without asking Claude, and the Blixel pane, which `/blixel:status`
opens (and, in the desktop app, connecting), shows the meeting and the handoffs
it sent this session, each with who sent it. The status line names the meeting
too. Nothing runs for Blixel in a session until you connect it, or ask it to, and
everything stops when the connection ends; `/blixel:status` reads once. Claude Code
binds a connection to its process, so a session resumed with `claude --resume`
connects again. Without mods, `/blixel:connect` connects before Claude answers, the other two
commands ask Claude to use the skill, and the plugin's monitor delivers the handoffs. Where plugin monitors don't run
either, as in the Claude desktop app, the skill starts a Monitor for them and
starts it again each time Claude Code stops it after 30 minutes. Without the mod,
the session needs Claude Code monitors: before Claude Code 2.1.310 they don't run
when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or on
Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry. If handoffs stop arriving, run
`/blixel:connect` again. With Claude Code's Bash sandbox on, add the socket
path that `blixel agent connect` reports to `sandbox.network.allowUnixSockets`.

Installed as a skill only (`npx skills add`), connecting still works, but after `/clear` or a compaction ask the session to connect to Blixel again, or it will not act on the handoffs it keeps receiving.

In Codex, trust the plugin's hooks when Codex asks at start, or later in `/hooks`,
and again after an update that changes them: without them no handoff arrives. Then
pick `$blixel:connect` (type `$con`, then Enter twice), with `ask` or `direct` after
it to choose whether Blixel asks you before each handoff. Typing `connect blixel`,
`blixel connect` or `blixel:connect` as a prompt of its own does the same, and
`$blixel:status` and `$blixel:disconnect` check and disconnect. None of these calls a
model. Nothing runs for Blixel in a session until you connect it or ask it to, beyond
a filter of about 6 ms on each prompt and shell command, and everything stops when
the connection ends. The hooks follow the thread and queue each handoff into it with
`codex queue`, and Codex runs it after any turn in progress. You can also ask the
session to connect to the Blixel call; Codex's sandbox blocks Blixel's local socket,
so approve running the CLI inside Blixel.app outside the sandbox when Codex asks; if
it can't ask, run `/permissions` and choose Approve for me. If you take over 2 minutes
to approve, connect again. Codex needs Blixel in `/Applications` or `~/Applications`. A plain `codex` session runs on Codex's shared app-server,
where a handoff still runs after you close its terminal, so ask the session to
disconnect before you close it. After `/new` or `/resume`, handoffs stay with the
conversation that connected: `$blixel:status` says so, and connecting from the new
one moves them.

## Releasing

Each platform has its own manifests. Claude Code's plugin is this repository;
Codex's is `codex/`, because Codex asks its users to trust hooks again when anything
in its plugin's root changes, and a change to the mod must not do that:

| | Marketplace | Plugin |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` |
| Codex | `.agents/plugins/marketplace.json` | `codex/.codex-plugin/plugin.json` |

Installs are cached by `version`, so raise each `plugin.json` whose plugin changed, or
its users keep the old one. Leave Codex's alone unless something in `codex/` changed,
a skill's copy included: raising it makes Codex ask to trust the hooks again.

`hooks/register.tsx` is the mod; `claude plugin test .` runs its tests in `tests/`,
and `claude plugin validate .` checks it the way Claude Code loads it.
`tests/session-start.sh` tests the hook that runs after `/clear` or a compaction,
`tests/connect.sh` the scripts behind `/blixel:connect`, and `tests/codex-hooks.sh`
Codex's hooks in `codex/`. `codex/skills/` is a copy of `skills/`, as Codex drops
symlinks when it installs a plugin: run `scripts/codex-skills.sh` after changing a
skill, and the test fails if you don't. `codex/codex-skills/` holds what Codex alone
lists, the skills behind `$blixel:connect` and the rest. Hooks run outside Codex's
sandbox, so they ignore the session's PATH and take the CLI inside Blixel.app, and each
filter in `codex/hooks.json` names its commands by full path; `BLIXEL_HOOK_PATH`, set
where Codex starts, replaces their PATH to test a development build. The same goes for
what the skills have Codex run outside its sandbox: an approved bare `blixel` runs
whatever PATH holds, so they name the CLI by full path, and a development build's has
to be named to the session.

`skills/connect-agent/SKILL.md` holds what every agent shares; each agent's part is
in `references/`, the file a failed `blixel agent connect` names.

Connecting takes at most one model step before `blixel agent connect`. Each release
compares real connect times with the last one.

`skills/blixel/scripts/blixel` and `skills/connect-agent/scripts/blixel` are the
same script, so each skill works installed on its own; change them together.
`bin/blixel` links to the first, putting `blixel` on the Claude Code Bash tool's
`PATH`.
