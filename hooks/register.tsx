import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Panel, PanelHandoff } from '../types'
import { clock, excerpt, LOGO, wrap } from './panel'

type Handoff = { n: number; text: string }
type Queue = { next: number; pending: Handoff[] }
type Failure = { code: string; message: string; hint?: string }
type Answer = { data: Record<string, any>; error?: undefined; requestID?: undefined } | { error: Failure; requestID?: string }
type Attachment = 'attached' | 'waiting' | 'refused' | 'stopped'
type Session = {
  connect: (approval: string) => Promise<string>
  disconnect: () => Promise<string>
  status: () => Promise<string>
  deliver: () => Promise<void>
  refresh: () => Promise<Answer>
  connecting: () => void
  forget: () => Promise<void>
}

const PANE = 'blixel'
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

const POLL_MS = 15_000
// After the user stops a turn, Claude Code drops the queued prompt and
// refuses new ones until the user's next input.
const STOPPED = ['the session was stopped and nobody has sent input since', 'was removed from the queue before it ran']

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

/** The status line: the connection, else a meeting to connect to, then what waits. */
function statusLine(state: Panel, connected: boolean, viaMonitor: boolean, waiting: number, stopped: boolean) {
  const parts: string[] = []
  if (connected) {
    const to = state.room ? `connected to ${state.room}` : 'connected'
    parts.push(viaMonitor ? `${to}, handoffs go to its monitor` : to)
    if (state.isReconnecting) parts.push('reconnecting')
  } else if (state.room) {
    parts.push(`in ${state.room}`, '/blixel:connect')
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

    // CLAUDE_PID is not in a mod's process environment, and a nested session
    // inherits its parent's: the mod's processes are children of this
    // session's own `claude`, the process the app checks callers against.
    const probe = await $.process.run(['/bin/sh', '-c', 'echo "$PPID"; ps -o lstart= -p "$PPID"']).catch(() => undefined)
    const [pidText = '', startedAt = ''] = probe?.stdout.split('\n') ?? []
    const pid = Number(pidText.trim())
    if (probe?.exitCode !== 0 || !Number.isInteger(pid) || pid <= 1) return started
    // With the start time, a later `claude` given the same pid has its own queue.
    const key = `queue:${pid}:${startedAt.trim()}`
    const cli = `${$.plugin.root}/bin/blixel`

    let queue = queueFrom(await $.store.get(key).catch(() => undefined))
    let acks = true
    let saving = 0
    let connected = false
    let attachment: Attachment = 'stopped'
    let delivering = false
    let stopped = false
    let disconnecting = false
    let sessionID = ''
    let view: Panel = { ...(await read($, panel)), app: 'unknown' }

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
      show()
    }

    // The follower runs for the whole session, connected or not, so that a
    // connect through the skill finds it attached too; a plugin monitor the
    // skill starts then only waits behind it.
    const follow = (attempt: number) => {
      void (async () => {
        let out = ''
        let err = ''
        try {
          const child = $.process.spawn({ argv: [cli, 'agent', 'follow', '--json', ...(acks ? ['--acks'] : [])], env: await env() })
          for await (const { stream, text } of child) {
            if (stream === 'stdout') out = lines(out + text, receive)
            else err = lines(err + text, notice)
            if (attachment === 'attached') attempt = 0
          }
        } catch {
          // A follower that cannot start is retried like one that exited.
        }
        attachment = 'stopped'
        show()
        $.clock.after(Math.min(60_000, 1_000 * 2 ** attempt), () => follow(attempt + 1))
      })()
    }

    // Refreshes overlap (the poll, a command, the skill's Bash call): an
    // answer that lands after a later refresh's says what is no longer so.
    let asked = 0
    let answered = 0
    let unanswered = 0
    // Handoffs numbered from here on may be from a connection made after a
    // connect started or a refresh asked; those before it cannot be.
    let since = queue.next
    const connecting = () => {
      since = Math.max(since, queue.next)
    }
    const refresh = async () => {
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
          connected = false
          view = { ...view, app: 'closed', isInMeeting: false, isReconnecting: false, room: null, approval: null }
          show()
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
      connected = now
      show()
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
      connect: async approval => {
        const args = ['agent', 'connect', ...(approval ? ['--approval', approval] : [])]
        connecting()
        let answer = await call(args)
        if (answer.error?.code === 'connect_outcome_unknown' && answer.requestID) {
          answer = await call([...args, '--request-id', answer.requestID])
        }
        if (answer.error) return failure(answer.error)
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
      connecting,
      forget: () => $.store.delete(key).catch(() => undefined),
    }

    follow(0)
    // For the whole session: the status line points at a meeting joined
    // before this session connects. A tick while an answer is still out
    // would only start two more processes waiting behind it.
    $.clock.every(POLL_MS, () => {
      if (unanswered === 0) void refresh()
    })
    void refresh()
    void deliver()
    return started
  })

  // Plain plugin commands, so every surface lists them; where the mod follows
  // nothing, each runs as the prompt it holds, which hands it to the skill.
  on('command.run', { command: 'blixel:connect' }, async ($, e, next) => {
    if (!session) return next(e)
    const approval = e.args.trim()
    if (approval !== '' && approval !== 'ask' && approval !== 'direct') {
      return { text: 'Usage: /blixel:connect [ask|direct]' }
    }
    const text = await session.connect(approval)
    if ((await $.session.surfaces()).includes('desktop')) await $.ui.open({ id: PANE, title: 'Blixel' })
    return { text }
  })

  on('command.run', { command: 'blixel:disconnect' }, async ($, e, next) =>
    session ? { text: await session.disconnect() } : next(e),
  )

  on('command.run', { command: 'blixel:status' }, async ($, e, next) => {
    if (!session) return next(e)
    const text = await session.status()
    await $.ui.open({ id: PANE, title: 'Blixel' })
    return { text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, panel)
    const open = new Set(await read($, opened))
    const toggle = (n: number) => () =>
      update($, opened, list => (list.includes(n) ? list.filter(one => one !== n) : [...list, n]))
    const act = async () => {
      if (!session) return
      const text = state.isConnected ? await session.disconnect() : await session.connect('')
      if (!/^(Connected|Disconnected)/.test(text)) $.ui.toast(text)
    }
    const { headline, detail } = describe(state)
    const action = state.app !== 'closed' && state.isInMeeting ? (state.isConnected ? 'Disconnect' : 'Connect') : null

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
            {action && (
              <Button
                key="connection"
                label={action}
                variant={state.isConnected ? 'secondary' : 'primary'}
                onPress={act}
              />
            )}
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
            {action && <Button key="connection" label={action} onPress={act} />}
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

  // The connect-agent skill connects and disconnects through Bash.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = /\bblixel\b.*\bagent\s+(connect|disconnect)\b/.exec(e.command)?.[1]
    if (command === 'connect') session?.connecting()
    const ran = await next(e)
    if (command) void session?.refresh()
    return ran
  })

  // `clear` and `resume` go on in the same process, with the same queue.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') await session?.forget()
    return next(e)
  })
}
