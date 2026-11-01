import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Panel, PanelHandoff } from '../types'
import { clock, excerpt, LOGO, wrap } from './panel'

type Handoff = { n: number; text: string }
type Queue = { next: number; pending: Handoff[] }
type Failure = { code: string; message: string; hint?: string }
type Answer = { data: Record<string, any>; error?: undefined; requestID?: undefined } | { error: Failure; requestID?: string }
type Attachment = 'attached' | 'waiting' | 'refused' | 'stopped'
type Session = {
  ready: () => Promise<boolean>
  connect: (approval: string) => Promise<string>
  disconnect: () => Promise<string>
  status: () => Promise<string>
  deliver: () => Promise<void>
  refresh: () => Promise<Answer>
  show: () => void
  ownsHandoffs: () => boolean
  connecting: () => Promise<(() => void) | undefined>
  follow: () => Promise<void>
  forget: () => Promise<void>
}

const PANE = 'blixel'
// The prompts that act with no model, the same as Codex's hooks read them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)(?: (ask|direct))?$/
const HISTORY = 20
const EMPTY: Panel = {
  app: 'unknown',
  isInMeeting: false,
  isConnected: false,
  isReconnecting: false,
  room: null,
  meeting: null,
  approval: null,
  isViaMonitor: false,
  handoffs: [],
}
// Change the tag when Panel changes: a value an earlier version wrote
// outlives a reload.
const panel = atom({ plugin: 'blixel', key: 'panel' } as const, EMPTY, { shape: 'panel-2' })
const opened = atom({ plugin: 'blixel', key: 'opened' } as const, [])

// Both of the plugin's monitors' description, and the Monitor the skill starts.
const MONITOR = 'Blixel handoffs'
const POLL_MS = 15_000
// Polls a follower with no connection outlives: the skill it started for may
// yet connect.
const IDLE_POLLS = 4
// How long loading the skill waits for the mod's follower to attach.
const ATTACH_MS = 2_000
// A /clear empties $.state just after session.end's hooks return.
const CLEARED_MS = 1_000
// After the user stops a turn, Claude Code drops the queued prompt and
// refuses new ones until the user's next input.
const STOPPED = ['the session was stopped and nobody has sent input since', 'was removed from the queue before it ran']

async function connect($: EngineInterface, session: Session, approval: string) {
  const text = await session.connect(approval)
  if ((await $.session.surfaces()).includes('desktop')) await $.ui.open({ id: PANE, title: 'Blixel' })
  return text
}

async function status($: EngineInterface, session: Session) {
  const text = await session.status()
  await $.ui.open({ id: PANE, title: 'Blixel' })
  return text
}

function failure(error: Failure) {
  switch (error.code) {
    case 'not_in_meeting':
      return 'Blixel is not in a meeting. Join a room in the app, then run /blixel:connect again.'
    case 'app_unavailable':
      return 'The Blixel app is not running. Open it and try again.'
    case 'monitor_not_running':
      return "Blixel could not reach this session's follower. Run /blixel:status, then /blixel:connect again."
    default:
      return error.hint ? `${error.message}. ${error.hint}` : error.message
  }
}

/** Hands each complete line to `take` and returns what follows the last newline. */
function lines(text: string, take: (line: string) => void) {
  const parts = text.split('\n')
  const rest = parts.pop() ?? ''
  for (const line of parts) take(line)
  return rest
}

function jsonLines(text: string): Record<string, any>[] {
  return text.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line)
      return value && typeof value === 'object' ? [value] : []
    } catch {
      return []
    }
  })
}

function queueFrom(value: unknown): Queue {
  const queue = value as Queue | undefined
  if (!queue || !Number.isInteger(queue.next) || !Array.isArray(queue.pending)) return { next: 1, pending: [] }
  return queue
}

function counted(n: number) {
  return `${n} handoff${n === 1 ? '' : 's'}`
}

const ACCENT = 'permission'
const MARKS = {
  delivered: { glyph: '●', color: 'success', label: 'Sent to Claude' },
  waiting: { glyph: '●', color: ACCENT, label: 'Waiting for the current turn' },
  held: { glyph: '●', color: 'warning', label: 'Waiting for your next message' },
} as const

function describe(state: Panel) {
  if (state.app === 'closed') return { headline: "Blixel isn't running", detail: 'Open the Blixel app to receive handoffs.' }
  if (state.isConnected) {
    const approval =
      state.approval === 'ask' ? 'The app asks you before each handoff' : 'Handoffs come straight to this session'
    return {
      headline: `Connected to ${state.room ?? 'your meeting'}`,
      detail: state.isViaMonitor ? `${approval}, through its monitor.` : `${approval}.`,
    }
  }
  if (state.app === 'running' && !state.isInMeeting) {
    return { headline: 'Not in a meeting', detail: 'Join a room in Blixel, then connect this session.' }
  }
  return {
    headline: state.room ? `In ${state.room}` : 'Not connected',
    detail: 'Connect so people in the meeting can hand this session requests.',
  }
}

/** The status line: the connection, then what waits. */
function statusLine(state: Panel, connected: boolean, viaMonitor: boolean, waiting: number, stopped: boolean) {
  const parts: string[] = []
  if (connected) {
    const to = state.room ? `connected to ${state.room}` : 'connected'
    parts.push(viaMonitor ? `${to}, handoffs go to its monitor` : to)
    if (state.isReconnecting) parts.push('reconnecting')
  }
  if (waiting > 0) parts.push(`${counted(waiting)} waiting${stopped ? ' for your next message' : ''}`)
  return parts.length > 0 ? `✦ ${parts.join(' · ')}` : undefined
}

export const register: Register = on => {
  let session: Session | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The desktop app hosts its sessions headless, like a -p run, which has
    // nobody to hand a prompt to and is left alone.
    if (!e.isInteractive && (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-desktop') return started

    // The mod's processes run outside the sandbox, so nothing they start may be found
    // on the session's PATH.
    const cli = `${$.plugin.root}/skills/connect-agent/scripts/app-cli`

    // Nothing runs in a session until Blixel is invoked in it.
    let pid = 0
    let key = ''
    let queue: Queue = { next: 1, pending: [] }
    // Handoffs numbered from here on may be from a connection made after a
    // connect started or a refresh asked; those before it cannot be.
    let since = queue.next
    let identified: Promise<boolean> | undefined
    const ready = () =>
      (identified ??= (async () => {
        // CLAUDE_PID is not in a mod's process environment, and a nested session
        // inherits its parent's: the mod's processes are children of this
        // session's own `claude`, the process the app checks callers against.
        const probe = await $.process
          .run(['/bin/sh', '-c', 'echo "$PPID"; exec /bin/ps -o lstart= -p "$PPID"'])
          .catch(() => undefined)
        const [pidText = '', startedAt = ''] = probe?.stdout.split('\n') ?? []
        pid = Number(pidText.trim())
        if (probe?.exitCode !== 0 || !Number.isInteger(pid) || pid <= 1) return false
        // With the start time, a later `claude` given the same pid has its own queue.
        key = `queue:${pid}:${startedAt.trim()}`
        queue = queueFrom(await $.store.get(key).catch(() => undefined))
        since = queue.next
        return true
      })())

    let acks = true
    let saving = 0
    let connected = false
    let attachment: Attachment = 'stopped'
    let delivering = false
    let stopped = false
    let disconnecting = false
    let sessionID = ''
    const before = await read($, panel)
    let view: Panel = { ...before, app: 'unknown' }

    const env = async () => {
      sessionID = (await $.session.id().catch(() => '')) || sessionID
      return { CLAUDE_PID: String(pid), CLAUDE_CODE_SESSION_ID: sessionID, CODEX_THREAD_ID: '' }
    }

    const call = async (args: string[]): Promise<Answer> => {
      const run = await $.process
        .run([cli, ...args], { env: await env(), timeoutMs: 30_000 })
        .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) }))
      const events = jsonLines(run.stderr)
      if (run.exitCode === 0) {
        const result = jsonLines(run.stdout).at(-1)
        if (result) return { data: result.data ?? {} }
      }
      return {
        error: events.findLast(event => event.error?.code)?.error ?? {
          code: 'failed',
          message: run.stderr.trim() || `blixel exited with status ${run.exitCode}`,
        },
        requestID: events.find(event => event.event === 'request_id')?.data?.request_id,
      }
    }

    const show = () => {
      // The engine puts the plugin's name in front of the line.
      $.ui.status(statusLine(view, connected, attachment === 'refused', queue.pending.length, stopped))

      const pending = new Set(queue.pending.map(one => one.n))
      view = {
        ...view,
        isConnected: connected,
        isViaMonitor: attachment === 'refused',
        handoffs: view.handoffs.map(one => ({
          ...one,
          state: !pending.has(one.n) ? 'delivered' : stopped ? 'held' : 'waiting',
        })),
      }
      void update($, panel, () => view).catch(() => undefined)
    }

    const save = () => $.store.set(key, queue).then(() => true, () => false)

    // One at a time, each a turn of its own. A prompt the session drops stays
    // queued and is submitted again once the next turn completes. A handoff
    // still being saved waits: it may yet be refused.
    const deliver = async () => {
      if (delivering) return
      delivering = true
      try {
        for (let handoff = queue.pending[0]; handoff !== undefined && saving === 0; handoff = queue.pending[0]) {
          // Worded as the user set in Blixel, which decides whether it names
          // its sender: Claude Code adds no frame of its own.
          const submitted = await $.prompt.submit({ text: handoff.text, asUser: true })
          const { drop } = submitted
          if (drop !== undefined) {
            const isStop = STOPPED.some(reason => drop.includes(reason))
            if (isStop && !stopped) $.ui.toast('A Blixel handoff is waiting: it runs after your next message.')
            stopped = isStop
            return
          }
          stopped = false
          queue = { ...queue, pending: queue.pending.filter(one => one.n !== handoff.n) }
          await save()
          show()
        }
      } catch {
        // Kept queued for the next completed turn.
      } finally {
        delivering = false
        show()
      }
    }

    // `failed` promises it will not run, so it leaves the queue only once the
    // app takes that answer: an older app has already told the sender queued.
    const refuse = async (n: number, id: number) => {
      const answer = await call(['agent', 'ack', String(id), 'failed', '--reason', 'the session could not save it'])
      if (answer.error || answer.data.outcome !== 'recorded') return
      queue = { ...queue, pending: queue.pending.filter(one => one.n !== n) }
      view = { ...view, handoffs: view.handoffs.filter(one => one.n !== n) }
    }

    // Saved before it is submitted: the follower has already told the app it
    // printed this one, so the queue is the only copy left.
    const receive = (line: string) => {
      const printed = jsonLines(line)[0]
      // `message` keeps the line breaks; a handoff that fills a frame comes without it.
      const text = [printed?.message, printed?.prompt].find(one => typeof one === 'string' && one.trim() !== '')
      if (text === undefined) return
      const sender = typeof printed.sender_name === 'string' ? printed.sender_name : ''
      const handoff: PanelHandoff = { n: queue.next, text, sender, at: Date.now(), state: 'waiting' }
      queue = { next: queue.next + 1, pending: [...queue.pending, { n: handoff.n, text }] }
      view = { ...view, handoffs: [handoff, ...view.handoffs].slice(0, HISTORY) }
      show()
      saving += 1
      void save().then(async held => {
        // Once, whatever it answers: after an app restart the same id can be
        // another handoff, and an app too old for acks has answered already.
        if (acks && Number.isInteger(printed.id)) {
          if (held) void call(['agent', 'ack', String(printed.id), 'queued'])
          else await refuse(handoff.n, printed.id)
        }
        saving -= 1
        return deliver()
      })
    }

    const notice = (line: string) => {
      const event = jsonLines(line)[0]
      if (event?.error?.code === 'usage' && event.error.message?.includes('--acks')) acks = false
      if (event?.event !== 'follower' || typeof event.data?.state !== 'string') return
      attachment = event.data.state
      settled()
      show()
    }

    let poll: { cancel: () => void } | undefined
    let retry: { cancel: () => void } | undefined
    let child: ReturnType<typeof $.process.spawn> | undefined
    let idle = 0
    let settled = () => {}
    let answering = Promise.resolve()

    const follow = (attempt: number) => {
      void (async () => {
        let out = ''
        let err = ''
        let own: typeof child
        const hadAcks = acks
        try {
          const environment = await env()
          if (!poll || child) return
          own = child = $.process.spawn({ argv: [cli, 'agent', 'follow', '--json', ...(acks ? ['--acks'] : [])], env: environment })
          for await (const { stream, text } of own) {
            if (stream === 'stdout') out = lines(out + text, receive)
            else err = lines(err + text, notice)
            if (attachment === 'attached') attempt = 0
          }
        } catch {
          // A follower that cannot start is retried like one that exited.
        }
        settled()
        // Stopped, and perhaps already replaced.
        if (child !== own) return
        child = undefined
        attachment = 'stopped'
        show()
        if (!poll) return
        // A connect is waiting for this follower: dropping --acks is no failure.
        retry = $.clock.after(hadAcks && !acks ? 0 : Math.min(60_000, 1_000 * 2 ** attempt), () => follow(attempt + 1))
      })()
    }

    // Refreshes overlap (the poll, a command, the skill's Bash call): an
    // answer that lands after a later refresh's says what is no longer so.
    let asked = 0
    let answered = 0
    let unanswered = 0
    let connects = 0

    // Answers once this follower has said where it stands to the app, or ended.
    const wake = () => {
      idle = 0
      if (poll) return answering
      answering = new Promise<void>(resolve => {
        settled = resolve
      })
      // A tick while an answer is still out would only start two more
      // processes waiting behind it.
      poll = $.clock.every(POLL_MS, async () => {
        if (unanswered > 0) return
        await refresh()
        if (!connected && (idle += 1) >= IDLE_POLLS) rest()
      })
      // On a timer because a child takes the event that started it with it, and
      // a prompt cannot be submitted from a hook: every handoff would fail.
      retry = $.clock.after(0, () => follow(0))
      return answering
    }

    const rest = () => {
      if (!poll || connects > 0) return
      poll.cancel()
      poll = undefined
      retry?.cancel()
      // Its stream's return is what kills the child.
      void child?.return(undefined as never).catch(() => undefined)
      child = undefined
      attachment = 'stopped'
      show()
    }

    const connecting = async () => {
      if (!(await ready())) return undefined
      since = Math.max(since, queue.next)
      connects += 1
      void wake()
      return () => {
        connects -= 1
      }
    }

    const refresh = async (): Promise<Answer> => {
      if (!(await ready())) return { error: { code: 'failed', message: 'This session has no claude process to name' } }
      const n = (asked += 1)
      const mark = queue.next
      unanswered += 1
      const [answer, current] = await Promise.all([call(['agent', 'status']), call(['room', 'current'])]).finally(
        () => (unanswered -= 1),
      )
      if (n < answered) return answer
      if (answer.error) {
        if (answer.error.code === 'app_unavailable') {
          answered = n
          // The app holds its connections in memory, so none survives it.
          if (connected) $.ui.toast('Blixel closed, and this session is no longer connected.')
          connected = false
          view = { ...view, app: 'closed', isInMeeting: false, isReconnecting: false, room: null, approval: null }
          show()
          rest()
        }
        return answer
      }
      answered = n
      // Each answer is read apart, and the app tells its agents about a
      // meeting after it joins: a room is the meeting both name, or none.
      const room = current.error || current.data.meeting_id !== answer.data.meeting_id ? undefined : current.data
      const now = typeof answer.data.session?.connection_id === 'string'
      view = {
        ...view,
        room: room?.state !== 'idle' && typeof room?.room?.name === 'string' && room.room.name !== '' ? room.room.name : null,
        isReconnecting: room?.state === 'reconnecting',
        app: 'running',
        isInMeeting: typeof answer.data.meeting_id === 'string',
        approval: now ? (answer.data.connection?.approval_mode ?? null) : null,
      }
      // The list is one meeting's: a connection to another starts it again.
      const connectedTo = answer.data.connection?.meeting_id ?? answer.data.meeting_id
      if (now && typeof connectedTo === 'string' && connectedTo !== view.meeting) {
        const kept = view.meeting === null ? view.handoffs : view.handoffs.filter(one => one.n >= since)
        view = { ...view, meeting: connectedTo, handoffs: kept }
      }
      since = Math.max(since, mark)
      if (connected && !now && !disconnecting) {
        const reason = answer.data.session?.ended?.end_reason
        $.ui.toast(reason ? `Blixel disconnected this session (${reason}).` : 'Blixel disconnected this session.')
      }
      const ended = connected && !now
      connected = now
      show()
      if (ended) rest()
      // A connection this mod did not make: a monitor's, or one from before a reload.
      else if (now) void wake()
      return answer
    }

    // The skill's guidance on handoffs, which a session connected without
    // loading the skill has never read.
    const brief = async () => {
      const skill = await $.fs.read(`${$.plugin.root}/skills/connect-agent/SKILL.md`).catch(() => '')
      const section = skill.match(/^## Blixel handoffs\n([\s\S]*?)^## /m)?.[1]?.trim()
      if (!section) return
      const text =
        "This Claude Code session is connected to the user's Blixel meeting: the user ran /blixel:connect " +
        `to receive handoffs, which arrive as prompts worded as the user set in Blixel.\n\n${section}`
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
    }

    session = {
      ready,

      connect: async approval => {
        const args = ['agent', 'connect', ...(approval ? ['--approval', approval] : [])]
        // The app holds this connect until the follower it starts attaches.
        const done = await connecting()
        let answer = await call(args)
        if (answer.error?.code === 'connect_outcome_unknown' && answer.requestID) {
          answer = await call([...args, '--request-id', answer.requestID])
        }
        done?.()
        if (answer.error) {
          if (!connected) rest()
          return failure(answer.error)
        }
        const wasConnected = connected
        await refresh()
        if (!wasConnected) await brief()
        const replaced = answer.data.replaced ? ' It replaced the session that was connected before.' : ''
        return `Connected to the Blixel meeting. Handoffs from people in it arrive here as prompts.${replaced}`
      },

      disconnect: async () => {
        disconnecting = true
        try {
          const answer = await call(['agent', 'disconnect'])
          if (answer.error) return failure(answer.error)
          await refresh()
          rest()
          return answer.data.outcome === 'not_connected'
            ? 'This session was not connected to Blixel.'
            : 'Disconnected from the Blixel meeting. Handoffs no longer arrive here.'
        } finally {
          disconnecting = false
        }
      },

      status: async () => {
        const answer = await refresh()
        if (answer.error) return failure(answer.error)
        const { meeting_id: meeting, connection, session: own = {} } = answer.data
        const report: string[] = []
        if (!meeting) report.push('Blixel is not in a meeting.')
        if (connected) {
          report.push(
            connection?.approval_mode === 'ask'
              ? 'This session is connected to the Blixel meeting; the app asks before each handoff.'
              : 'This session is connected to the Blixel meeting; handoffs come straight here.',
          )
          if (attachment === 'refused') report.push("A monitor in this session delivers the meeting's handoffs.")
        } else if (connection) {
          report.push('Another agent is connected to the Blixel meeting; this session is not.')
        } else if (meeting) {
          report.push('No agent is connected to the Blixel meeting.')
        }
        if (!connected && own.ended?.end_reason) {
          report.push(`This session's last connection ended: ${own.ended.end_reason}.`)
        }
        if (queue.pending.length > 0) {
          report.push(`${counted(queue.pending.length)} waiting${stopped ? ' for your next message' : ' to be submitted'}.`)
        }
        return report.join('\n')
      },

      deliver,
      refresh,
      show,
      ownsHandoffs: () => key !== '' && attachment !== 'refused',
      connecting,
      follow: async () => {
        if (await ready()) await wake()
      },
      forget: async () => {
        if (key) await $.store.delete(key).catch(() => undefined)
      },
    }

    // A reload ended the follower; $.state outlives it and says this session
    // had one, or handoffs left to submit.
    if (before.isConnected) {
      void refresh().then(answer => {
        // Unread is not ended: a poll settles it, and without a follower the
        // connection would lapse first.
        if (answer.error && answer.error.code !== 'app_unavailable') void session?.follow()
      })
    }
    if (before.handoffs.some(one => one.state !== 'delivered')) void ready().then(() => deliver())
    return started
  })

  // Only what the person typed: someone in the call saying a phrase must not run it.
  on('prompt.submit', async ($, e, next) => {
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const said = typed && !e.command ? PHRASE.exec(e.text.trim().toLowerCase()) : null
    const verb = said?.[1] ?? said?.[2]
    if (!said || !verb || (said[3] && verb !== 'connect')) return next(e)
    if (!(await session?.ready()) || !session) return next(e)
    const answers = {
      connect: () => connect($, session, said[3] ?? ''),
      disconnect: session.disconnect,
      status: () => status($, session),
    }
    const text = await answers[verb as keyof typeof answers]()
    // The only way not to enter: Claude Code prefixes the answer with "Prompt dropped
    // by a hook:" and puts the text back in the box. `$.command.run` is refused here.
    $.clock.after(50, async () => {
      if ((await $.prompt.read()).text === e.text) await $.prompt.fill({ text: '', mode: 'replace' })
    })
    return { drop: text }
  })

  // Plain plugin commands, so every surface lists them; where the mod follows
  // nothing, each runs as the prompt it holds.
  on('command.run', { command: 'blixel:connect' }, async ($, e, next) => {
    if (!(await session?.ready()) || !session) return next(e)
    const approval = e.args.trim()
    if (approval !== '' && approval !== 'ask' && approval !== 'direct') {
      return { text: 'Usage: /blixel:connect [ask|direct]' }
    }
    return { text: await connect($, session, approval) }
  })

  on('command.run', { command: 'blixel:disconnect' }, async ($, e, next) =>
    session && (await session.ready()) ? { text: await session.disconnect() } : next(e),
  )

  on('command.run', { command: 'blixel:status' }, async ($, e, next) => {
    if (!(await session?.ready()) || !session) return next(e)
    return { text: await status($, session) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, panel)
    const open = new Set(await read($, opened))
    const toggle = (n: number) => () =>
      update($, opened, list => (list.includes(n) ? list.filter(one => one !== n) : [...list, n]))
    const act = async () => {
      if (!(await session?.ready()) || !session) return
      const text = state.isConnected ? await session.disconnect() : await session.connect('')
      if (!/^(Connected|Disconnected)/.test(text)) $.ui.toast(text)
    }
    const { headline, detail } = describe(state)
    // Nothing reads the app before a connect, so what it says here can be old.
    const action = state.isConnected ? 'Disconnect' : 'Connect'

    if (e.surface === 'desktop') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={2} padding={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={LOGO} alt="Blixel" width={36} height={36} />
            <Box flexDirection="column" flexGrow={1}>
              <Text size="heading" weight="semibold">
                {headline}
              </Text>
              <Text size="caption" dimColor>
                {detail}
              </Text>
            </Box>
            <Button
              key="connection"
              label={action}
              variant={state.isConnected ? 'secondary' : 'primary'}
              onPress={act}
            />
          </Box>
          <Box flexDirection="column" gap={1}>
            <Text size="caption" weight="semibold" dimColor>
              HANDOFFS
            </Text>
            {state.handoffs.length === 0 && (
              <Text size="footnote" dimColor>
                What people in the meeting hand this session shows up here.
              </Text>
            )}
            {state.handoffs.map(handoff => {
              const { head, hidden } = excerpt(handoff.text, 90)
              const isOpen = open.has(handoff.n)
              return (
                <Box
                  flexDirection="column"
                  gap={1}
                  paddingX={2}
                  paddingY={1}
                  borderStyle="round"
                  borderColor={handoff.state === 'held' ? 'warning' : '#6E6BDB44'}
                  backgroundColor="#6E6BDB0D"
                >
                  <Text size="caption" dimColor>
                    <Text color={MARKS[handoff.state].color}>{MARKS[handoff.state].glyph}</Text>{' '}
                    {handoff.sender && <Text weight="semibold">{handoff.sender} · </Text>}
                    {clock(handoff.at)} · {MARKS[handoff.state].label}
                  </Text>
                  <Text>{isOpen ? handoff.text.trim() : head}</Text>
                  {hidden > 0 && (
                    <Box flexDirection="row">
                      <Button
                        key={`more-${handoff.n}`}
                        label={isOpen ? 'Show less' : 'Show all'}
                        variant="secondary"
                        onPress={toggle(handoff.n)}
                      />
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 2)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>
              <Text color={ACCENT}>✦ </Text>
              {headline}
            </Text>
            <Button key="connection" label={action} onPress={act} />
          </Box>
          <Text dimColor>{detail}</Text>
        </Box>
        {state.handoffs.length === 0 && <Text dimColor>Handoffs from the meeting show up here.</Text>}
        {state.handoffs.map(handoff => {
          const lines = wrap(handoff.text, width)
          const isOpen = open.has(handoff.n)
          const shown = isOpen ? lines : lines.slice(0, 2)
          const mark = MARKS[handoff.state]
          return (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={mark.color}>{mark.glyph} </Text>
                {handoff.sender && <Text bold>{handoff.sender}</Text>}
                <Text dimColor>
                  {handoff.sender ? ' · ' : ''}
                  {clock(handoff.at)}
                </Text>
              </Text>
              {shown.map((line, i) => (
                <Text wrap="truncate-end">
                  {'  '}
                  {!isOpen && lines.length > 2 && i === 1 ? `${line}…` : line}
                </Text>
              ))}
              {(handoff.state !== 'delivered' || lines.length > 2) && (
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>{'  '}{handoff.state === 'delivered' ? '' : mark.label}</Text>
                  {lines.length > 2 && (
                    <Button
                      key={`more-${handoff.n}`}
                      plain
                      label={isOpen ? 'show less' : `show all ${lines.length} lines`}
                      onPress={toggle(handoff.n)}
                    />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    void session?.deliver()
    return completed
  })

  // Loading the skill arms the plugin's monitor, and the first follower to
  // attach keeps a session's handoffs: the mod's has to get there before it.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (session && /^(blixel:)?connect-agent$/.test(e.skill)) {
      const attached = session.follow()
      await Promise.race([attached, $.clock.sleep(ATTACH_MS)])
    }
    return next(e)
  })

  // The connect-agent skill connects and disconnects through Bash.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A command that only quotes it, as a grep or a commit message does, is no invocation.
    const command = /(?:^|[\s;&|(/])blixel["']?\s+agent\s+(connect|disconnect)\b/.exec(e.command)?.[1]
    const connected = command === 'connect' ? await session?.connecting() : undefined
    try {
      const ran = await next(e)
      if (command) void session?.refresh()
      return ran
    } finally {
      connected?.()
    }
  })

  // A monitor the skill armed only waits behind the mod's follower, and once
  // that stops it would attach and take the next connection's handoffs.
  on('classic.Stop', async ($, e, next) => {
    const stopped = await next(e)
    if (session?.ownsHandoffs()) {
      for (const task of e.background_tasks ?? []) {
        // Claude Code reports a plugin monitor as a shell task.
        if (task.description !== MONITOR || !task.command?.includes('agent follow')) continue
        // A call under an `ask` rule would stop the end of the turn on a dialog
        // about a task the user never heard of.
        const verdict = await $.tool.check({ tool: 'TaskStop', input: { task_id: task.id } }).catch(() => undefined)
        if (verdict?.decision !== 'allow') continue
        await $.tool.call({ tool: 'TaskStop', task_id: task.id }).catch(() => undefined)
      }
    }
    return stopped
  })

  // `clear` and `resume` go on in the same process, with the same queue.
  on('session.end', async ($, e, next) => {
    const goesOn = e.reason === 'clear' || e.reason === 'resume'
    if (!goesOn) await session?.forget()
    const ended = await next(e)
    // A reload learns from $.state that this session is connected.
    if (goesOn) $.clock.after(CLEARED_MS, () => session?.show())
    return ended
  })
}
