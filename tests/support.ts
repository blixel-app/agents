import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const PID = '4242'
export const STARTED = 'Fri Oct 24 10:00:00 2026'
export const RECEIVE = ['agent', 'receive', '--print-events', '--confirm-each']

export type Run = { argv: readonly string[]; env: Record<string, string> }
export type Ran = { exitCode: number; stdout?: string; stderr?: string }
export type Setup = {
  // What the first receiver prints on stdout after `receiving`, chunk by chunk:
  // `printed` lines.
  printed?: string[]
  // A receiver run with these arguments prints this on stderr and exits with
  // `exitCode` at once, as the CLI does on a failure.
  receiverFails?: (args: readonly string[]) => { stderr: string; exitCode: number } | undefined
  // Answers each prompt the mod submits; a string drops it with that reason.
  submit?: (text: string) => string | undefined | Promise<string | undefined>
  // Answers `blixel agent <command>` and `blixel room current` (as `current`);
  // undefined leaves it to the stand-in app: a session connected once it
  // connects, in an app in no room. A promise answers once it settles.
  cli?: (command: string, args: readonly string[]) => Ran | Promise<Ran> | undefined
  stored?: Record<string, unknown>
  // Answers each read of the session's id; the default is at once.
  sessionID?: () => Promise<string>
  // The mod cannot learn this session's process.
  probeFails?: boolean
  // Every write to the mod's store fails.
  saveFails?: boolean
  env?: Record<string, string>
  surfaces?: ('terminal' | 'desktop')[]
  // Another receiver of this session is live, as a Monitor the model started is.
  otherReceiver?: boolean
}

/** What `blixel agent status` answers. */
export const status = (session: Record<string, unknown>, connection: unknown = null, meeting = 'm-1') =>
  JSON.stringify({ data: { meeting_id: meeting, connection, session: { claude_pid: Number(PID), ...session } } })

/** What `blixel room current` answers; a null room is a meeting the app has no name for. */
export const current = (
  state: 'idle' | 'connected' | 'reconnecting' = 'idle',
  room: string | null = 'Design sync',
  meeting = 'm-1',
) =>
  JSON.stringify({
    data: state === 'idle' ? { state } : { state, meeting_id: meeting, ...(room === null ? {} : { room: { id: 'r-1', name: room } }) },
  })

/** What `blixel agent connect` answers on success. */
export const connected = (receiving: boolean, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    data: {
      outcome: 'connected',
      receiving,
      replaced: false,
      meeting_id: 'm-1',
      connection: { connection_id: 'c-1', meeting_id: 'm-1', provider: 'claude', receiving, state: 'connected' },
      ...extra,
    },
    schema_version: 1,
  })}\n`

const event = (name: string, data: unknown) => `${JSON.stringify({ data, event: name, schema_version: 1 })}\n`

/** One `handoff` event of `blixel agent receive --print-events`. */
export const printed = (prompt: string, sender = 'Ana', id = '1', message?: string) =>
  event('handoff', { id, prompt, ...(message === undefined ? {} : { message }), sender: { name: sender } })

export const failure = (code: string, message = 'No', context?: Record<string, unknown>) =>
  `${JSON.stringify({ error: { code, message, ...(context ? { context } : {}) } })}\n`

export function stage(on: On, setup: Setup = {}) {
  const clock = mock.clock(on)
  const conversation = mock.session(on)
  mock.env(on, setup.env ?? {})
  const submitted: string[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const runs: Run[] = []
  const saved = new Map<string, unknown>(Object.entries(setup.stored ?? {}))
  const started: string[] = []
  // What the mod and the model ran, in order: `connect`, `receive`, `confirm`, ...
  const timeline: string[] = []
  let spawns = 0
  let running = 0
  let probes = 0
  let isConnected = false
  const later: string[] = []
  // How the live receiver stops: with an `ended` reason, refused as the CLI
  // refuses (`error`, with its exit status), or killed with no word.
  let stop: { ended?: string; error?: string; code?: number } | undefined
  let wake = () => {}

  const receiving = () => running > 0 || setup.otherReceiver === true
  const app = (command: string): Ran =>
    command === 'status'
      ? {
          exitCode: 0,
          stdout: isConnected
            ? status(
                { connection_id: 'c-1', connected: true, receiving: receiving() },
                { connection_id: 'c-1', meeting_id: 'm-1', receiving: receiving() },
              )
            : status({ connected: false }),
        }
      : command === 'current'
        ? { exitCode: 0, stdout: current() }
        : command === 'connect'
          ? { exitCode: 0, stdout: connected(receiving()) }
          : command === 'disconnect'
            ? { exitCode: 0, stdout: JSON.stringify({ data: { outcome: isConnected ? 'disconnected' : 'not_connected' } }) }
            : command === 'confirm'
              ? { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'recorded' } }) }
              : { exitCode: 1 }

  const ends = (how: { ended?: string; error?: string; code?: number }) => {
    stop = how
    wake()
  }

  const ask = async (command: string, args: readonly string[]) => {
    timeline.push(command)
    const answer = (await setup.cli?.(command, args)) ?? app(command)
    if (command === 'connect' && answer.exitCode === 0) isConnected = true
    if (command === 'disconnect' && answer.exitCode === 0) {
      const had = isConnected
      isConnected = false
      if (had) ends({ ended: 'disconnected' })
    }
    return answer
  }

  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for the plugin's own command, the prompt that hands it to the skill.
  on('command.run', () => ({ text: 'the skill takes it' }))
  on('session.id', () => setup.sessionID?.().then(value => ({ value })) ?? { value: 'session-1' })
  const panes: string[] = []
  const receivers: (readonly string[])[] = []
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.surfaces', () => ({ value: setup.surfaces ?? ['terminal'] }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    if (setup.saveFails) throw new Error('disk full')
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  const bare: boolean[] = []
  on('prompt.submit', async ($, e) => {
    submitted.push(e.text)
    bare.push(e.origin.kind === 'plugin' && e.origin.asUser === true)
    const drop = await setup.submit?.(e.text)
    return drop === undefined ? { text: e.text } : { drop }
  })
  on('process.run', async ($, e) => {
    const read = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === '/bin/sh') {
      probes += 1
      started.push(e.argv.at(-1) ?? '')
      return { value: { ...read, exitCode: setup.probeFails ? 1 : 0, stdout: `${PID}\n${STARTED}\n` } }
    }
    started.push(e.argv[0] ?? '')
    runs.push({ argv: e.argv, env: e.init?.env ?? {} })
    const answer = await ask(e.argv[2] ?? '', e.argv.slice(3))
    return { value: { ...read, stdout: '', ...answer } }
  })
  // The receiver, as `blixel agent receive` behaves: it refuses a session with no
  // connection, ends at once beside a live receiver, and otherwise stays until
  // the connection ends or it is killed.
  on('process.spawn', async function* ($, e, next) {
    const args = e.argv.slice(1)
    started.push(e.argv[0] ?? '')
    receivers.push(args)
    timeline.push('receive')
    const failed = setup.receiverFails?.(args)
    if (failed !== undefined) {
      yield { stream: 'stderr', text: failed.stderr }
      return { value: { code: failed.exitCode, signal: null } }
    }
    if (!isConnected) {
      yield { stream: 'stderr', text: failure('not_connected', 'This session is not connected to the meeting') }
      return { value: { code: 5, signal: null } }
    }
    if (receiving()) {
      yield { stream: 'stdout', text: event('ended', { reason: 'received_elsewhere' }) }
      return { value: { code: 0, signal: null } }
    }
    spawns += 1
    running += 1
    stop = undefined
    try {
      yield { stream: 'stdout', text: event('receiving', { connection_id: 'c-1' }) }
      if (spawns === 1) for (const text of setup.printed ?? []) yield { stream: 'stdout', text }
      while (!next.signal.aborted && stop === undefined) {
        while (later.length > 0) yield { stream: 'stdout', text: later.shift() ?? '' }
        if (stop !== undefined) break
        await new Promise<void>(resolve => {
          wake = resolve
          next.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      const how = stop as { ended?: string; error?: string; code?: number } | undefined
      if (how?.ended !== undefined) {
        yield { stream: 'stdout', text: event('ended', { reason: how.ended }) }
        return { value: { code: 0, signal: null } }
      }
      if (how?.error !== undefined) {
        yield { stream: 'stderr', text: how.error }
        return { value: { code: how.code ?? 1, signal: null } }
      }
      return { value: { code: null, signal: 'SIGKILL' } }
    } finally {
      running -= 1
    }
  })

  return {
    clock,
    conversation,
    submitted,
    statuses,
    toasts,
    runs,
    timeline,
    confirms: () => runs.filter(run => run.argv[2] === 'confirm').map(run => run.argv.slice(3)),
    receivers,
    saved,
    panes,
    bare,
    spawns: () => spawns,
    running: () => running,
    probes: () => probes,
    started,
    isConnected: () => isConnected,
    print: (text: string) => {
      later.push(text)
      wake()
    },
    // The connection ends in the app, for this reason; the live receiver says so.
    end: (reason: string) => {
      isConnected = false
      ends({ ended: reason })
    },
    // The app relaunched, with no connections: once it answers, the live receiver
    // is refused, as `receive` is.
    relaunch: () => {
      isConnected = false
      ends({ error: failure('not_connected', 'This session is not connected to the meeting'), code: 5 })
    },
    // The live receiver is signalled, as Claude Code or the user can: `cancelled`.
    cancel: () => ends({ error: failure('cancelled', 'Stopped'), code: 143 }),
    // The live receiver is killed: it stops with no word, the connection stays.
    kill: () => ends({}),
    // The model's own `blixel agent <command>`, run through Bash once Claude Code let it.
    asModel: async (command: string) => (await ask(command, [])).stdout ?? '',
    status: () => statuses.at(-1),
    // Lets the receiver's loop and the deliveries it started run to rest.
    settle: async () => {
      for (let i = 0; i < 20; i += 1) await clock.settle()
    },
  }
}

export const start = ($: Engine, isInteractive = true) =>
  $.session.start({ cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive })

/** What the previous load of the module left in $.state, under its tag. */
export const seedPanel = (on: On, panel: Record<string, unknown>) => {
  const before = {
    app: 'unknown', isInMeeting: false, isConnected: false, isReconnecting: false, room: null,
    meeting: null, approval: null, receiver: null, handoffs: [], ...panel,
  }
  let isSeeded = true
  on('state.get', ($, e, next) =>
    isSeeded && e.key === 'panel' ? { value: { value: { shape: 'panel-3', value: before }, version: 1 } } : next(e))
  on('state.set', ($, e, next) => {
    if (e.key === 'panel') isSeeded = false
    return next(e)
  })
}

/**
 * Waits for what a connect started: it answers once its receiver attaches,
 * and the mod starts that on a timer the test's clock has to run.
 */
export const settled = async <T>(stub: { settle: () => Promise<void> }, pending: Promise<T>) => {
  await stub.settle()
  const answer = await pending
  await stub.settle()
  return answer
}

/** A session that ran /blixel:connect, its receiver started. */
export const connectSession = async ($: Engine, stub: { settle: () => Promise<void> }, isInteractive = true) => {
  await start($, isInteractive)
  await settled(stub, run($, 'blixel:connect'))
}

// The kit fills in the fields only the engine sets (origin, presentation).
export const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0])

export const complete = ($: Engine) =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null } as never)

/**
 * Stands for Claude Code's own Bash tool beneath the mod: its permission
 * decision, then the command. `allow` runs a connect as the model's own
 * `blixel agent connect` would; `declined` and `blocked` are the two ways a
 * call comes back refused. `decided` holds the decision until it settles.
 */
export const bash = (
  on: On,
  stub: { asModel: (command: string) => Promise<string> },
  verdict: 'allow' | 'declined' | 'blocked' = 'allow',
  decided: Promise<void> = Promise.resolve(),
) => {
  on('tool.call', async ($, e) => {
    await decided
    if (verdict === 'declined') return { deny: "The user doesn't want to proceed with this tool use." }
    if (verdict === 'blocked') {
      return { isError: true, result: 'Permission to use Bash has been denied.', text: 'Permission to use Bash has been denied.' }
    }
    const verb = /agent\s+(connect|disconnect|status)/.exec(String((e as { command?: string }).command ?? ''))?.[1]
    const stdout = verb ? await stub.asModel(verb) : ''
    return { result: { stdout, stderr: '', interrupted: false } }
  })
}
