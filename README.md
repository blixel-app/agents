# Blixel skills

Two things for coding agents on a Mac with [Blixel](https://blixel.app):

- **Use Blixel from your agent.** The `blixel` skill drives the `blixel` CLI: rooms,
  chat, transcripts, window sharing, hooks. Any agent that reads `SKILL.md` skills can
  use it.
- **Connect a session to a call.** People in the meeting speak or type to your session,
  and what they say arrives in it as a handoff. This is `connect-agent`. It works with the
  skills alone in Claude Code, Codex and OpenCode; the plugin for your agent makes it
  faster, and pi needs it.

| Skill | What it does |
| --- | --- |
| [`blixel`](skills/blixel/SKILL.md) | Lists rooms and who is in them, checks the current meeting, reads, follows and posts to its chat, shares windows into it, searches, reads, exports or follows transcripts, and sets up hooks that run a command when something happens. |
| [`connect-agent`](skills/connect-agent/SKILL.md) | Connects this session to your current meeting and receives its handoffs, so people in the call can speak or type to it. |

## Install

| Agent | Install |
| --- | --- |
| Claude Code | `claude plugin marketplace add blixel-app/skills`, then `claude plugin install blixel@blixel-app` |
| Claude desktop app | In the **Code** tab: **+** → **Add plugins** → **Add marketplace** → **Add from a repository**, enter `blixel-app/skills`, then install **blixel** |
| Codex | `codex plugin marketplace add blixel-app/skills`, then `codex plugin add blixel@blixel-app` |
| Codex in the ChatGPT app | **Plugins** → **Add** → **Add a marketplace**, enter `blixel-app/skills`, then install **Blixel** |
| pi | `pi install git:github.com/blixel-app/skills` |
| OpenCode 2 | `opencode plugin add 'git+https://github.com/blixel-app/skills.git'` |
| Any other agent, or skills only | `npx skills add blixel-app/skills`, or copy `skills/blixel` into the agent's skills folder |

Installing is the only setup: the plugin and the skills find Blixel's `blixel` command
themselves. Start a new session after installing. In Codex, also trust the plugin's
two hooks: run `/hooks`, or click **Review hooks** in the ChatGPT app, as
[below](#codex). In OpenCode, restart its background service so it loads the plugin.

The CLI needs Blixel 0.12 or later. Connecting a session needs 0.17 or later, in
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

While Blixel is in a meeting, connect the session that should take handoffs. People in
the call can then speak or type to it from Blixel, and each handoff arrives in the
session as your own prompt, worded as the message you set in Blixel's Settings ›
Agents, the handoff alone by default. The agent handles it as it would anything you
typed. Whether Blixel shows you each handoff first is chosen in the app, in Settings ›
Agents or the call's ✦ Agent menu, never by the agent.

- A meeting has one connected session: connecting another replaces it. Leaving the room
  ends the connection.
- Nothing runs for Blixel in a session until you connect it, and everything stops when
  the connection ends.

### Connect, then receive

Connecting takes two of the CLI's commands. `blixel agent connect` connects the session
and exits. `blixel agent receive` then keeps running in the background inside the agent
and receives the handoffs. The plugin runs both for you; with the skills alone, the
model runs `connect` and starts `receive` as a background command.

A session can be connected and **not receiving**: it holds the meeting's connection,
but no `receive` runs for it, so handoffs don't reach it. A handoff sent then waits up
to 10 seconds for a receiver, and its sender hears it wasn't delivered. Blixel shows it
under **My agent** in the ✦ Agent menu as **Not receiving**, and the status command or
`blixel agent status` says so too. It happens when:

- The agent can't run a background command, as pi without its package.
- You declined the command that starts `receive`.
- `receive` stopped, as when Claude Code ends a Monitor after 30 minutes and the model
  hasn't started it again yet.

To fix it, connect again (the command, or ask), which starts `receive`; install the
plugin where the agent needs it; or disconnect.

### Commands and phrases

With the plugin, you can connect, check and disconnect without asking the model in
words. Two ways to say it:

- **The command:** `/blixel:connect`, `/blixel:status`, `/blixel:disconnect`. Codex has
  no plugin commands, so there it is `$blixel:connect` and so on: type `$con`, then
  Enter twice, or pick it from the `$` list in Codex desktop.
- **A phrase, as a whole prompt in any case:** `connect blixel`, `blixel connect` or
  `blixel:connect`, and the same with `status` and `disconnect`. In OpenCode this works
  in its terminal, not in its web or desktop apps.

Either has to be the whole prompt: with more words, it goes to the model, which uses the
skill as when you ask in words. In Codex, a handoff that is exactly a command or a
phrase runs it, as Codex can't tell a handoff from what you typed; in the other agents
it reaches the agent as a handoff like any other.

### What you get on each agent

With the plugin:

| Agent | A command or phrase | Asked in words | A handoff arrives as |
| --- | --- | --- | --- |
| Claude Code, mods on (terminal and desktop) | The mod answers, with no model step | Claude uses the skill; the mod takes over its `connect` and receives | Your prompt |
| Claude Code, mods off | `/blixel:connect` asks Claude, which starts a Monitor; status and disconnect ask Claude; phrases reach Claude as a prompt | Claude uses the skill and starts a Monitor | A Monitor's notification, on one line |
| Codex (terminal and desktop) | The hooks run it, and a connect receives within 2 seconds; Codex then says their answer in one short reply that runs nothing and asks no approval | Codex uses the skill, with two approvals | Your prompt, queued into the thread |
| pi | The extension answers, with no model step | pi uses the skill; the extension takes over its `connect` and receives | Your prompt |
| OpenCode (terminal and desktop) | The server plugin answers, with no model step; phrases in its terminal only | OpenCode uses the skill; the plugin takes over its `connect` and receives | Your prompt |

With the skills alone, you ask in words. Measured with a real model and a plain "connect
this session to my Blixel call", in each agent's default permission mode:

| Agent | Receives through | Model steps | Approvals | Seconds to receiving | A handoff arrives as |
| --- | --- | --- | --- | --- | --- |
| Claude Code | A Monitor the model starts | 5 | 2: the skill, and the connect | About 50, most of it the approvals | A Monitor's notification, on one line |
| Codex | `receive` the model starts outside the sandbox | 4 | 2: `connect` and `receive` outside the sandbox | About 40, most of it the approvals | Your prompt, queued into the thread |
| OpenCode | `receive` the model starts as a background shell | 4 | 0 | About 13 | Your prompt |
| pi | Nothing: it connects, then shows not receiving, and the agent tells you to install the package | — | — | — | — |

Any other agent that reads `SKILL.md` skills and can run a background command gets the
same route from the skill; one that can't connects and shows not receiving.

| | Claude Code, mods on | Claude Code, mods off | Codex | pi | OpenCode | Skills only |
| --- | --- | --- | --- | --- | --- | --- |
| Meeting in the status line, Blixel pane | Yes | No | No | No | No | No |
| Runs before you connect | Nothing | Nothing | A filter on each prompt | Nothing | Nothing | Nothing |

### How each piece works

- **Skill:** instructions the agent reads when it needs them. Using one takes a model
  turn.
- **Plugin:** what you install to add commands and code to an agent.
- **Mod (Claude Code):** the plugin's code, running inside the session. It answers
  commands and phrases, receives handoffs, and submits them as prompts.
- **Monitor (Claude Code):** a background command whose output reaches the session line
  by line.
- **Hooks (Codex):** commands Codex runs at set moments, once you trust them. The first
  answers a command; the second, started by a connect, keeps `receive` running.
- **Extension (pi):** the package's code, running inside pi.
- **Server plugin (OpenCode):** the package's code, running in OpenCode's server, where
  sessions live whichever app shows them. A small terminal part catches phrases.

| Agent | Answers commands | Runs `blixel agent receive` | Delivers a handoff |
| --- | --- | --- | --- |
| Claude Code, mods on | The mod | The mod | Submits a prompt |
| Claude Code, mods off or skills only | The model | A Monitor the model starts | Monitor notification |
| Codex | The first hook, then the model in one line | The second hook | `codex queue` |
| Codex, skills only | The model | A command the model starts outside the sandbox | `codex queue` |
| pi | The extension, or the model's own command | The extension | `pi.sendUserMessage` |
| OpenCode | The server plugin, or the model's own command | The server plugin | `session.prompt` |
| OpenCode, skills only | The model | A background shell the model starts | OpenCode's server |

### Claude Code

- **Handoffs and Esc:** after you stop a turn with Esc, Claude Code holds back new
  prompts until you send a message, so a handoff waits for that, and Blixel says so.
- **The pane:** `/blixel:status` opens the Blixel pane, as does connecting in the
  desktop app. It shows the meeting and the handoffs this session received, each with
  who sent it.
- **Phrases:** Claude Code shows the answer as "Prompt dropped by a hook: …". That is
  how a plugin stops a prompt, and nothing went wrong.
- **Resuming:** a connection belongs to the process, so a session resumed with
  `claude --resume` connects again.
- **Mods off, or the skills alone:** Claude starts a Monitor named "Blixel handoffs"
  running `blixel agent receive --print-handoffs`. Claude Code stops it after 30
  minutes, and Claude starts it again through the skill: in a permission mode that asks,
  that is one "Use skill?" prompt each time, unless you chose not to be asked again for
  connect-agent. A handoff arrives as a notification from the Monitor, with its line
  breaks turned into spaces. `/clear` keeps the Monitor running. With the plugin, Claude
  is reminded how to handle it after `/clear` or a compaction; with the skills alone,
  ask it to connect again after a compaction.
- **Disconnecting in words:** Claude may ask you to approve the command. With mods on,
  Blixel shows a toast once it is disconnected.
- **Sandbox:** with the Bash sandbox on, add the socket path that
  `blixel agent connect` reports to `sandbox.network.allowUnixSockets`.

If handoffs stop arriving, run `/blixel:connect` again.

### Codex

- **Trust the hooks first:** without them, commands go to the model and connect as when
  you ask in words. Trust them when Codex asks at start ("2 hooks are new or changed"),
  or later in `/hooks` (**Review hooks** in the ChatGPT app). Codex asks again after any
  update of the plugin; until then Codex desktop reports "plugin contents changed; hook
  approval required".
- **Commands:** the first hook runs the command and, for a connect, the second starts
  receiving, before the model's turn. Codex then says the hooks' answer in one line, which takes a few
  seconds and asks nothing. A command picked from the `$` list in Codex desktop works
  the same as a typed one.
- **Handoffs:** each one is queued into the thread as your prompt, line breaks kept,
  and Codex runs it after any turn in progress. After you stop a turn with Esc, a
  handoff waits for your next message.
- **Asking in words:** Codex asks twice to run Blixel outside its sandbox, which blocks
  Blixel's local socket: once to connect, once to receive. Approve both. If it can't
  ask, run `/permissions` and choose Approve for me.
- **Closing the window:** Codex sessions run on an app-server that outlives what shows
  them: a plain `codex` session runs on Codex's shared app-server, and Codex desktop on
  the ChatGPT app's. A connected thread still runs handoffs after you close its
  terminal or window. Disconnect before you close it. `codex --no-daemon` ends the
  connection when it quits.
- **New conversations:** after `/new` or `/resume`, handoffs stay with the conversation
  that connected. `$blixel:status` says so, and connecting from the new one moves them.

### pi

- **Install the package to receive:** pi can't run a background command, so with the
  skills alone a session connects but shows not receiving, and the agent asks you to
  install the package.
- **Handoffs:** each arrives as a prompt, after any turn in progress. Esc puts one still
  waiting back in your editor unrun.
- **New sessions:** quitting pi or starting a new session (`/new`, `/resume`, `/fork`)
  ends the connection.

### OpenCode

- **Answers:** a command answers as a notice in the conversation. The model sees the
  notice with your next prompt or handoff, and it starts no turn of its own. OpenCode
  desktop collapses the notices under an "Updates" row: open it to read them.
- **Handoffs:** each arrives the way you typing would: it starts a turn, or joins the turn
  in progress at its next step.
- **The skills alone** need OpenCode's background service, which its terminal and
  desktop apps use by default. Under `opencode --standalone` or a plain
  `opencode serve`, install the plugin.
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
a skill's copy included: each such update makes Codex ask its users to trust the hooks
again, whatever the change.

`hooks/register.tsx` is the mod; `claude plugin test .` runs its tests in `tests/`,
and `claude plugin validate .` checks it the way Claude Code loads it.
`tests/session-start.sh` tests the hook that runs after `/clear` or a compaction,
`tests/claude-routes.sh` every Claude Code route against a planted PATH,
`tests/references.sh` that every `provider` the CLI answers has its reference,
`tests/deliver-codex.sh` and `tests/deliver-opencode.sh` the programs `receive` runs for
each handoff with the skills alone, `tests/codex-hooks.sh` Codex's hooks in `codex/`,
and `tests/plugins.sh` the pi package in `pi/` and the OpenCode package in `opencode/`:
it runs `tests/*.spec.ts` under Node's own test runner (Node 24 or later), as
`claude plugin test` loads no `node:` module, with each plugin in-process against a
fake of its agent's plugin API and a stand-in `blixel`. No test runs a real agent.

Manual checks before a release, as only a real agent shows them, each with a
development build named by `BLIXEL_HOOK_PATH` and a scratch agent config:

- pi: `pi install .` lists the three commands and both skills; the model's `bash`
  names the session with `PI_SESSION_ID`; a gate installed before or after Blixel's
  that blocks the model's connect leaves it unconnected; a handoff during a turn waits
  for it, and Esc puts it back in the editor; `/reload` keeps receiving with no connect.
- OpenCode: the server lists the three commands and both skills; each shell, two
  sessions' at once included, names its session with `OPENCODE_SESSION_ID`; a denied
  or declined connect never runs; a connect's answer and the handoff after it take one
  model turn; a handoff during a turn reaches the model after it; the model is told of
  the skills; stopping the server ends its receivers; an idle location unloaded and
  loaded again keeps receiving.
- OpenCode's terminal: a phrase runs its command with no model turn, and in `!` shell
  mode runs as typed.
- OpenCode with the skills alone: the model connects, starts `receive` with
  `deliver/opencode.sh` in a background shell of `opencode serve --service`, and a
  handoff arrives byte for byte.

`codex/skills/` is a copy of `skills/`, as Codex drops symlinks when it installs a plugin:
run `scripts/codex-skills.sh` after changing a skill, and the test fails if you don't. `codex/codex-skills/` holds what Codex alone
lists, the skills behind `$blixel:connect` and the rest. Hooks run outside Codex's
sandbox, so they ignore the session's PATH and take the CLI inside Blixel.app, and each
filter in `codex/hooks.json` names its commands by full path; `BLIXEL_HOOK_PATH`, set
where Codex starts, replaces their PATH to test a development build. The same goes for
what the skills have Codex run outside its sandbox: an approved bare `blixel` runs
whatever PATH holds, so they name the CLI by full path, and a development build's has
to be named to the session.

Claude Code runs its hooks and the mod outside its sandbox too.
They source `skills/connect-agent/scripts/path.sh` or go through `app-cli` beside it,
which ignore the session's PATH and take the CLI inside Blixel.app, in `/Applications`
or `~/Applications`. To test a development build, start Claude Code with
`BLIXEL_HOOK_PATH=<folder holding its blixel>:/usr/bin:/bin:/usr/sbin:/sbin`: that
covers the hooks and the mod. The skill and its `allowed-tools`
name the CLI by full path, so a development build's has to be named to the session
there, and it asks before it runs. `tests/claude-routes.sh` fails if a route goes back
to a bare `blixel`.

Every adapter lets the model do all a person can: asked in words, it connects, checks and
disconnects. Commands and phrases are a shortcut past the model, never the only route.

`skills/connect-agent/SKILL.md` holds what every agent shares, and no skill's text names
an agent: each agent's part is in `references/`, in the file named for the
`provider` that `blixel agent connect` answers. The CLI knows nothing of this
repository: it names no file and suggests no agent's next step.

A typed connect takes no model step, except in Codex: there the hook connects and the
model says its answer in one reply that runs nothing, as Codex desktop shows a hook's
answer nowhere else. Asked in words it takes the steps of reading the skill and its
reference, then running `connect` and starting `receive`. Each release compares real connect times with
the last one.

`skills/blixel/scripts/blixel` and `skills/connect-agent/scripts/blixel` are the
same script, so each skill works installed on its own; change them together.
`bin/blixel` links to the first, putting `blixel` on the Claude Code Bash tool's
`PATH`, for commands the model runs in the sandbox. Both look on `PATH` first, so
nothing outside a sandbox reaches them with the session's.
