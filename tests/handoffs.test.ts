import { expect, test } from 'claude-code/testing'

import { complete, current, PID, printed, run, stage, start, STARTED, status } from './support'
import type { Ran } from './support'

test('a handoff the follower prints is submitted as a prompt of its own, worded as Blixel words it', async ($, on) => {
  const first = printed('Ana asks: could you add a test for the reconnect case?', 'Ana', 1)
  const stub = stage(on, {
    printed: [first.slice(0, 20), first.slice(20) + printed('And run it', 'Bea', 2)],
  })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Ana asks: could you add a test for the reconnect case?', 'And run it'])
  expect(stub.bare).toEqual([true, true])
})

test('a line the follower prints that is no handoff submits nothing', async ($, on) => {
  const stub = stage(on, { printed: ['Not an object\n', '{"id":3,"sender_name":"Ana"}\n', printed('Only this')] })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Only this'])
})

test('a dropped handoff is submitted again after the next turn, and not once it entered', async ($, on) => {
  let drops = 1
  const stub = stage(on, {
    printed: [printed('Rename the flag')],
    submit: () => (drops-- > 0 ? 'a Stop stands' : undefined),
  })

  await start($)
  await stub.settle()
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

  await start($)
  await stub.settle()
  // The interrupted turn ends; the user has sent nothing yet.
  await complete($)
  await stub.settle()
  expect(stub.status()).toBe('✦ 2 handoffs waiting for your next message')
  expect(stub.toasts).toEqual(['A Blixel handoff is waiting: it runs after your next message.'])

  // The turn of the user's next message ends.
  await complete($)
  await stub.settle()
  expect(stub.submitted.filter(text => text === 'Rename the flag')).toHaveLength(4)
  expect(stub.status()).toBe('✦ 1 handoff waiting')

  await stub.clock.advance(5_000)
  await stub.settle()
  expect(stub.submitted.filter(text => text === 'Run the tests')).toHaveLength(1)
  expect(stub.status()).toBeUndefined()
  expect(stub.toasts).toHaveLength(1)
})

test('a handoff this session had not yet submitted is submitted when the mod loads again', async ($, on) => {
  // A reload keeps only $.store: these entries stand for what the previous
  // load of the module saved, for this `claude` and for an older process that
  // had the same pid.
  const stub = stage(on, {
    stored: {
      [`queue:${PID}:${STARTED}`]: { next: 2, pending: [{ n: 1, text: 'Left over' }] },
      [`queue:${PID}:Thu Oct 23 09:00:00 2026`]: { next: 2, pending: [{ n: 1, text: 'Not ours' }] },
    },
  })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Left over'])
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

  await start($)
  await stub.settle()

  expect(stub.follows).toEqual([['agent', 'follow', '--json', '--acks']])
  expect(stub.acks()).toEqual([['7', 'queued']])
  expect(savedAtAck).toEqual({ next: 2, pending: [{ n: 1, text: 'Rename the flag' }] })
})

test('a handoff keeps its line breaks, and one with only its prompt still arrives', async ($, on) => {
  const line = JSON.stringify({ id: 1, prompt: 'First Second', message: 'First\nSecond', sender_name: 'Ana' })
  const stub = stage(on, { printed: [`${line}\n`, printed('No message beside it', 'Ana', 2)] })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['First\nSecond', 'No message beside it'])
})

const oldCLI = (args: readonly string[]) =>
  args.includes('--acks')
    ? '{"error":{"category":"usage","code":"usage","exit_status":2,"message":"Unknown option \'--acks\'"},"schema_version":1}'
    : undefined

test('a CLI without --acks follows as before, and nothing is acked', async ($, on) => {
  const stub = stage(on, { followerFails: oldCLI, printed: [printed('Rename the flag')] })

  await start($)
  await stub.settle()
  await stub.clock.advance(1_000)
  await stub.settle()

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

  await start($)
  await stub.settle()
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

    await start($)
    await stub.settle()
    await stub.clock.advance(60_000)
    await stub.settle()

    expect(stub.submitted).toEqual(['Rename the flag'])
    expect(stub.acks()).toEqual([['7', 'queued']])
    expect(stub.toasts).toEqual([])
  })
}

test('a handoff printed without an id runs, with nothing to ack', async ($, on) => {
  const stub = stage(on, { printed: ['{"prompt":"Rename the flag"}\n'] })

  await start($)
  await stub.settle()

  expect(stub.submitted).toEqual(['Rename the flag'])
  expect(stub.acks()).toEqual([])
})

const refusedSave = (ack: Ran) => ({
  printed: [printed('Rename the flag', 'Ana', 7) + printed('And run it', 'Bea', 8)],
  saveFails: true,
  cli: (command: string): Ran =>
    command === 'ack' ? ack : { exitCode: 0, stdout: command === 'status' ? status({}) : current() },
})

test('handoffs that cannot be saved are acked as failed and never run', async ($, on) => {
  const answer = JSON.stringify({ data: { outcome: 'recorded', handoff_id: 7 } })
  const stub = stage(on, refusedSave({ exitCode: 0, stdout: answer }))

  await start($)
  await stub.settle()

  expect(stub.acks().map(ack => ack.slice(0, 3))).toEqual([['7', 'failed', '--reason'], ['8', 'failed', '--reason']])
  expect(stub.submitted).toEqual([])
  expect(stub.status()).toBe(undefined)
})

test('a handoff that cannot be saved still runs when the app did not take its failed ack', async ($, on) => {
  const stub = stage(on, refusedSave({ exitCode: 5, stderr: '{"error":{"code":"incompatible_protocol","message":"No"}}\n' }))

  await start($)
  await stub.settle()
  await stub.clock.advance(60_000)
  await stub.settle()

  expect(stub.acks().map(ack => ack[0])).toEqual(['7', '8'])
  expect(stub.submitted).toEqual(['Rename the flag', 'And run it'])
})

test('the status line counts the handoffs waiting for the session', async ($, on) => {
  const stub = stage(on, { printed: [printed('One', 'Ana', 1) + printed('Two', 'Ana', 2)], submit: () => 'busy' })

  await start($)
  await stub.settle()

  expect(stub.status()).toBe('✦ 2 handoffs waiting')
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
  await stub.settle()
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

  await start($)
  await stub.settle()
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

  await start($)
  await stub.settle()
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

  await start($, false)
  await stub.settle()

  expect(stub.submitted).toEqual(['Hello'])
  expect((await run($, 'blixel:status')).text).toBe('No agent is connected to the Blixel meeting.')
})

const connectedIn = (room: 'connected' | 'reconnecting' | 'idle', name: string | null = 'Design sync') =>
  (command: string) =>
    command === 'current'
      ? { exitCode: 0, stdout: current(room, name) }
      : { exitCode: 0, stdout: status({ connection_id: 'c-1', follower_attached: true }, { meeting_id: 'm-1' }) }

test('the status line names the meeting the session is connected to', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected') })

  await start($)
  await stub.settle()

  expect(stub.status()).toBe('✦ connected to Design sync')
})

test('the status line says while the app reconnects to the meeting', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('reconnecting') })

  await start($)
  await stub.settle()

  expect(stub.status()).toBe('✦ connected to Design sync · reconnecting')
})

test('a meeting the app has no name for is only connected', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected', null) })

  await start($)
  await stub.settle()

  expect(stub.status()).toBe('✦ connected')
})

test('a session in a meeting it is not connected to points to /blixel:connect, from when the app joins', async ($, on) => {
  let room: 'idle' | 'connected' = 'idle'
  const stub = stage(on, {
    cli: command =>
      command === 'current'
        ? { exitCode: 0, stdout: current(room) }
        : { exitCode: 0, stdout: status({ follower_attached: true }) },
  })

  await start($)
  await stub.settle()
  expect(stub.status()).toBeUndefined()

  room = 'connected'
  await stub.clock.advance(15_000)
  await stub.settle()

  expect(stub.status()).toBe('✦ in Design sync · /blixel:connect')
  expect(stub.toasts).toEqual([])
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

  await start($)
  await stub.settle()
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
  const stub = stage(on, {
    cli: command => {
      const answer = command === 'current' ? { exitCode: 0, stdout: current() } : { exitCode: 0, stdout: status({}) }
      return stub.clock.sleep(20_000).then(() => answer)
    },
  })
  const asked = () => stub.runs.filter(run => run.argv[2] === 'status').length

  await start($)
  await stub.clock.advance(20_000)
  await stub.settle()
  expect(asked()).toBe(1)

  // The tick at 15 s found the first answer still out; the one at 30 s asks,
  // and its answer is still out at 45 s.
  await stub.clock.advance(25_000)
  await stub.settle()
  expect(asked()).toBe(2)

  await stub.clock.advance(15_000)
  await stub.settle()
  expect(asked()).toBe(3)
})

test('the status line names a room only once the app counts it as the meeting its agents are in', async ($, on) => {
  const stub = stage(on, {
    cli: command =>
      command === 'current'
        ? { exitCode: 0, stdout: current('connected', 'Design sync', 'm-2') }
        : { exitCode: 0, stdout: status({ follower_attached: true }, null, null as never) },
  })

  await start($)
  await stub.settle()

  expect(stub.status()).toBeUndefined()
})

test('the status line names the meeting beside a monitor that holds the handoffs', async ($, on) => {
  const stub = stage(on, { cli: connectedIn('connected'), follower: 'refused', isLive: true })

  await start($)
  await stub.settle()

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

  await start($)
  await stub.settle()
  expect(stub.status()).toBe('✦ connected to Design sync')

  isOpen = false
  await stub.clock.advance(15_000)
  await stub.settle()
  expect(stub.status()).toBeUndefined()
})
