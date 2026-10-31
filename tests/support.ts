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
  // the default is a session not connected, in an app in no room. A promise
  // answers once it settles.
  cli?: (command: string, args: readonly string[]) => Ran | Promise<Ran>
  stored?: Record<string, unknown>
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
  let spawns = 0
  const later: string[] = []
  let wake = () => {}

  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for the plugin's own command, the prompt that hands it to the skill.
  on('command.run', () => ({ text: 'the skill takes it' }))
  on('session.id', () => ({ value: 'session-1' }))
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
    if (e.argv[0] === '/bin/sh') return { value: { ...read, exitCode: 0, stdout: `${PID}\n${STARTED}\n` } }
    runs.push({ argv: e.argv, env: e.init?.env ?? {} })
    const command = e.argv[2] ?? ''
    const answer = (await setup.cli?.(command, e.argv.slice(3))) ??
      (command === 'status'
        ? { exitCode: 0, stdout: status({ follower_attached: true }) }
        : command === 'current'
          ? { exitCode: 0, stdout: current() }
          : { exitCode: 1 })
    return { value: { ...read, stdout: '', ...answer } }
  })
  on('process.spawn', async function* ($, e) {
    const args = e.argv.slice(1)
    follows.push(args)
    const failure = setup.followerFails?.(args)
    if (failure !== undefined) {
      yield { stream: 'stderr', text: `${failure}\n` }
      return { value: { code: 2, signal: null } }
    }
    spawns += 1
    if (spawns === 1) {
      const state = setup.follower ?? 'attached'
      yield { stream: 'stderr', text: `{"event":"follower","data":{"state":"${state}"}}\n` }
      for (const text of setup.printed ?? []) yield { stream: 'stdout', text }
      while (setup.isLive) {
        while (later.length > 0) yield { stream: 'stdout', text: later.shift() ?? '' }
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }
    return { value: { code: 0, signal: null } }
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

// The kit fills in the fields only the engine sets (origin, presentation).
export const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0])

export const complete = ($: Engine) =>
  $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null } as never)

