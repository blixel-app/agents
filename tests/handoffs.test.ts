import { expect, test } from 'claude-code/testing'

import {
  bash, complete, connected, connectSession, current, failure, PID, printed, RECEIVE, run, seedPanel, stage, start,
  STARTED, status,
  settled,
} from './support'
import type { Ran } from './support'

test('a handoff the receiver prints is submitted as a prompt of its own, worded as Blixel words it', async ($, on) => {
  const first = printed('Ana asks: could you add a test for the reconnect case?', 'Ana', '1')
  const stub = stage(on, {
    printed: [first.slice(0, 20), first.slice(20) + printed('And run it', 'Bea', '2')],
  })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Ana asks: could you add a test for the reconnect case?', 'And run it'])
  expect(stub.bare).toEqual([true, true])
})

test('a line the receiver prints that is no handoff submits nothing', async ($, on) => {
  const stub = stage(on, {
    printed: [
      'Not an object\n',
      '{"data":{"id":"3","sender":{"name":"Ana"}},"event":"handoff","schema_version":1}\n',
      '{"data":{"id":"4","prompt":"A delivered event is no handoff"},"event":"delivered","schema_version":1}\n',
      printed('Only this'),
    ],
  })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Only this'])
})

test('nothing is added to a connected session: no rules, no frame', async ($, on) => {
  const stub = stage(on, { printed: [printed('Rename the flag')] })

  await connectSession($, stub)

  expect(stub.conversation.appended()).toEqual([])
  expect(stub.submitted).toEqual(['Rename the flag'])
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
    printed: [printed('Rename the flag', 'Ana', '1'), printed('Run the tests', 'Ana', '2')],
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
  expect(stub.receivers).toEqual([])
})

test('a handoff is confirmed delivered once it is saved, while its prompt still waits out a turn', async ($, on) => {
  let savedAtConfirm: unknown
  const stub = stage(on, {
    printed: [printed('Rename the flag', 'Ana', '7')],
    submit: () => stub.clock.sleep(60_000).then(() => undefined),
    cli: command => {
      if (command === 'confirm') savedAtConfirm = stub.saved.get(`queue:${PID}:${STARTED}`)
      return undefined
    },
  })

  await connectSession($, stub)

  expect(stub.receivers).toEqual([RECEIVE])
  expect(stub.confirms()).toEqual([['7', 'delivered']])
  expect(savedAtConfirm).toEqual({ next: 2, pending: [{ n: 1, text: 'Rename the flag' }] })
})

test('a handoff keeps its line breaks, and one with only its prompt still arrives', async ($, on) => {
  const stub = stage(on, { printed: [printed('First Second', 'Ana', '1', 'First\nSecond'), printed('No message beside it', 'Ana', '2')] })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['First\nSecond', 'No message beside it'])
})

test('nothing the mod starts is looked up on PATH, as it runs outside the sandbox', async ($, on) => {
  const stub = stage(on)

  await connectSession($, stub)

  const [probe, ...clis] = stub.started
  expect(probe).toMatch(/exec \/bin\/ps /)
  expect(clis.length).toBeGreaterThan(1)
  for (const cli of clis) expect(cli).toMatch(/\/skills\/connect-agent\/scripts\/app-cli$/)
})

for (const [app, answer] of [
  ['an app that closed', { exitCode: 5, stderr: failure('app_unavailable') }],
  ['an app past its 10 s', { exitCode: 0, stdout: JSON.stringify({ data: { handoff_id: '7', outcome: 'late' } }) }],
] as const) {
  test(`a confirm ${app} cannot take is dropped, and the handoff still runs`, async ($, on) => {
    const stub = stage(on, {
      printed: [printed('Rename the flag', 'Ana', '7')],
      cli: command => (command === 'confirm' ? answer : undefined),
    })

    await connectSession($, stub)
    await stub.clock.advance(60_000)
    await stub.settle()

    expect(stub.submitted).toEqual(['Rename the flag'])
    expect(stub.confirms()).toEqual([['7', 'delivered']])
    expect(stub.toasts).toEqual([])
  })
}

test('a handoff printed without an id runs, with nothing to confirm', async ($, on) => {
  const stub = stage(on, { printed: ['{"data":{"prompt":"Rename the flag"},"event":"handoff","schema_version":1}\n'] })

  await connectSession($, stub)

  expect(stub.submitted).toEqual(['Rename the flag'])
  expect(stub.confirms()).toEqual([])
})

const refusedSave = (confirm: (args: readonly string[]) => Ran | Promise<Ran>) => ({
  printed: [printed('Rename the flag', 'Ana', '7') + printed('And run it', 'Bea', '8')],
  saveFails: true,
  cli: (command: string, args: readonly string[]) => (command === 'confirm' ? confirm(args) : undefined),
})

test('handoffs that cannot be saved are confirmed failed and never run', async ($, on) => {
  const recorded = { exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'recorded' } }) }
  // The first answer lands while the second handoff could still be picked up.
  const stub = stage(on, refusedSave(([id]) => (id === '7' ? recorded : stub.clock.sleep(1_000).then(() => recorded))))

  await connectSession($, stub)
  await stub.clock.advance(1_000)
  await stub.settle()

  expect(stub.confirms().map(one => one.slice(0, 3))).toEqual([['7', 'failed', '--reason'], ['8', 'failed', '--reason']])
  expect(stub.submitted).toEqual([])
  expect(stub.status()).toBe('✦ connected')
})

test('a handoff that cannot be saved still runs when the app did not take its failed confirm', async ($, on) => {
  const stub = stage(on, refusedSave(() => ({ exitCode: 0, stdout: JSON.stringify({ data: { outcome: 'late' } }) })))

  await connectSession($, stub)
  await stub.clock.advance(60_000)
  await stub.settle()

  expect(stub.confirms().map(one => one[0])).toEqual(['7', '8'])
  expect(stub.submitted).toEqual(['Rename the flag', 'And run it'])
})

test('the status line counts the handoffs waiting for the session', async ($, on) => {
  const stub = stage(on, { printed: [printed('One', 'Ana', '1') + printed('Two', 'Ana', '2')], submit: () => 'busy' })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected · 2 handoffs waiting')
})

// Typed connect

test("/blixel:connect connects as this session's own claude process, then receives", async ($, on) => {
  const stub = stage(on)

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))
  await stub.settle()

  expect(answer.text).toBe('Connected to the Blixel meeting. Handoffs from people in it arrive here as prompts.')
  expect(stub.timeline.slice(0, 2)).toEqual(['connect', 'receive'])
  expect(stub.receivers).toEqual([RECEIVE])
  const connect = stub.runs.find(one => one.argv[2] === 'connect')
  expect(connect?.argv.slice(3)).toEqual([])
  expect(connect?.env.CLAUDE_PID).toBe(PID)
  expect(connect?.env.CLAUDE_CODE_SESSION_ID).toBe('session-1')
  expect(stub.status()).toBe('✦ connected')
})

test('/blixel:connect answers once its receiver is receiving', async ($, on) => {
  let isReceiving = false
  const stub = stage(on, {
    cli: command => {
      if (command === 'status') isReceiving = stub.running() > 0
      return undefined
    },
  })

  await start($)
  await settled(stub, run($, 'blixel:connect'))

  expect(isReceiving).toBe(true)
})

test('/blixel:connect retries a connect whose outcome it could not learn with the same request id', async ($, on) => {
  let tries = 0
  const stub = stage(on, {
    cli: (command, args) => {
      if (command !== 'connect' || (tries += 1) > 1) return undefined
      return {
        exitCode: 5,
        stderr: '{"data":{"request_id":"r-9"},"event":"request_id","schema_version":1}\n' + failure('connect_outcome_unknown'),
      }
    },
  })

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))

  expect(answer.text).toMatch(/^Connected to the Blixel meeting/)
  expect(stub.runs.filter(one => one.argv[2] === 'connect').map(one => one.argv.slice(3))).toEqual([[], ['--request-id', 'r-9']])
})

test('/blixel:connect says it replaced the session connected before', async ($, on) => {
  const stub = stage(on, { cli: command => (command === 'connect' ? { exitCode: 0, stdout: connected(false, { replaced: true }) } : undefined) })

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))

  expect(answer.text).toBe(
    'Connected to the Blixel meeting. Handoffs from people in it arrive here as prompts. It replaced the session that was connected before.',
  )
  expect(stub.running()).toBe(1)
})

test('/blixel:connect says what to do when Blixel is not in a meeting, and starts nothing', async ($, on) => {
  const stub = stage(on, {
    cli: command => (command === 'connect' ? { exitCode: 5, stderr: failure('not_in_meeting', 'The app is not in a meeting') } : undefined),
  })

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))
  await stub.settle()
  await stub.clock.advance(60_000)
  await stub.settle()

  expect(answer.text).toBe('Blixel is not in a meeting. Join a room in the app, then run /blixel:connect again.')
  expect(stub.receivers).toEqual([])
  expect(stub.runs.map(one => one.argv[2])).toEqual(['connect'])
  expect(stub.status()).toBeUndefined()
})

test('/blixel:connect takes no options: approval is the app\'s', async ($, on) => {
  const stub = stage(on)

  await start($)
  await settled(stub, run($, 'blixel:connect', 'ask'))

  expect(stub.runs.find(one => one.argv[2] === 'connect')?.argv.slice(3)).toEqual([])
})

test('a session another receiver already receives for is connected, and the mod leaves it that one', async ($, on) => {
  // A Monitor the model started before this mod loaded.
  const stub = stage(on, { otherReceiver: true })

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))
  await stub.settle()
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(answer.text).toBe('Connected to the Blixel meeting. Another receiver in this session takes its handoffs.')
  expect(stub.status()).toBe('✦ connected · handoffs go to another receiver')
  expect(stub.receivers).toHaveLength(1)
  expect(stub.running()).toBe(0)
})

test('a receiver that cannot start says why, and is not started again', async ($, on) => {
  const stub = stage(on, {
    receiverFails: () => ({ stderr: failure('agent_unverified', 'The command does not run inside the session'), exitCode: 4 }),
  })

  await start($)
  const answer = await settled(stub, run($, 'blixel:connect'))
  await stub.settle()
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(answer.text).toBe('Connected to the Blixel meeting, but not receiving its handoffs yet. Run /blixel:status to check.')
  expect(stub.receivers).toHaveLength(1)
  expect(stub.toasts).toEqual(['Blixel stopped receiving handoffs: The command does not run inside the session'])
  expect(stub.status()).toBe('✦ connected · not receiving')
})

test('connecting again while receiving keeps the one receiver', async ($, on) => {
  const stub = stage(on)

  await connectSession($, stub)
  await settled(stub, run($, 'blixel:connect'))
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.receivers).toHaveLength(1)
})

test('a connect right after a failed one leaves one receiver, however late the first one starts', async ($, on) => {
  let isConnecting = false
  let isHeld = false
  let release = () => {}
  let fail = () => {}
  const stub = stage(on, {
    // The first read once a connect is out is its receiver's: it is still
    // starting when that connect fails.
    sessionID: () => {
      if (!isConnecting || isHeld) return Promise.resolve('session-1')
      isHeld = true
      return new Promise(resolve => {
        release = () => resolve('session-1')
      })
    },
    cli: command => {
      if (command !== 'connect' || isHeld) return undefined
      isConnecting = true
      return new Promise(resolve => {
        fail = () => resolve({ exitCode: 5, stderr: failure('not_in_meeting') })
      })
    },
  })

  await start($)
  const failing = run($, 'blixel:connect')
  await stub.clock.advance(0)
  fail()
  await failing
  const connecting = run($, 'blixel:connect')
  await stub.clock.advance(0)
  release()
  await stub.settle()
  await connecting
  await stub.settle()

  expect(stub.running()).toBe(1)
})

// The receiver stopping

for (const [how, reason] of [
  ['/blixel:disconnect', undefined],
  ['the meeting ending', 'meeting_ended'],
  ['another session replacing this one', 'replaced'],
  ['the session process ending', 'agent_exited'],
] as const) {
  test(`${how} stops the receiver and the poll, and a connect starts them again`, async ($, on) => {
    const stub = stage(on, { cli: command => (command === 'current' ? { exitCode: 0, stdout: current('connected') } : undefined) })
    const asked = () => stub.runs.filter(one => one.argv[2] === 'status').length

    await connectSession($, stub)
    expect(stub.running()).toBe(1)

    if (reason === undefined) await run($, 'blixel:disconnect')
    else stub.end(reason)
    await stub.settle()
    expect(stub.running()).toBe(0)
    expect(stub.status()).toBeUndefined()
    expect(stub.toasts).toEqual(reason === undefined ? [] : [`Blixel disconnected this session (${reason}).`])

    const before = asked()
    await stub.clock.advance(120_000)
    await stub.settle()
    expect(asked()).toBe(before)
    expect(stub.receivers).toHaveLength(1)

    await settled(stub, run($, 'blixel:connect'))
    await stub.settle()
    expect(stub.running()).toBe(1)
    expect(stub.status()).toBe('✦ connected to Design sync')
  })
}

test('a relaunched app, which has no connections, stops the receiver and says so', async ($, on) => {
  const stub = stage(on)

  await connectSession($, stub)
  stub.relaunch()
  await stub.settle()
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(stub.running()).toBe(0)
  expect(stub.receivers).toHaveLength(1)
  expect(stub.status()).toBeUndefined()
  expect(stub.toasts).toEqual(['Blixel disconnected this session.'])
})

test('a receiver refused for a connection that is gone is not started again', async ($, on) => {
  const stub = stage(on)

  await connectSession($, stub)
  stub.end('disconnected')
  await stub.settle()
  stub.toasts.length = 0
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(stub.receivers).toHaveLength(1)
  expect(stub.toasts).toEqual([])
})

test('the app closing while connected says so', async ($, on) => {
  let isOpen = true
  const stub = stage(on, { cli: () => (isOpen ? undefined : { exitCode: 5, stderr: failure('app_unavailable') }) })

  await connectSession($, stub)
  isOpen = false
  await stub.clock.advance(15_000)
  await stub.settle()

  expect(stub.toasts).toEqual(['Blixel closed, and this session is no longer connected.'])
  expect(stub.running()).toBe(0)
})

for (const how of ['killed', 'cancelled'] as const) {
  test(`a receiver ${how} is started again, with no connect`, async ($, on) => {
    const stub = stage(on)

    await connectSession($, stub)
    if (how === 'killed') stub.kill()
    else stub.cancel()
    await stub.settle()
    expect(stub.running()).toBe(0)

    await stub.clock.advance(1_000)
    await stub.settle()

    expect(stub.running()).toBe(1)
    expect(stub.timeline.filter(one => one === 'connect')).toHaveLength(1)
    expect(stub.toasts).toEqual([])
  })
}

test('a handoff waiting when its connection ends still runs after the next turn', async ($, on) => {
  let isBusy = true
  const stub = stage(on, {
    printed: [printed('Rename the flag')],
    submit: () => (isBusy ? 'a Stop stands' : undefined),
  })

  await connectSession($, stub)
  stub.end('meeting_ended')
  await stub.settle()
  expect(stub.running()).toBe(0)
  expect(stub.status()).toBe('✦ 1 handoff waiting')

  isBusy = false
  await complete($)
  await stub.settle()
  expect(stub.submitted).toEqual(['Rename the flag', 'Rename the flag'])
  expect(stub.status()).toBeUndefined()
})

// The model's own connect, through Bash

for (const command of [
  '/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect',
  '/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect --request-id 3f0c',
  '"/Applications/Blixel.app/Contents/Resources/bin/blixel" agent connect',
  'cd /work && blixel agent connect 2>&1',
]) {
  test(`\`${command}\` the model runs is taken over once Claude Code lets it run`, async ($, on) => {
    const stub = stage(on)
    bash(on, stub)

    await start($)
    const ran = await settled(stub, $.tool.call({ tool: 'Bash', command }))
    await stub.settle()

    expect(stub.running()).toBe(1)
    expect(stub.receivers).toEqual([RECEIVE])
    // What the model reads is connect's own answer, given once the mod receives.
    const answer = JSON.parse(String((ran.result as { stdout?: string } | undefined)?.stdout ?? '').trim())
    expect(answer.data.outcome).toBe('connected')
    expect(answer.data.receiving).toBe(true)
    expect(stub.timeline).toEqual(expect.arrayContaining(['connect', 'receive']))
    expect(stub.timeline.indexOf('connect')).toBeLessThan(stub.timeline.indexOf('receive'))
  })
}

test("the mod does nothing for the model's connect until Claude Code has decided on it", async ($, on) => {
  let decide = () => {}
  const stub = stage(on)
  bash(on, stub, 'allow', new Promise(resolve => {
    decide = resolve
  }))

  await start($)
  const calling = $.tool.call({ tool: 'Bash', command: 'blixel agent connect' })
  await stub.settle()
  await stub.clock.advance(10_000)
  await stub.settle()
  expect(stub.timeline).toEqual([])

  decide()
  await settled(stub, calling)
  await stub.settle()
  expect(stub.running()).toBe(1)
})

for (const verdict of ['declined', 'blocked'] as const) {
  test(`a ${verdict} model-run connect never connects`, async ($, on) => {
    const stub = stage(on)
    bash(on, stub, verdict)

    await start($)
    const ran = await settled(stub, $.tool.call({ tool: 'Bash', command: '/Applications/Blixel.app/Contents/Resources/bin/blixel agent connect' }))
    await stub.settle()
    await stub.clock.advance(60_000)
    await stub.settle()

    expect(stub.isConnected()).toBe(false)
    expect(stub.timeline).toEqual([])
    expect(stub.status()).toBeUndefined()
    expect(ran.deny ?? ran.isError).toBeTruthy()
  })
}

test('a model-run connect that failed is left as the model read it', async ($, on) => {
  const stub = stage(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: failure('not_in_meeting'), interrupted: false } }))

  await start($)
  const ran = await settled(stub, $.tool.call({ tool: 'Bash', command: 'blixel agent connect' }))
  await stub.settle()

  expect(stub.receivers).toEqual([])
  expect((ran.result as { stderr?: string }).stderr).toContain('not_in_meeting')
})

test('a model-run disconnect ends the receiver, and says nothing', async ($, on) => {
  const stub = stage(on)
  bash(on, stub)

  await start($)
  await settled(stub, $.tool.call({ tool: 'Bash', command: 'blixel agent connect' }))
  await stub.settle()
  expect(stub.running()).toBe(1)

  await settled(stub, $.tool.call({ tool: 'Bash', command: 'blixel agent disconnect' }))
  await stub.settle()
  await stub.clock.advance(120_000)
  await stub.settle()
  expect(stub.running()).toBe(0)
  expect(stub.receivers).toHaveLength(1)
  expect(stub.status()).toBeUndefined()
})

for (const command of [
  'grep "blixel agent" notes.md',
  'grep -rn "blixel agent connect" docs',
  "git commit -m 'blixel agent disconnect stops the receiver'",
]) {
  test(`\`${command}\` only names Blixel, and runs nothing for it`, async ($, on) => {
    const stub = stage(on)
    on('tool.call', () => ({ result: { stdout: connected(false), stderr: '', interrupted: false } }))

    await start($)
    await settled(stub, $.tool.call({ tool: 'Bash', command }))
    await stub.settle()

    expect(stub.receivers).toEqual([])
    expect(stub.runs).toEqual([])
  })
}

// Surfaces, the status line, reloads

test('a session started for -p receives nothing and leaves the commands to the skill', async ($, on) => {
  const stub = stage(on, { printed: [printed('Hello')], env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } })

  await start($, false)
  await stub.settle()

  expect(stub.receivers).toEqual([])
  expect(stub.submitted).toEqual([])
  expect((await run($, 'blixel:status')).text).toBe('the skill takes it')
})

test('a session the desktop app hosts receives its handoffs too', async ($, on) => {
  const stub = stage(on, { printed: [printed('Hello')], env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } })

  await connectSession($, stub, false)

  expect(stub.submitted).toEqual(['Hello'])
  expect((await run($, 'blixel:status')).text).toBe('This session is connected to the Blixel meeting; handoffs come straight here.')
})

const inRoom = (room: 'connected' | 'reconnecting' | 'idle', name: string | null = 'Design sync') =>
  (command: string) => (command === 'current' ? { exitCode: 0, stdout: current(room, name) } : undefined)

test('the status line names the meeting the session is connected to', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected') })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('the status line says while the app reconnects to the meeting', async ($, on) => {
  const stub = stage(on, { cli: inRoom('reconnecting') })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected to Design sync · reconnecting')
})

test('a meeting the app has no name for is only connected', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected', null) })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected')
})

test('a session Blixel was never invoked in runs nothing and shows nothing, in a meeting or not', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected') })

  await start($)
  await stub.settle()
  await complete($)
  await stub.clock.advance(60 * 60_000)
  await stub.settle()

  expect(stub.probes()).toBe(0)
  expect(stub.runs).toEqual([])
  expect(stub.receivers).toEqual([])
  expect(stub.statuses.filter(line => line !== undefined)).toEqual([])
})

test('/blixel:status reads once and leaves nothing running', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected') })

  await start($)
  const answer = await run($, 'blixel:status')
  await stub.settle()
  await stub.clock.advance(60 * 60_000)
  await stub.settle()

  expect(answer.text).toBe('No agent is connected to the Blixel meeting.')
  expect(stub.runs.map(one => one.argv[2])).toEqual(['status', 'current'])
  expect(stub.receivers).toEqual([])
  expect(stub.status()).toBeUndefined()
})

test('/blixel:status shows a connection this mod did not make, and does not receive for it', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected') })

  await start($)
  await stub.asModel('connect')
  const answer = await run($, 'blixel:status')
  await stub.settle()
  await stub.clock.advance(60_000)
  await stub.settle()

  expect(answer.text).toBe('This session is connected to the Blixel meeting, but not receiving its handoffs. Run /blixel:connect to receive them.')
  expect(stub.receivers).toEqual([])
  expect(stub.status()).toBe('✦ connected to Design sync · not receiving')
})

test('a reload while the mod received receives again with no command and no connect', async ($, on) => {
  seedPanel(on, { isConnected: true, receiver: 'mod', room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  const stub = stage(on, { cli: inRoom('connected') })
  // The connection outlived the reload; only its receiver ended.
  await stub.asModel('connect')
  stub.timeline.length = 0

  await start($)
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.timeline).not.toContain('connect')
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('a reload while connected also submits a handoff still waiting, with no turn to end first', async ($, on) => {
  seedPanel(on, {
    isConnected: true, receiver: 'mod', room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true,
    handoffs: [{ n: 1, text: 'Left over', sender: 'Ana', at: 0, state: 'waiting' }],
  })
  const stub = stage(on, {
    cli: inRoom('connected'),
    stored: { [`queue:${PID}:${STARTED}`]: { next: 2, pending: [{ n: 1, text: 'Left over' }] } },
  })
  await stub.asModel('connect')

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Left over'])
})

test('a reload after the connection ended leaves nothing running and says nothing', async ($, on) => {
  seedPanel(on, { isConnected: true, receiver: 'mod', room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  const stub = stage(on, { cli: inRoom('idle') })

  await start($)
  await stub.settle()
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(stub.running()).toBe(0)
  expect(stub.status()).toBeUndefined()
  expect(stub.toasts).toEqual([])
})

test('a reload of a session another receiver received for starts no receiver', async ($, on) => {
  seedPanel(on, { isConnected: true, receiver: 'other', room: 'Design sync', meeting: 'm-1', app: 'running', isInMeeting: true })
  const stub = stage(on, { cli: inRoom('connected') })
  await stub.asModel('connect')

  await start($)
  await stub.settle()

  expect(stub.receivers).toEqual([])
})

test('/clear keeps a connected session receiving', async ($, on) => {
  const stub = stage(on, { cli: inRoom('connected') })
  on('session.end', () => ({ sessionId: 'session-2' }))

  await connectSession($, stub)
  await $.session.end({ reason: 'clear' } as never)
  await stub.clock.advance(120_000)
  await stub.settle()

  expect(stub.running()).toBe(1)
  expect(stub.receivers).toHaveLength(1)
  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('an answer the app gave before a connect does not undo the connect when it arrives after it', async ($, on) => {
  let isSlow = false
  const stub = stage(on, {
    cli: command => {
      if (command === 'current') return { exitCode: 0, stdout: current('connected') }
      if (command !== 'status' || !isSlow) return undefined
      const before = { exitCode: 0, stdout: status({ connected: false }) }
      return stub.clock.sleep(10_000).then(() => before)
    },
  })

  await start($)
  isSlow = true
  const checking = run($, 'blixel:status')
  await stub.settle()
  isSlow = false
  await settled(stub, run($, 'blixel:connect'))
  await stub.settle()
  expect(stub.status()).toBe('✦ connected to Design sync')

  await stub.clock.advance(10_000)
  await checking
  await stub.settle()
  expect(stub.status()).toBe('✦ connected to Design sync')
  expect(stub.toasts).toEqual([])
})

test('the poll does not ask again while the app has not answered it', async ($, on) => {
  let isSlow = false
  const stub = stage(on, {
    cli: command => {
      if (command !== 'status' || !isSlow) return undefined
      const answer = { exitCode: 0, stdout: status({ connection_id: 'c-1', receiving: true }, { meeting_id: 'm-1' }) }
      return stub.clock.sleep(20_000).then(() => answer)
    },
  })
  const asked = () => stub.runs.filter(one => one.argv[2] === 'status').length

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
    cli: command => (command === 'current' ? { exitCode: 0, stdout: current('connected', 'Design sync', 'm-2') } : undefined),
  })

  await connectSession($, stub)

  expect(stub.status()).toBe('✦ connected')
})

test('the status line drops the meeting once the app closes', async ($, on) => {
  let isOpen = true
  const stub = stage(on, {
    cli: command =>
      isOpen ? inRoom('connected')(command) : { exitCode: 5, stderr: failure('app_unavailable', 'The app is not running') },
  })

  await connectSession($, stub)
  expect(stub.status()).toBe('✦ connected to Design sync')

  isOpen = false
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.status()).toBeUndefined()
})
