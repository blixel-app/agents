# Blixel skills

Two things for coding agents on a Mac with [Blixel](https://blixel.app):

- **Use Blixel from your agent.** The `blixel` skill drives the `blixel` CLI: rooms,
  chat, transcripts, window sharing, hooks. Any agent that reads `SKILL.md` skills can
  use it.
- **Connect a session to a call.** People in the meeting speak or type a request, and
  it arrives in your session as a handoff. This is `connect-agent`, and it works best
  with the plugin for your agent.

| Skill | What it does |
| --- | --- |
| [`blixel`](skills/blixel/SKILL.md) | Lists rooms and who is in them, checks the current meeting, reads, follows and posts to its chat, shares windows into it, searches, reads, exports or follows transcripts, and sets up hooks that run a command when something happens. |
| [`connect-agent`](skills/connect-agent/SKILL.md) | Connects this session to your current meeting, so people in the call can hand it spoken or typed requests. |

## Install

| Agent | Install |
| --- | --- |
| Claude Code | `claude plugin marketplace add blixel-app/skills`, then `claude plugin install blixel@blixel-app` |
| Codex | `codex plugin marketplace add blixel-app/skills`, then `codex plugin add blixel@blixel-app` |
| pi | `pi install git:github.com/blixel-app/skills` |
| OpenCode 2 | `opencode plugin add 'git+https://github.com/blixel-app/skills.git'` |
| Any other agent, or skills only | `npx skills add blixel-app/skills`, or copy `skills/blixel` into the agent's skills folder |

Installing is the only setup: the plugin and the skills find Blixel's `blixel` command
themselves. In Codex, also trust the plugin's hooks, as [below](#codex).

The CLI needs Blixel 0.12 or later. Connecting a session needs 0.16 or later, in
`/Applications` or `~/Applications`.

## Use Blixel from your agent

Ask in your own words:

- "Summarise my last Blixel call and post the action items to the chat."
- "What have people said in the call's chat so far?"
- "Who's in the design room right now?"
- "Share my Figma window into the call."
- "What did we decide about the release in yesterday's standup?"

The agent asks before anything that others in the call will see: chat messages and
window sharing.

To type `blixel` in your own terminal, install Blixel with Homebrew
(`brew install --cask blixel-app/tap/blixel`) or with
`curl -fsSL https://blixel.app/install.sh | sh`; both also put the command on your
`PATH`.

## Connect a session to a call

While Blixel is in a meeting, connect the session that should take requests. People in
the call can then speak or type to it from Blixel. Each request arrives as a handoff,
worded as the message you set in Blixel's Settings › Agents, the request alone by
default.

- The agent treats a handoff as a colleague's suggestion, not your instruction, and
  asks you before anything destructive.
- A meeting has one connected session: connecting another replaces it. Leaving the room
  ends the connection.
- Nothing runs for Blixel in a session until you connect it, and everything stops when
  the connection ends.

### Connect without a model turn

With the plugin, you can connect, check and disconnect without calling a model, so it
answers at once and spends no tokens. Two ways to say it:

- **The command:** `/blixel:connect`, `/blixel:status`, `/blixel:disconnect`. Codex has
  no plugin commands, so there it is `$blixel:connect` and so on: type `$con`, then
  Enter twice.
- **A phrase, as a whole prompt in any case:** `connect blixel`, `blixel connect` or
  `blixel:connect`, and the same with `status` and `disconnect`. In OpenCode this works
  in its terminal, not in its web or desktop apps.

Add `ask` or `direct` after connect to choose whether Blixel asks you before each
handoff. A handoff that says one of these phrases doesn't run it: it reaches the agent as a
request like any other.

### What you get on each agent

| Feature | Claude Code, mods on | Claude Code, mods off | Codex | pi | OpenCode | Skills only |
| --- | --- | --- | --- | --- | --- | --- |
| Connect by command | No model | Connects, then Claude answers | No model | No model | No model | None |
| Status and disconnect by command | No model | Asks Claude | No model | No model | No model | None |
| Phrases | No model | Reach Claude as a prompt | No model | No model | No model in its terminal | Reach the model as a prompt |
| Asking in words | Claude uses the skill | Claude uses the skill | Codex uses the skill, with your approval | pi uses the skill | OpenCode uses the skill | Claude Code only |
| A handoff arrives as | A prompt of its own | A monitor's notification | A queued message | A prompt of its own | A prompt, at the next step of any turn | A monitor's notification |
| Handoff rules kept after `/clear` or a compaction | Yes | Yes | Yes | Yes | Yes | No: connect again |
| Meeting in the status line, Blixel pane | Yes | No | No | No | No | No |
| Runs before you connect | Nothing | Nothing | A 6 ms filter on each prompt and shell command | Nothing | Nothing | Nothing |

Without the plugin there are no commands or phrases to catch, so everything goes through
a normal model turn. That works in Claude Code, where the skill starts a monitor itself.
Codex, pi and OpenCode need the plugin to receive handoffs, so with the skills alone they
only get the `blixel` skill, as does any other agent.

### How each piece works

- **Skill:** instructions the agent reads when it needs them. Using one takes a model
  turn.
- **Plugin:** what you install to add commands and code to an agent.
- **Mod (Claude Code):** the plugin's code, running inside the session. It answers
  commands and phrases, follows the call, and submits handoffs as prompts.
- **Monitor (Claude Code):** a background command whose output reaches the session line
  by line.
- **Hooks (Codex):** commands Codex runs at set moments, once you trust them.
- **Extension (pi):** the package's code, running inside pi.
- **Server plugin (OpenCode):** the package's code, running in OpenCode's server, where
  sessions live whichever app shows them. A small terminal part catches phrases.
- **Relay:** `blixel agent relay`, which follows the call and runs a small program for
  each handoff. It exits by itself when the session goes.

| Agent | Answers commands | Follows the call | Delivers a handoff |
| --- | --- | --- | --- |
| Claude Code, mods on | The mod | The mod | Submits a prompt |
| Claude Code, mods off | A hook and the command's `!` line | The plugin's monitor | Monitor notification |
| Claude Code, skills only | The model | A Monitor the model starts | Monitor notification |
| Codex | Hooks | A relay in an async hook | `codex queue` |
| pi | The extension, or the model's own command | A relay the extension starts | `pi.sendUserMessage` |
| OpenCode | The server plugin, or the model's own command | A relay the server plugin starts | `session.prompt` |

### Claude Code

- **Handoffs and Esc:** after you stop a turn with Esc, Claude Code holds back new
  prompts until you send a message, so a handoff waits for that, and the status line
  says so.
- **The pane:** `/blixel:status` opens the Blixel pane, as does connecting in the
  desktop app. It shows the meeting and the handoffs this session received, each with
  who sent it.
- **Phrases:** Claude Code shows the answer as "Prompt dropped by a hook: …". That is
  how a plugin stops a prompt, and nothing went wrong.
- **Resuming:** a connection belongs to the process, so a session resumed with
  `claude --resume` connects again.
- **Monitors off:** where plugin monitors don't run, as in the Claude desktop app, the
  skill starts a Monitor, and starts it again each time Claude Code stops it after 30
  minutes.
- **No mod:** the session needs Claude Code monitors. Before Claude Code 2.1.310 they
  don't run when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is
  set, or on Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry.
- **Sandbox:** with the Bash sandbox on, add the socket path that
  `blixel agent connect` reports to `sandbox.network.allowUnixSockets`.

If handoffs stop arriving, run `/blixel:connect` again.

### Codex

- **Trust the hooks first:** without them no handoff arrives. Trust them when Codex asks
  at start, or later in `/hooks` (**Review hooks** in the ChatGPT app), and again after
  an update that changes them.
- **Handoffs:** the hooks queue each one into the thread, and Codex runs it after any
  turn in progress. It takes a few seconds to start.
- **Asking in words:** Codex's sandbox blocks Blixel's local socket, so the first
  attempt fails and takes a few more seconds. Approve running the CLI outside the
  sandbox when Codex asks; if it can't ask, run `/permissions` and choose Approve for
  me. If you take over 2 minutes to approve, connect again.
- **Closing the terminal:** a plain `codex` session runs on Codex's shared app-server,
  where a handoff still runs after you close its terminal. Disconnect before you close
  it.
- **New conversations:** after `/new` or `/resume`, handoffs stay with the conversation
  that connected. `$blixel:status` says so, and connecting from the new one moves them.

### pi

- **Handoffs:** each arrives as a prompt, after any turn in progress. Esc puts one still
  waiting back in your editor unrun.
- **New sessions:** quitting pi or starting a new session (`/new`, `/resume`, `/fork`)
  ends the connection.

### OpenCode

- **Answers:** a command answers as a notice in the conversation. The model sees the
  notice with your next prompt or handoff, and it starts no turn of its own.
- **Handoffs:** each arrives the way you typing would: it starts a turn, or joins the turn
  in progress at its next step.
- **Closing the terminal:** the connection belongs to the session on OpenCode's server,
  which keeps running, so a handoff still runs after you close the terminal. Disconnect
  before you close it. With `opencode --standalone`, closing it ends the connection.
- **Other sessions:** each session connects on its own, so a new or resumed one keeps
  handoffs in the session that connected. `/blixel:status` says so, and connecting from
  the other one moves them.
- **Stopping the server:** `opencode service stop` or restarting it ends the connection.

## Releasing

Each platform has its own manifests. Claude Code's plugin is this repository;
Codex's is `codex/`, because Codex asks its users to trust hooks again when anything
in its plugin's root changes, and a change to the mod must not do that:

| | Marketplace | Plugin |
| --- | --- | --- |
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` |
| Codex | `.agents/plugins/marketplace.json` | `codex/.codex-plugin/plugin.json` |
| pi | None | `package.json` |
| OpenCode | None | `package.json` |

Installs are cached by `version`, so raise each `plugin.json` whose plugin changed, or
its users keep the old one. Leave Codex's alone unless something in `codex/` changed,
a skill's copy included: raising it makes Codex ask to trust the hooks again.

`hooks/register.tsx` is the mod; `claude plugin test .` runs its tests in `tests/`,
and `claude plugin validate .` checks it the way Claude Code loads it.
`tests/session-start.sh` tests the hook that runs after `/clear` or a compaction,
`tests/connect.sh` the scripts behind `/blixel:connect`, `tests/claude-routes.sh` every
Claude Code route against a planted PATH, `tests/codex-hooks.sh` Codex's hooks in
`codex/`, `tests/pi.sh` the pi package in `pi/`, in real pi, and `tests/opencode.sh` the
OpenCode package in `opencode/`, in real OpenCode. `codex/skills/` is a copy of `skills/`, as Codex drops symlinks when it installs a plugin: run `scripts/codex-skills.sh` after changing a
skill, and the test fails if you don't. `codex/codex-skills/` holds what Codex alone
lists, the skills behind `$blixel:connect` and the rest. Hooks run outside Codex's
sandbox, so they ignore the session's PATH and take the CLI inside Blixel.app, and each
filter in `codex/hooks.json` names its commands by full path; `BLIXEL_HOOK_PATH`, set
where Codex starts, replaces their PATH to test a development build. The same goes for
what the skills have Codex run outside its sandbox: an approved bare `blixel` runs
whatever PATH holds, so they name the CLI by full path, and a development build's has
to be named to the session.

Claude Code runs its hooks, the plugin's monitor and the mod outside its sandbox too.
They source `skills/connect-agent/scripts/path.sh` or go through `app-cli` beside it,
which ignore the session's PATH and take the CLI inside Blixel.app, in `/Applications`
or `~/Applications`. To test a development build, start Claude Code with
`BLIXEL_HOOK_PATH=<folder holding its blixel>:/usr/bin:/bin:/usr/sbin:/sbin`: that
covers `/blixel:connect`, the monitor and the mod. The skill and its `allowed-tools`
name the CLI by full path, so a development build's has to be named to the session
there, and it asks before it runs. `tests/claude-routes.sh` fails if a route goes back
to a bare `blixel`.

Every adapter lets the model do all a person can: asked in words, it connects, checks and
disconnects. Commands and phrases are a shortcut past the model, never the only route.

`skills/connect-agent/SKILL.md` holds what every agent shares, and no skill's text names
an agent: each agent's part is in `references/`, the file a failed
`blixel agent connect` names.

A typed connect takes no model step, but in Codex one that runs nothing: the hook
runs the command and the model says its answer, which Codex desktop shows nowhere else. Asked in words it takes the steps of reading the
skill, and in Codex a failed try and its reference. Each release compares real connect
times with the last one.

`skills/blixel/scripts/blixel` and `skills/connect-agent/scripts/blixel` are the
same script, so each skill works installed on its own; change them together.
`bin/blixel` links to the first, putting `blixel` on the Claude Code Bash tool's
`PATH`, for commands the model runs in the sandbox. Both look on `PATH` first, so
nothing outside a sandbox reaches them with the session's.
