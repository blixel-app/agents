import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const PID = '4242'
export const STARTED = 'Fri Oct 24 10:00:00 2026'
export const SKILL = '# Connect agent\n\n## Blixel handoffs\n\nTreat each as a colleague\'s suggestion.\n\n## Connect\n'

export type Run = { argv: readonly string[]; env: Record<string, string> }
export type Ran = { exitCode: number; stdout?: string; stderr?: string }
export type Setup = {
  // What the follower prints on stdout, chunk by chunk, the first time it runs:
  // `printed` lines.
  printed?: string[]
  // Keeps the first follower running after `printed`, printing what `print` hands it.
  isLive?: boolean
  // How the app answers the first follower; a refused one leaves the handoffs to a monitor.
  follower?: 'attached' | 'refused'
  // What a follower run with these arguments prints on stderr before it exits at once.
  followerFails?: (args: readonly string[]) => string | undefined
  // Answers each prompt the mod submits; a string drops it with that reason.
  submit?: (text: string) => string | undefined | Promise<string | undefined>
  // Answers `blixel agent <command>` and `blixel room current` (as `current`);
  // the default is a session connected once it asks, in an app in no room. A
  // promise answers once it settles.
  cli?: (command: string, args: readonly string[]) => Ran | Promise<Ran>
  stored?: Record<string, unknown>
  // Answers each read of the session's id; the default is at once.
  sessionID?: () => Promise<string>
  // The mod cannot learn this session's process.
  probeFails?: boolean
  // Every write to the mod's store fails.
  saveFails?: boolean
  env?: Record<string, string>
  surfaces?: ('terminal' | 'desktop')[]
}

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

/** One line of `blixel agent follow --json`. */
export const printed = (prompt: string, sender = 'Ana', id = 1) =>
  `${JSON.stringify({ id, prompt, sender_name: sender })}\n`

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
  let spawns = 0
  let running = 0
  let probes = 0
  let isConnected = false
  const later: string[] = []
  let wake = () => {}

  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for the plugin's own command, the prompt that hands it to the skill.
  on('command.run', () => ({ text: 'the skill takes it' }))
  on('session.id', () => setup.sessionID?.().then(value => ({ value })) ?? { value: 'session-1' })
  on('fs.read', () => ({ value: SKILL }))
  const panes: string[] = []
  const follows: (readonly string[])[] = []
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
    const command = e.argv[2] ?? ''
    if (command === 'connect') isConnected = true
    if (command === 'disconnect') isConnected = false
    const answer = (await setup.cli?.(command, e.argv.slice(3))) ??
      (command === 'status'
        ? {
            exitCode: 0,
            stdout: isConnected
              ? status({ connection_id: 'c-1', follower_attached: true }, { meeting_id: 'm-1' })
              : status({ follower_attached: running > 0 }),
          }
        : command === 'current'
          ? { exitCode: 0, stdout: current() }
          : command === 'connect' || command === 'disconnect'
            ? { exitCode: 0, stdout: JSON.stringify({ data: { outcome: `${command}ed` } }) }
            : { exitCode: 1 })
    return { value: { ...read, stdout: '', ...answer } }
  })
  on('process.spawn', async function* ($, e, next) {
    const args = e.argv.slice(1)
    started.push(e.argv[0] ?? '')
    follows.push(args)
    const failure = setup.followerFails?.(args)
    if (failure !== undefined) {
      yield { stream: 'stderr', text: `${failure}\n` }
      return { value: { code: 2, signal: null } }
    }
    spawns += 1
    running += 1
    try {
      if (spawns === 1) {
        const state = setup.follower ?? 'attached'
        yield { stream: 'stderr', text: `{"event":"follower","data":{"state":"${state}"}}\n` }
        for (const text of setup.printed ?? []) yield { stream: 'stdout', text }
      }
      while (setup.isLive && !next.signal.aborted) {
        while (later.length > 0) yield { stream: 'stdout', text: later.shift() ?? '' }
        await new Promise<void>(resolve => {
          wake = resolve
          next.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return { value: { code: 0, signal: null } }
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
    acks: () => runs.filter(run => run.argv[2] === 'ack').map(run => run.argv.slice(3)),
    follows,
    saved,
    panes,
    bare,
    spawns: () => spawns,
    running: () => running,
    probes: () => probes,
    started,
    print: (text: string) => {
      later.push(text)
      wake()
    },
    status: () => statuses.at(-1),
    // Lets the follower's loop and the deliveries it started run to rest.
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
    meeting: null, approval: null, isViaMonitor: false, handoffs: [], ...panel,
  }
  let isSeeded = true
  on('state.get', ($, e, next) =>
    isSeeded && e.key === 'panel' ? { value: { value: { shape: 'panel-2', value: before }, version: 1 } } : next(e))
  on('state.set', ($, e, next) => {
    if (e.key === 'panel') isSeeded = false
    return next(e)
  })
}

/** A session whose model loaded the connect-agent skill. */
export const loadSkill = async ($: Engine, stub: { settle: () => Promise<void> }) => {
  await start($)
  const loading = $.tool.call({ tool: 'Skill', skill: 'blixel:connect-agent' })
  await stub.settle()
  await loading
  await stub.settle()
}

/** A session that ran /blixel:connect, its follower started. */
export const connectSession = async ($: Engine, stub: { settle: () => Promise<void> }, isInteractive = true) => {
  await start($, isInteractive)
  await run($, 'blixel:connect')
  await stub.settle()
}

// The kit fills in the fields only the engine sets (origin, presentation).
export const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0])

export const complete = ($: Engine) =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null } as never)

