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
too, and points to `/blixel:connect` while Blixel is in one this session is not
connected to. Without mods, those commands ask Claude to use the skill, and
the plugin's monitor delivers the handoffs. Where plugin monitors don't run
either, as in the Claude desktop app, the skill starts a Monitor for them and
starts it again each time Claude Code stops it after 30 minutes. Without the mod,
the session needs Claude Code monitors: before Claude Code 2.1.310 they don't run
when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, or on
Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry. If handoffs stop arriving, run
`/blixel:connect` again. With Claude Code's Bash sandbox on, add the socket
path that `blixel agent connect` reports to `sandbox.network.allowUnixSockets`.

Installed as a skill only (`npx skills add`), connecting still works, but after `/clear` or a compaction ask the session to connect to Blixel again, or it will not act on the handoffs it keeps receiving.

In Codex, ask the session to connect to the Blixel call. Blixel queues each
handoff into that thread with `codex queue`, and Codex runs it after any turn in
progress. Codex's sandbox blocks Blixel's local socket, so approve running
`blixel agent` outside the sandbox when Codex asks; if it can't ask, run
`/permissions` and choose Approve for me. A plain `codex` session runs on Codex's
shared app-server, where a handoff still runs after you close its terminal, so ask
the session to disconnect before you close it.

## Releasing

Each platform has its own manifests, and both point at the same `skills/`:

| | Marketplace | Plugin |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` |
| Codex | `.agents/plugins/marketplace.json` | `.codex-plugin/plugin.json` |

Installs are cached by `version`, so raise it in both `plugin.json` files
together, or users of one platform keep the old skill.

`hooks/register.tsx` is the mod; `claude plugin test .` runs its tests in `tests/`,
and `claude plugin validate .` checks it the way Claude Code loads it.
`tests/session-start.sh` tests the hook that runs after `/clear` or a compaction.

`skills/connect-agent/SKILL.md` holds what every agent shares; each agent's part is
in `references/`, the file `blixel agent whoami` names.

`skills/blixel/scripts/blixel` and `skills/connect-agent/scripts/blixel` are the
same script, so each skill works installed on its own; change them together.
`bin/blixel` links to the first, putting `blixel` on the Claude Code Bash tool's
`PATH`.
