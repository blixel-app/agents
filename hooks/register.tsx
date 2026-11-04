import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Panel, PanelHandoff } from '../types'
import { clock, excerpt, LOGO, wrap } from './panel'

type Handoff = { n: number; text: string }
type Queue = { next: number; pending: Handoff[] }
type Failure = { code: string; message: string; hint?: string; context?: Record<string, any> }
type Answer =
  | { data: Record<string, any>; stdout: string; error?: undefined; requestID?: undefined }
  | { error: Failure; requestID?: string }
type Session = {
  ready: () => Promise<boolean>
  connect: () => Promise<string>
  takeOver: (id: unknown) => Promise<string | undefined>
  disconnect: () => Promise<string>
  status: () => Promise<string>
  deliver: () => Promise<void>
  refresh: () => Promise<Answer>
  show: () => void
  forget: () => Promise<void>
}

const PANE = 'blixel'
// The prompts that act with no model, the same as Codex's hooks read them.
const PHRASE = /^(?:blixel[ :](connect|disconnect|status)|(connect|disconnect|status) blixel)$/
const HISTORY = 20
const EMPTY: Panel = {
  app: 'unknown',
  isInMeeting: false,
  isConnected: false,
  isReconnecting: false,
  room: null,
  meeting: null,
  approval: null,
  receiver: null,
  handoffs: [],
}
// Change the tag when Panel changes: a value an earlier version wrote
// outlives a reload.
const panel = atom({ plugin: 'blixel', key: 'panel' } as const, EMPTY, { shape: 'panel-3' })
const opened = atom({ plugin: 'blixel', key: 'opened' } as const, [])

// Never `--print-handoffs`: session-start.sh takes a receiver with that for a
// Monitor's, and tells the model to keep one going.
const RECEIVE = ['agent', 'receive', '--print-events', '--confirm-each']
const POLL_MS = 15_000
// How long a connect waits for its receiver to attach before it answers. It
// counts against a hook's 10 s.
const RECEIVING_MS = 5_000
// A /clear empties $.state just after session.end's hooks return.
const CLEARED_MS = 1_000
// After the user stops a turn, Claude Code drops the queued prompt and
// refuses new ones until the user's next input.
const STOPPED = ['the session was stopped and nobody has sent input since', 'was removed from the queue before it ran']

async function connect($: EngineInterface, session: Session) {
  const text = await session.connect()
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
    const headline = `Connected to ${state.room ?? 'your meeting'}`
    if (state.receiver === 'other') return { headline, detail: 'Another receiver in this session takes its handoffs.' }
    if (state.receiver === null) return { headline, detail: 'Not receiving handoffs. Connect again to receive them.' }
    const detail = state.approval === 'ask' ? 'The app asks you before each handoff.' : 'Handoffs come straight to this session.'
    return { headline, detail }
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
function statusLine(state: Panel, waiting: number, stopped: boolean) {
  const parts: string[] = []
  if (state.isConnected) {
    parts.push(state.room ? `connected to ${state.room}` : 'connected')
    if (state.receiver === 'other') parts.push('handoffs go to another receiver')
    if (state.receiver === null) parts.push('not receiving')
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

    let saving = 0
    let connected = false
    let isAttached = false
    let delivering = false
    let stopped = false
    let disconnecting = false
    let connecting = 0
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
        if (result) return { data: result.data ?? {}, stdout: run.stdout }
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
      view = {
        ...view,
        isConnected: connected,
        receiver: isAttached ? 'mod' : view.receiver === 'mod' ? null : view.receiver,
      }
      // The engine puts the plugin's name in front of the line.
      $.ui.status(statusLine(view, queue.pending.length, stopped))

      const pending = new Set(queue.pending.map(one => one.n))
      view = {
        ...view,
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
    // app takes that answer: past the app's 10 s the sender has heard otherwise.
    const refuse = async (n: number, id: string) => {
      const answer = await call(['agent', 'confirm', id, 'failed', '--reason', 'the session could not save it'])
      if (answer.error || answer.data.outcome !== 'recorded') return
      queue = { ...queue, pending: queue.pending.filter(one => one.n !== n) }
      view = { ...view, handoffs: view.handoffs.filter(one => one.n !== n) }
    }

    // Saved before it is confirmed and submitted: once confirmed, the queue is
    // the only copy left.
    const take = (data: Record<string, any>) => {
      // `message` keeps the line breaks; a handoff that fills a frame comes without it.
      const text = [data.message, data.prompt].find(one => typeof one === 'string' && one.trim() !== '')
      if (text === undefined) return
      const sender = typeof data.sender?.name === 'string' ? data.sender.name : ''
      const handoff: PanelHandoff = { n: queue.next, text, sender, at: Date.now(), state: 'waiting' }
      queue = { next: queue.next + 1, pending: [...queue.pending, { n: handoff.n, text }] }
      view = { ...view, handoffs: [handoff, ...view.handoffs].slice(0, HISTORY) }
      show()
      saving += 1
      void save().then(async held => {
        if (typeof data.id === 'string' && data.id !== '') {
          if (held) void call(['agent', 'confirm', data.id, 'delivered'])
          else await refuse(handoff.n, data.id)
        }
        saving -= 1
        return deliver()
      })
    }

    let poll: { cancel: () => void } | undefined
    let retry: { cancel: () => void } | undefined
    let child: ReturnType<typeof $.process.spawn> | undefined
    // Each start takes a number; one that a later start or a stop overtook gives up.
    let starts = 0
    let waiting: (() => void)[] = []
    const settled = () => {
      for (const resolve of waiting.splice(0)) resolve()
    }

    const lost = (reason?: string) => {
      if (connected && !disconnecting) {
        $.ui.toast(reason ? `Blixel disconnected this session (${reason}).` : 'Blixel disconnected this session.')
      }
      connected = false
      view = { ...view, receiver: null }
      rest()
    }

    const receive = (attempt: number) => {
      const mine = (starts += 1)
      void (async () => {
        let out = ''
        let err = ''
        let ended: string | undefined
        let failed: Failure | undefined
        const environment = await env()
        if (mine !== starts || !poll || child) return
        const own = (child = $.process.spawn({ argv: [cli, ...RECEIVE], env: environment }))
        try {
          for await (const { stream, text } of own) {
            if (stream === 'stderr') {
              err = lines(err + text, line => {
                failed = jsonLines(line)[0]?.error ?? failed
              })
              continue
            }
            out = lines(out + text, line => {
              const event = jsonLines(line)[0]
              if (event?.event === 'receiving') {
                attempt = 0
                isAttached = true
                show()
                settled()
              } else if (event?.event === 'handoff') take(event.data ?? {})
              else if (event?.event === 'ended') ended = String(event.data?.reason ?? '')
            })
          }
        } catch {
          // Started again, as one that stopped with no word.
        }
        // Stopped by this mod, and perhaps already replaced.
        if (child !== own) return
        child = undefined
        isAttached = false
        settled()
        if (ended === 'received_elsewhere') {
          view = { ...view, receiver: 'other' }
          show()
        } else if (ended !== undefined || failed?.code === 'not_connected') {
          // A connect in flight starts the next one for its own connection.
          if (connecting === 0) lost(ended ?? failed?.context?.last_ended)
        } else if (failed && failed.code !== 'cancelled') {
          // It would fail the same way each time.
          $.ui.toast(`Blixel stopped receiving handoffs: ${failure(failed)}`)
          show()
        } else if (poll) {
          show()
          retry = $.clock.after(Math.min(60_000, 1_000 * 2 ** attempt), () => receive(attempt + 1))
        }
      })()
    }

    // Starts receiving, if this mod is not already, and answers once it does
    // or has stopped trying.
    const wake = () => {
      const answered = new Promise<void>(resolve => {
        if (isAttached) resolve()
        else waiting.push(resolve)
      })
      // A tick while an answer is still out would only start two more
      // processes waiting behind it.
      poll ??= $.clock.every(POLL_MS, async () => {
        if (unanswered === 0) await refresh()
      })
      if (!child) {
        retry?.cancel()
        // On a timer because a child takes the event that started it with it, and
        // a prompt cannot be submitted from a hook: every handoff would fail.
        retry = $.clock.after(0, () => receive(0))
      }
      return answered
    }

    const receiving = () => Promise.race([wake(), $.clock.sleep(RECEIVING_MS)])

    const rest = () => {
      poll?.cancel()
      poll = undefined
      retry?.cancel()
      retry = undefined
      starts += 1
      const own = child
      child = undefined
      isAttached = false
      // Its stream's return is what kills the child.
      void own?.return(undefined as never).catch(() => undefined)
      settled()
      show()
    }

    // Refreshes overlap (the poll, a command, a Bash call): an answer that
    // lands after a later refresh's says what is no longer so.
    let asked = 0
    let answered = 0
    let unanswered = 0

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
          rest()
        }
        return answer
      }
      answered = n
      // Each answer is read apart, and the app tells its agents about a
      // meeting after it joins: a room is the meeting both name, or none.
      const room = current.error || current.data.meeting_id !== answer.data.meeting_id ? undefined : current.data
      const own = answer.data.session ?? {}
      const now = typeof own.connection_id === 'string'
      view = {
        ...view,
        room: room?.state !== 'idle' && typeof room?.room?.name === 'string' && room.room.name !== '' ? room.room.name : null,
        isReconnecting: room?.state === 'reconnecting',
        app: 'running',
        isInMeeting: typeof answer.data.meeting_id === 'string',
        approval: now ? (answer.data.connection?.approval_mode ?? null) : null,
        receiver: isAttached ? 'mod' : own.receiving === true ? 'other' : null,
      }
      // The list is one meeting's: a connection to another starts it again.
      const connectedTo = answer.data.connection?.meeting_id ?? answer.data.meeting_id
      if (now && typeof connectedTo === 'string' && connectedTo !== view.meeting) {
        const kept = view.meeting === null ? view.handoffs : view.handoffs.filter(one => one.n >= since)
        view = { ...view, meeting: connectedTo, handoffs: kept }
      }
      since = Math.max(since, mark)
      if (connected && !now && connecting === 0) lost(own.ended?.end_reason)
      else {
        connected = now
        show()
      }
      return answer
    }

    const connectOnce = async () => {
      let answer = await call(['agent', 'connect'])
      if (answer.error?.code === 'connect_outcome_unknown' && answer.requestID) {
        answer = await call(['agent', 'connect', '--request-id', answer.requestID])
      }
      return answer
    }

    session = {
      ready,

      connect: async () => {
        if (!(await ready())) return 'This session has no claude process to name.'
        connecting += 1
        try {
          since = Math.max(since, queue.next)
          const answer = await connectOnce()
          if (answer.error) return failure(answer.error)
          connected = true
          await receiving()
          await refresh()
          const replaced = answer.data.replaced === true ? ' It replaced the session that was connected before.' : ''
          if (view.receiver === 'other') return `Connected to the Blixel meeting. Another receiver in this session takes its handoffs.${replaced}`
          if (view.receiver === null) return `Connected to the Blixel meeting, but not receiving its handoffs yet. Run /blixel:status to check.${replaced}`
          return `Connected to the Blixel meeting. Handoffs from people in it arrive here as prompts.${replaced}`
        } finally {
          connecting -= 1
          // A handoff that came while this answered cannot be submitted from the
          // hook waiting on it: on a timer it goes once that hook has returned.
          $.clock.after(0, () => void deliver())
        }
      },

      // The model's own connect already ran, approved; this receives for it
      // and answers as connect does once something receives. Only for this
      // session's connection: the connect below would otherwise make one the
      // approval never covered, as for `--session-env` or over ssh.
      takeOver: async (id: unknown) => {
        if (!(await ready())) return undefined
        connecting += 1
        try {
          since = Math.max(since, queue.next)
          const mine = await refresh()
          if (mine.error || typeof id !== 'string' || mine.data.session?.connection_id !== id) return undefined
          connected = true
          await receiving()
          const answer = await connectOnce()
          await refresh()
          return answer.error ? undefined : answer.stdout
        } finally {
          connecting -= 1
        }
      },

      disconnect: async () => {
        disconnecting = true
        try {
          const answer = await call(['agent', 'disconnect'])
          if (answer.error) return failure(answer.error)
          await refresh()
          connected = false
          view = { ...view, receiver: null }
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
        if (connected && view.receiver === 'mod') {
          report.push(
            connection?.approval_mode === 'ask'
              ? 'This session is connected to the Blixel meeting; the app asks before each handoff.'
              : 'This session is connected to the Blixel meeting; handoffs come straight here.',
          )
        } else if (connected && view.receiver === 'other') {
          report.push('This session is connected to the Blixel meeting; another receiver in it takes its handoffs.')
        } else if (connected) {
          report.push('This session is connected to the Blixel meeting, but not receiving its handoffs. Run /blixel:connect to receive them.')
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
      forget: async () => {
        if (key) await $.store.delete(key).catch(() => undefined)
      },
    }

    // A reload ended the receiver; $.state outlives it and says this mod
    // received for this session, or had handoffs left to submit.
    if (before.isConnected && before.receiver === 'mod') {
      void ready().then(async isReady => {
        if (!isReady) return
        const answer = await refresh()
        // Unread is not ended: `receive` itself says if the connection is gone.
        if (connected || (answer.error && answer.error.code !== 'app_unavailable')) void wake()
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
    if (!verb) return next(e)
    if (!(await session?.ready()) || !session) return next(e)
    const answers = {
      connect: () => connect($, session),
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

  // Plain plugin commands, so every surface lists them; where the mod receives
  // nothing, each runs as the prompt it holds.
  on('command.run', { command: 'blixel:connect' }, async ($, e, next) =>
    session && (await session.ready()) ? { text: await connect($, session) } : next(e),
  )

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
      const text = state.isConnected ? await session.disconnect() : await session.connect()
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

  // The model connects through Bash, by the connect-agent skill. `next` runs
  // Claude Code's permission decision and then the command, so nothing here acts
  // before the person does: a declined or blocked connect never ran, and is left
  // alone. One that connected is taken over, and the model reads that the
  // session receives, so it starts no receiver of its own.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A command that only quotes it, as a grep or a commit message does, is no invocation.
    const command = /(?:^|[\s;&|(/])blixel["']?\s+agent\s+(connect|disconnect)\b/.exec(e.command)?.[1]
    const ran = await next(e)
    if (!command || !session || ran.deny || ran.isError) return ran
    if (command === 'connect') {
      const stdout = typeof ran.result?.stdout === 'string' ? ran.result.stdout : ''
      const answered = jsonLines(stdout).at(-1)?.data
      if (answered?.outcome === 'connected') {
        const answer = await session.takeOver(answered.connection?.connection_id)
        if (answer !== undefined) return { result: { ...ran.result, stdout: answer } }
        return ran
      }
    }
    void session.refresh()
    return ran
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
