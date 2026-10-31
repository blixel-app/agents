import { expect, test } from 'claude-code/testing'

import { complete, connectSession, current, loadSkill, PID, printed, run, seedPanel, stage, start, STARTED, status } from './support'
import type { Ran } from './support'

test('a handoff the follower prints is submitted as a prompt of its own, worded as Blixel words it', async ($, on) => {
  const first = printed('Ana asks: could you add a test for the reconnect case?', 'Ana', 1)
  const stub = stage(on, {
    printed: [first.slice(0, 20), first.slice(20) + printed('And run it', 'Bea', 2)],
  })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Ana asks: could you add a test for the reconnect case?', 'And run it'])
  expect(stub.bare).toEqual([true, true])
})

test('a line the follower prints that is no handoff submits nothing', async ($, on) => {
  const stub = stage(on, { printed: ['Not an object\n', '{"id":3,"sender_name":"Ana"}\n', printed('Only this')] })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Only this'])
})

test('a dropped handoff is submitted again after the next turn, and not once it entered', async ($, on) => {
  let drops = 1
  const stub = stage(on, {
    printed: [printed('Rename the flag')],
    submit: () => (drops-- > 0 ? 'a Stop stands' : undefined),
  })

  await connectSession($, stub)
  expect(stub.submitted).toEqual(['Rename the flag'])

  await complete($)
  await stub.settle()
  expect(stub.submitted).toEqual(['Rename the flag', 'Rename the flag'])

  await complete($)
  await stub.settle()
  expect(stub.submitted).toEqual(['Rename the flag', 'Rename the flag'])
})

test('a handoff the user stopped with Esc waits, says so, and goes after their next message', async ($, on) => {
  // What Claude Code answers: the queued prompt is dropped by the stop, and
  // new ones are refused until the user sends something.
  const answers = ['the prompt was removed from the queue before it ran',
    'the session was stopped and nobody has sent input since',
    'the session was stopped and nobody has sent input since']
  const stub = stage(on, {
    printed: [printed('Rename the flag', 'Ana', 1), printed('Run the tests', 'Ana', 2)],
    // The second handoff's turn starts only once the first one's has ended.
    submit: text => (text === 'Run the tests' ? stub.clock.sleep(5_000).then(() => undefined) : answers.shift()),
  })

  await connectSession($, stub)
  // The interrupted turn ends; the user has sent nothing yet.
  await complete($)
  await stub.settle()
  expect(stub.status()).toBe('✦ connected · 2 handoffs waiting for your next message')
  expect(stub.toasts).toEqual(['A Blixel handoff is waiting: it runs after your next message.'])

  // The turn of the user's next message ends.
  await complete($)
  await stub.settle()
  expect(stub.submitted.filter(text => text === 'Rename the flag')).toHaveLength(4)
  expect(stub.status()).toBe('✦ connected · 1 handoff waiting')

  await stub.clock.advance(5_000)
  await stub.settle()
  expect(stub.submitted.filter(text => text === 'Run the tests')).toHaveLength(1)
  expect(stub.status()).toBe('✦ connected')
  expect(stub.toasts).toHaveLength(1)
})

test('a handoff this session had not yet submitted is submitted when the mod loads again', async ($, on) => {
  // A reload keeps only $.store: these entries stand for what the previous
  // load of the module saved, for this `claude` and for an older process that
  // had the same pid.
  seedPanel(on, { handoffs: [{ n: 1, text: 'Left over', sender: 'Ana', at: 0, state: 'waiting' }] })
  const stub = stage(on, {
    stored: {
      [`queue:${PID}:${STARTED}`]: { next: 2, pending: [{ n: 1, text: 'Left over' }] },
      [`queue:${PID}:Thu Oct 23 09:00:00 2026`]: { next: 2, pending: [{ n: 1, text: 'Not ours' }] },
    },
  })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Left over'])
  expect(stub.spawns()).toBe(0)
})

test('a handoff is acked as queued once it is saved, while its prompt still waits out a turn', async ($, on) => {
  let savedAtAck: unknown
  const stub = stage(on, {
    printed: [printed('Rename the flag', 'Ana', 7)],
    submit: () => stub.clock.sleep(60_000).then(() => undefined),
    cli: command => {
      if (command === 'ack') savedAtAck = stub.saved.get(`queue:${PID}:${STARTED}`)
      return { exitCode: 0, stdout: command === 'status' ? status({}) : current() }
    },
  })

  await connectSession($, stub)

  expect(stub.follows).toEqual([['agent', 'follow', '--json', '--acks']])
  expect(stub.acks()).toEqual([['7', 'queued']])
  expect(savedAtAck).toEqual({ next: 2, pending: [{ n: 1, text: 'Rename the flag' }] })
})

test('a handoff keeps its line breaks, and one with only its prompt still arrives', async ($, on) => {
  const line = JSON.stringify({ id: 1, prompt: 'First Second', message: 'First\nSecond', sender_name: 'Ana' })
  const stub = stage(on, { printed: [`${line}\n`, printed('No message beside it', 'Ana', 2)] })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['First\nSecond', 'No message beside it'])
})

const oldCLI = (args: readonly string[]) =>
  args.includes('--acks')
    ? '{"error":{"category":"usage","code":"usage","exit_status":2,"message":"Unknown option \'--acks\'"},"schema_version":1}'
    : undefined

test('a CLI without --acks follows as before, and nothing is acked', async ($, on) => {
  const stub = stage(on, { followerFails: oldCLI, printed: [printed('Rename the flag')] })

  await connectSession($, stub)

  expect(stub.follows).toEqual([['agent', 'follow', '--json', '--acks'], ['agent', 'follow', '--json']])
  expect(stub.submitted).toEqual(['Rename the flag'])
  expect(stub.acks()).toEqual([])
})

test('a follower that fails for any other reason keeps asking for acks', async ($, on) => {
  let fails = 1
  const stub = stage(on, {
    followerFails: () =>
      fails-- > 0 ? '{"error":{"code":"usage","message":"Unknown option \'--other\'"}}' : undefined,
  })

  await connectSession($, stub)
  await stub.clock.advance(1_000)
  await stub.settle()

  expect(stub.follows).toEqual([['agent', 'follow', '--json', '--acks'], ['agent', 'follow', '--json', '--acks']])
})

for (const [app, code] of [
  ['an older app', 'incompatible_protocol'],
  ['an app that closed', 'app_unavailable'],
]) {
  test(`an ack ${app} cannot take is dropped, and the handoff still runs`, async ($, on) => {
    const stub = stage(on, {
      printed: [printed('Rename the flag', 'Ana', 7)],
      cli: command =>
        command === 'ack'
          ? { exitCode: 5, stderr: `{"error":{"code":"${code}","message":"No"}}\n` }
          : { exitCode: 0, stdout: command === 'status' ? status({}) : current() },
    })

    await connectSession($, stub)
    await stub.clock.advance(60_000)
    await stub.settle()

    expect(stub.submitted).toEqual(['Rename the flag'])
    expect(stub.acks()).toEqual([['7', 'queued']])
    expect(stub.toasts).toEqual([])
  })
}

test('a handoff printed without an id runs, with nothing to ack', async ($, on) => {
  const stub = stage(on, { printed: ['{"prompt":"Rename the flag"}\n'] })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Rename the flag'])
  expect(stub.acks()).toEqual([])
})

const refusedSave = (ack: (args: readonly string[]) => Ran | Promise<Ran>) => ({
  printed: [printed('Rename the flag', 'Ana', 7) + printed('And run it', 'Bea', 8)],
  saveFails: true,
  cli: (command: string, args: readonly string[]) =>
    command === 'ack' ? ack(args) : { exitCode: 0, stdout: command === 'status' ? status({}) : current() },
})

test('handoffs that cannot be saved are acked as failed and never run', async ($, on) => {
  const recorded = { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'recorded' } }) }
  // The first answer lands while the second handoff could still be picked up.
  const stub = stage(on, refusedSave(([id]) => (id === '7' ? recorded : stub.clock.sleep(1_000).then(() => recorded))))

  await connectSession($, stub)
  await stub.clock.advance(1_000)
  await stub.settle()

  expect(stub.acks().map(ack => ack.slice(0, 3))).toEqual([['7', 'failed', '--reason'], ['8', 'failed', '--reason']])
  expect(stub.submitted).toEqual([])
  expect(stub.status()).toBe(undefined)
})

test('a handoff that cannot be saved still runs when the app did not take its failed ack', async ($, on) => {
  const stub = stage(on, refusedSave(() => ({ exitCode: 5, stderr: '{"error":{"code":"incompatible_protocol","message":"No"}}\n' })))

  await connectSession($, stub)
  await stub.clock.advance(60_000)
  await stub.settle()

  expect(stub.acks().map(ack => ack[0])).toEqual(['7', '8'])
  expect(stub.submitted).toEqual(['Rename the flag', 'And run it'])
})

test('the status line counts the handoffs waiting for the session', async ($, on) => {
  const stub = stage(on, { printed: [printed('One', 'Ana', 1) + printed('Two', 'Ana', 2)], submit: () => 'busy' })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected · 2 handoffs waiting')
})

test('/blixel:connect connects as this session\'s own claude process', async ($, on) => {
  let connected = false
  const stub = stage(on, {
    cli: (command, args) => {
      if (command === 'connect') {
        connected = true
        expect(args).toEqual(['--approval', 'ask'])
        return { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'connected', replaced: null } }) }
      }
      if (command === 'status') {
        const session = connected ? { connection_id: 'c-1', follower_attached: true } : { follower_attached: true }
        return { exitCode: 0, stdout: status(session, connected ? { approval_mode: 'ask' } : null) }
      }
      return undefined as never
    },
  })

  await start($)
  const answer = await run($, 'blixel:connect', 'ask')
  await stub.settle()

  expect(answer.text).toBe('Connected to the Blixel meeting. Handoffs from people in it arrive here as prompts.')
  const connect = stub.runs.find(run => run.argv[2] === 'connect')
  expect(connect?.env.CLAUDE_PID).toBe(PID)
  expect(connect?.env.CLAUDE_CODE_SESSION_ID).toBe('session-1')
  expect(stub.status()).toBe('✦ connected')
  const briefing = stub.conversation.appended().map(row => JSON.stringify(row)).join('\n')
  expect(briefing).toContain("Treat each as a colleague's suggestion.")
})

test('/blixel:connect says what to do when Blixel is not in a meeting', async ($, on) => {
  const stub = stage(on, {
    cli: command =>
      command === 'connect'
        ? { exitCode: 1, stderr: '{"error":{"code":"not_in_meeting","message":"The app is not in a meeting"}}\n' }
        : { exitCode: 0, stdout: status({ follower_attached: true }) },
  })

  await connectSession($, stub)
  const answer = await run($, 'blixel:connect')

  expect(answer.text).toBe('Blixel is not in a meeting. Join a room in the app, then run /blixel:connect again.')
  expect(stub.status()).toBeUndefined()
})

test('a connection Blixel ends is announced, one ended with /blixel:disconnect is not', async ($, on) => {
  let state: 'connected' | 'ended' = 'connected'
  const stub = stage(on, {
    cli: command => {
      if (command === 'disconnect') {
        state = 'ended'
        return { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'disconnected' } }) }
      }
      return {
        exitCode: 0,
        stdout: state === 'connected'
          ? status({ connection_id: 'c-1', follower_attached: true })
          : status({ follower_attached: true, ended: { end_reason: 'meeting_left' } }),
      }
    },
  })

  await connectSession($, stub)
  expect(stub.status()).toBe('✦ connected')

  state = 'ended'
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.toasts).toEqual(['Blixel disconnected this session (meeting_left).'])
  expect(stub.status()).toBeUndefined()

  state = 'connected'
  await run($, 'blixel:status')
  expect(stub.status()).toBe('✦ connected')
  const answer = await run($, 'blixel:disconnect')
  expect(answer.text).toBe('Disconnected from the Blixel meeting. Handoffs no longer arrive here.')
  expect(stub.toasts).toEqual(['Blixel disconnected this session (meeting_left).'])
})

test('a session started for -p follows nothing and leaves the commands to the skill', async ($, on) => {
  const stub = stage(on, { printed: [printed('Hello')], env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } })

  await start($, false)
  await stub.settle()

  expect(stub.spawns()).toBe(0)
  expect(stub.submitted).toEqual([])
  expect((await run($, 'blixel:status')).text).toBe('the skill takes it')
})

test('a session the desktop app hosts follows its handoffs too', async ($, on) => {
  const stub = stage(on, { printed: [printed('Hello')], env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })

  await connectSession($, stub, false)

  expect(stub.submitted).toEqual(['Hello'])
  expect((await run($, 'blixel:status')).text).toBe('This session is connected to the Blixel meeting; handoffs come straight here.')
})

const connectedIn = (room: 'connected' | 'reconnecting' | 'idle', name: string | null = 'Design sync') =>
  (command: string) =>
    command === 'current'
      ? { exitCode: 0, stdout: current(room, name) }
      : { exitCode: 0, stdout: status({ connection_id: 'c-1', follower_attached: true }, { meeting_id: 'm-1' }) }

test('the status line names the meeting the session is connected to', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected') })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('the status line says while the app reconnects to the meeting', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('reconnecting') })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected to Design sync · reconnecting')
})

test('a meeting the app has no name for is only connected', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected', null) })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected')
})

test('a session Blixel was never invoked in runs nothing and shows nothing, in a meeting or not', async ($, on) => {
  const stub = stage(on, { cli: command => ({ exitCode: 0, stdout: command === 'current' ? current('connected') : status({}) }) })

  await start($)
  await stub.settle()
  await complete($)
  await stub.clock.advance(60 * 60_000)
  await stub.settle()

  expect(stub.probes()).toBe(0)
  expect(stub.runs).toEqual([])
  expect(stub.spawns()).toBe(0)
  expect(stub.statuses.filter(line => line !== undefined)).toEqual([])
})

test('/blixel:status reads once and leaves nothing running', async ($, on) => {
  const stub = stage(on, { cli: command => ({ exitCode: 0, stdout: command === 'current' ? current('connected') : status({}) }) })

  await start($)
  const answer = await run($, 'blixel:status')
  await stub.settle()
  await stub.clock.advance(60 * 60_000)
  await stub.settle()

  expect(answer.text).toBe('No agent is connected to the Blixel meeting.')
  expect(stub.runs.map(one => one.argv[2])).toEqual(['status', 'current'])
  expect(stub.spawns()).toBe(0)
  expect(stub.status()).toBeUndefined()
})

test('/blixel:status finds a connection this mod did not start and follows it', async ($, on) => {
  const stub = stage(on, { isLive: true, cli: connectedIn('connected') })

  await start($)
  await run($, 'blixel:status')
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('connecting again while connected keeps the one follower', async ($, on) => {
  const stub = stage(on, { isLive: true })

  await connectSession($, stub)
  await run($, 'blixel:connect')
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.spawns()).toBe(1)
})

test('a connect that fails leaves nothing running', async ($, on) => {
  const stub = stage(on, {
    isLive: true,
    cli: command =>
      command === 'connect'
        ? { exitCode: 1, stderr: '{"error":{"code":"not_in_meeting","message":"The app is not in a meeting"}}\n' }
        : (undefined as never),
  })
  const asked = () => stub.runs.filter(one => one.argv[2] === 'status').length

  await start($)
  await run($, 'blixel:connect')
  await stub.settle()
  expect(stub.running()).toBe(0)

  const before = asked()
  await stub.clock.advance(60_000)
  await stub.settle()
  expect(asked()).toBe(before)
})

test('a connect right after a failed one leaves one follower, however late the first one starts', async ($, on) => {
  let isConnecting = false
  let isHeld = false
  let release = () => {}
  let fail = () => {}
  const stub = stage(on, {
    isLive: true,
    // The first read once a connect is out is its follower's: it is still
    // starting when that connect fails.
    sessionID: () => {
      if (!isConnecting || isHeld) return Promise.resolve('session-1')
      isHeld = true
      return new Promise(resolve => {
        release = () => resolve('session-1')
      })
    },
    cli: command => {
      if (command !== 'connect' || isHeld) return undefined as never
      isConnecting = true
      return new Promise(resolve => {
        fail = () => resolve({ exitCode: 1, stderr: '{"error":{"code":"not_in_meeting","message":"No"}}\n' })
      })
    },
  })

  await start($)
  const failing = run($, 'blixel:connect')
  await stub.clock.advance(0)
  fail()
  await failing
  await run($, 'blixel:connect')
  await stub.clock.advance(0)
  release()
  await stub.settle()

  expect(stub.running()).toBe(1)
})

for (const [how, end] of [
  ['/blixel:disconnect', 'command'],
  ['the meeting ending', 'meeting_left'],
  ['another session replacing this one', 'replaced'],
  ['the app closing', 'closed'],
] as const) {
  test(`${how} stops the follower and the poll, and a connect starts them again`, async ($, on) => {
    let state: 'connected' | 'ended' | 'closed' = 'connected'
    const stub = stage(on, {
      isLive: true,
      cli: command => {
        if (command === 'connect') state = 'connected'
        if (state === 'closed') return { exitCode: 1, stderr: '{"error":{"code":"app_unavailable","message":"No"}}\n' }
        if (command === 'current') return { exitCode: 0, stdout: current('connected') }
        if (command === 'disconnect') state = 'ended'
        if (command === 'disconnect' || command === 'connect') {
          return { exitCode: 0, stdout: JSON.stringify({ data: { outcome: `${command}ed` } }) }
        }
        return {
          exitCode: 0,
          stdout:
            state === 'connected'
              ? status({ connection_id: 'c-1', follower_attached: true }, { meeting_id: 'm-1' })
              : status({ ended: { end_reason: end } }),
        }
      },
    })
    const asked = () => stub.runs.filter(one => one.argv[2] === 'status').length

    await connectSession($, stub)
    expect(stub.running()).toBe(1)

    if (end === 'command') await run($, 'blixel:disconnect')
    else {
      state = end === 'closed' ? 'closed' : 'ended'
      await stub.clock.advance(15_000)
    }
    await stub.settle()
    expect(stub.running()).toBe(0)
    expect(stub.status()).toBeUndefined()

    const before = asked()
    await stub.clock.advance(120_000)
    await stub.settle()
    expect(asked()).toBe(before)
    expect(stub.spawns()).toBe(1)

    await run($, 'blixel:connect')
    await stub.settle()
    expect(stub.spawns()).toBe(2)
    expect(stub.status()).toBe('✦ connected to Design sync')
  })
}

test('the app closing while connected says so', async ($, on) => {
  let isOpen = true
  const stub = stage(on, {
    isLive: true,
    cli: command =>
      isOpen
        ? connectedIn('connected')(command)
        : { exitCode: 1, stderr: '{"error":{"code":"app_unavailable","message":"No"}}\n' },
  })

  await connectSession($, stub)
  isOpen = false
  await stub.clock.advance(15_000)
  await stub.settle()

  expect(stub.toasts).toEqual(['Blixel closed, and this session is no longer connected.'])
})

test("a connection's end does not stop the follower a connect in flight is waiting on", async ($, on) => {
  let state: 'connected' | 'ended' = 'connected'
  let answerConnect = () => {}
  const stub = stage(on, {
    isLive: true,
    cli: command => {
      if (command === 'connect' && state === 'ended') {
        return new Promise(resolve => {
          answerConnect = () => {
            state = 'connected'
            resolve({ exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'connected' } }) })
          }
        })
      }
      return {
        exitCode: 0,
        stdout: state === 'connected' ? status({ connection_id: 'c-1' }, { meeting_id: 'm-1' }) : status({}),
      }
    },
  })

  await connectSession($, stub)
  state = 'ended'
  const again = run($, 'blixel:connect')
  await stub.settle()
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.running()).toBe(1)

  answerConnect()
  await again
  await stub.settle()

  expect(stub.spawns()).toBe(1)
  expect(stub.status()).toBe('✦ connected')
})

for (const command of [
  'blixel agent connect',
  '/some/plugin/scripts/blixel agent connect --approval ask',
  '"/some plugin/scripts/blixel" agent connect',
  'cd /work && blixel agent connect 2>&1',
]) {
  test(`\`${command}\` through Bash follows, and goes to the app with its follower on the way`, async ($, on) => {
    const stub = stage(on, { isLive: true })
    let startedFirst = false
    on('tool.call', async () => {
      await stub.settle()
      startedFirst = stub.running() === 1
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await start($)
    await $.tool.call({ tool: 'Bash', command })
    await stub.settle()

    expect(startedFirst).toBe(true)
  })
}

for (const command of [
  'grep "blixel agent" notes.md',
  'grep -rn "blixel agent connect" docs',
  "git commit -m 'blixel agent disconnect stops the monitor'",
]) {
  test(`\`${command}\` only names Blixel, and runs nothing for it`, async ($, on) => {
    const stub = stage(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

    await start($)
    await $.tool.call({ tool: 'Bash', command })
    await stub.settle()

    expect(stub.spawns()).toBe(0)
    expect(stub.runs).toEqual([])
  })
}

test("loading the skill attaches the mod's follower before the skill's monitor can", async ($, on) => {
  const stub = stage(on, { isLive: true })
  let attachedAtSkill = false
  on('tool.call', () => {
    attachedAtSkill = stub.running() === 1
    return { result: { success: true, commandName: 'blixel:connect-agent' } }
  })

  await loadSkill($, stub)

  expect(attachedAtSkill).toBe(true)
})

const stopHook = (task: Record<string, unknown>) =>
  ({ background_tasks: [{ id: 'task-1', status: 'running', ...task }] }) as never
const plugged = { type: 'shell', description: 'Blixel handoffs', command: '"/p"/bin/blixel agent follow' }
const verdict = (decision: string) => () => ({ decision }) as never

test("the plugin's monitor is stopped when the turn that armed it ends, while the mod follows", async ($, on) => {
  const stub = stage(on, { isLive: true })
  const stops: unknown[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskStop') stops.push(e.task_id)
    return { result: { success: true, commandName: 'blixel:connect-agent' } }
  })
  on('tool.check', verdict('allow'))
  on('classic.Stop', () => ({}))

  await loadSkill($, stub)
  await $.classic.Stop(stopHook(plugged))

  expect(stops).toEqual(['task-1'])
  expect(stub.running()).toBe(1)
})

test("a monitor is left running where the mod cannot follow: it is the session's only route", async ($, on) => {
  const stub = stage(on, { probeFails: true })
  const stops: unknown[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskStop') stops.push(e.task_id)
    return { result: { success: true, commandName: 'blixel:connect-agent' } }
  })
  on('tool.check', verdict('allow'))
  on('classic.Stop', () => ({}))

  await loadSkill($, stub)
  await $.classic.Stop(stopHook(plugged))

  expect(stub.spawns()).toBe(0)
  expect(stops).toEqual([])
})

test('a monitor that holds the handoffs is left to deliver them, and anything else is left alone', async ($, on) => {
  const stub = stage(on, { isLive: true, follower: 'refused', cli: connectedIn('connected') })
  const stops: unknown[] = []
  on('tool.call', ($, e) => {
    stops.push(e.tool)
    return { result: {} }
  })
  on('tool.check', verdict('allow'))
  on('classic.Stop', () => ({}))

  await connectSession($, stub)
  await $.classic.Stop(stopHook(plugged))
  expect(stops).toEqual([])
})

test('another background task is left alone', async ($, on) => {
  const stub = stage(on, { isLive: true })
  const stops: unknown[] = []
  on('tool.call', ($, e) => {
    stops.push(e.tool)
    return { result: {} }
  })
  on('tool.check', verdict('allow'))
  on('classic.Stop', () => ({}))

  await connectSession($, stub)
  await $.classic.Stop(stopHook({ type: 'shell', description: 'tests', command: 'swift test' }))
  await $.classic.Stop(stopHook({ type: 'shell', description: 'Blixel handoffs', command: 'tail -f log' }))

  expect(stops).toEqual([])
})

test('another skill starts nothing', async ($, on) => {
  const stub = stage(on)
  on('tool.call', () => ({ result: { success: true, commandName: 'review' } }))

  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'review' })
  await stub.settle()

  expect(stub.spawns()).toBe(0)
})

test('a follower the skill started and no connection followed stops within a minute', async ($, on) => {
  const stub = stage(on, { isLive: true, cli: command => ({ exitCode: 0, stdout: command === 'current' ? current() : status({}) }) })
  on('tool.call', () => ({ result: { success: true, commandName: 'blixel:connect-agent' } }))

  await loadSkill($, stub)
  await stub.clock.advance(45_000)
  await stub.settle()
  expect(stub.running()).toBe(1)

  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.running()).toBe(0)
})

test('a reload while connected follows again with no command', async ($, on) => {
  seedPanel(on, { isConnected: true, room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  const stub = stage(on, { isLive: true, cli: connectedIn('connected') })

  await start($)
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('a reload while connected also submits a handoff still waiting, with no turn to end first', async ($, on) => {
  seedPanel(on, {
    isConnected: true, room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true,
    handoffs: [{ n: 1, text: 'Left over', sender: 'Ana', at: 0, state: 'waiting' }],
  })
  const stub = stage(on, {
    isLive: true,
    cli: connectedIn('connected'),
    stored: { [`queue:${PID}:${STARTED}`]: { next: 2, pending: [{ n: 1, text: 'Left over' }] } },
  })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Left over'])
})

test('a reload that cannot read the app keeps following until a poll can', async ($, on) => {
  seedPanel(on, { isConnected: true, room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  let isBusy = true
  const stub = stage(on, {
    isLive: true,
    cli: command =>
      isBusy ? { exitCode: 1, stderr: '{"error":{"code":"busy","message":"Try again"}}\n' } : connectedIn('connected')(command),
  })

  await start($)
  await stub.settle()
  expect(stub.running()).toBe(1)

  isBusy = false
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.running()).toBe(1)
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('a reload after the connection ended leaves nothing running', async ($, on) => {
  seedPanel(on, { isConnected: true, room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  const stub = stage(on, { isLive: true, cli: command => ({ exitCode: 0, stdout: command === 'current' ? current() : status({}) }) })

  await start($)
  await stub.settle()

  expect(stub.spawns()).toBe(0)
  expect(stub.status()).toBeUndefined()
})

test('/clear keeps a connected session following', async ($, on) => {
  const stub = stage(on, { isLive: true, cli: connectedIn('connected') })
  on('session.end', () => ({ sessionId: 'session-2' }))

  await connectSession($, stub)
  await $.session.end({ reason: 'clear' } as never)
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.spawns()).toBe(1)
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('a handoff waiting when its connection ends still runs after the next turn', async ($, on) => {
  let isEnded = false
  let isBusy = true
  const stub = stage(on, {
    isLive: true,
    printed: [printed('Rename the flag')],
    submit: () => (isBusy ? 'a Stop stands' : undefined),
    cli: command =>
      command === 'current'
        ? { exitCode: 0, stdout: current('connected') }
        : command === 'connect'
          ? undefined as never
          : { exitCode: 0, stdout: isEnded ? status({ ended: { end_reason: 'meeting_left' } }) : status({ connection_id: 'c-1' }, { meeting_id: 'm-1' }) },
  })

  await connectSession($, stub)
  isEnded = true
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.running()).toBe(0)
  expect(stub.status()).toBe('✦ 1 handoff waiting')

  isBusy = false
  await complete($)
  await stub.settle()
  expect(stub.submitted).toEqual(['Rename the flag', 'Rename the flag'])
  expect(stub.status()).toBeUndefined()
})

test('an answer the app gave before a connect does not undo the connect when it arrives after it', async ($, on) => {
  let connected = false
  let isSlow = false
  const stub = stage(on, {
    cli: command => {
      if (command === 'connect') {
        connected = true
        return { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'connected', replaced: null } }) }
      }
      const answer =
        command === 'current'
          ? { exitCode: 0, stdout: current('connected') }
          : connected
            ? { exitCode: 0, stdout: status({ connection_id: 'c-1', follower_attached: true }, { meeting_id: 'm-1' }) }
            : { exitCode: 0, stdout: status({ follower_attached: true }) }
      return isSlow ? stub.clock.sleep(10_000).then(() => answer) : answer
    },
  })

  on('tool.call', () => ({ result: { success: true, commandName: 'blixel:connect-agent' } }))
  await loadSkill($, stub)
  isSlow = true
  await stub.clock.advance(15_000)
  isSlow = false
  await run($, 'blixel:connect')
  await stub.settle()
  expect(stub.status()).toBe('✦ connected to Design sync')

  await stub.clock.advance(10_000)
  await stub.settle()
  expect(stub.status()).toBe('✦ connected to Design sync')
  expect(stub.toasts).toEqual([])
})

test('the poll does not ask again while the app has not answered it', async ($, on) => {
  let isSlow = false
  const stub = stage(on, {
    cli: command => {
      if (command === 'connect') return { exitCode: 0, stdout: '{"data":{"outcome":"connected"}}' }
      const answer = {
        exitCode: 0,
        stdout: command === 'current' ? current() : status({ connection_id: 'c-1' }, { meeting_id: 'm-1' }),
      }
      return isSlow ? stub.clock.sleep(20_000).then(() => answer) : answer
    },
  })
  const asked = () => stub.runs.filter(run => run.argv[2] === 'status').length

  await connectSession($, stub)
  isSlow = true
  const before = asked()

  // Asks at 15 s; the tick at 30 s finds that answer still out.
  await stub.clock.advance(30_000)
  await stub.settle()
  expect(asked()).toBe(before + 1)

  // That answer lands at 35 s, and the tick at 45 s asks again.
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(asked()).toBe(before + 2)
})

test('the status line names a room only once the app counts it as the meeting its agents are in', async ($, on) => {
  const stub = stage(on, {
    cli: command =>
      command === 'current'
        ? { exitCode: 0, stdout: current('connected', 'Design sync', 'm-2') }
        : { exitCode: 0, stdout: status({ follower_attached: true }, null, null as never) },
  })

  await connectSession($, stub)

  expect(stub.status()).toBeUndefined()
})

test('the status line names the meeting beside a monitor that holds the handoffs', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected'), follower: 'refused', isLive: true })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected to Design sync, handoffs go to its monitor')
})

test('the status line drops the meeting once the app closes', async ($, on) => {
  let isOpen = true
  const connected = connectedIn('connected')
  const stub = stage(on, {
    cli: command =>
      isOpen
        ? connected(command)
        : { exitCode: 1, stderr: '{"error":{"code":"app_unavailable","message":"The app is not running"}}\n' },
  })

  await connectSession($, stub)
  expect(stub.status()).toBe('✦ connected to Design sync')

  isOpen = false
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.status()).toBeUndefined()
})
