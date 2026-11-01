import { expect, test } from 'claude-code/testing'

import { complete, connectSession, current, PID, printed, run, seedPanel, stage, start, STARTED, status } from './support'

const SURFACES = ['terminal', 'desktop'] as const
const LONG = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')

const pane = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'blixel',
    surface,
    component: 'Pane',
    requestId: 'blixel',
    viewport: { columns: 100, rows: 40 },
    props: {
      title: 'Blixel',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const connectedCli = () => {
  let isConnected = true
  return {
    calls: [] as string[],
    meeting: 'm-1',
    room: 'Design sync',
    answer(command: string) {
      this.calls.push(command)
      if (command === 'current') return { exitCode: 0, stdout: current('connected', this.room, this.meeting) }
      if (command === 'disconnect') isConnected = false
      if (command === 'connect') isConnected = true
      if (command === 'disconnect' || command === 'connect') {
        return { exitCode: 0, stdout: JSON.stringify({ data: { outcome: isConnected ? 'connected' : 'disconnected' } }) }
      }
      return {
        exitCode: 0,
        stdout: isConnected
          ? status(
              { connection_id: 'c-1', follower_attached: true },
              { meeting_id: this.meeting, approval_mode: 'ask' },
              this.meeting,
            )
          : status({ follower_attached: true }, null, this.meeting),
      }
    },
  }
}

test('/blixel:status opens the Blixel pane', async ($, on) => {
  const stub = stage(on)

  await connectSession($, stub)
  await run($, 'blixel:status')

  expect(stub.panes).toEqual(['blixel'])
})

test('/blixel:connect opens the pane in the desktop app', async ($, on) => {
  const cli = connectedCli()
  const desktop = stage(on, { cli: command => cli.answer(command), surfaces: ['desktop'] })

  await start($)
  await run($, 'blixel:connect')

  expect(desktop.panes).toEqual(['blixel'])
})

test('/blixel:connect leaves the terminal as it is', async ($, on) => {
  const cli = connectedCli()
  const terminal = stage(on, { cli: command => cli.answer(command), surfaces: ['terminal'] })

  await connectSession($, terminal)
  await run($, 'blixel:connect')

  expect(terminal.panes).toEqual([])
})

test('the pane shows the connection and ends it, on every surface', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })

  await connectSession($, stub)

  for (const surface of SURFACES) {
    await run($, 'blixel:connect')
    await stub.settle()
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Connected to Design sync/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /asks you before each handoff/ })).toBeDefined()
    expect((await ui.find({ key: 'connection' }))?.props.label).toBe('Disconnect')

    await ui.press({ key: 'connection' })
    await stub.settle()
    expect(cli.calls).toContain('disconnect')
    expect(await ui.find({ type: 'Text', text: /In Design sync/ })).toBeDefined()
    expect((await ui.find({ key: 'connection' }))?.props.label).toBe('Connect')
    await ui.unmount()
  }
})

test("the pane says when Blixel isn't running, and can still try to connect", async ($, on) => {
  const stub = stage(on, {
    cli: () => ({ exitCode: 1, stderr: '{"error":{"code":"app_unavailable","message":"The app is not running"}}\n' }),
  })

  await start($)
  await run($, 'blixel:status')
  await stub.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Blixel isn't running/ })).toBeDefined()
    expect((await ui.find({ key: 'connection' }))?.props.label).toBe('Connect')
    await ui.unmount()
  }
})

for (const surface of SURFACES) {
  test(`the ${surface} pane connects a session nothing has run in`, async ($, on) => {
    const cli = connectedCli()
    cli.answer('disconnect')
    const stub = stage(on, { cli: command => cli.answer(command), isLive: true })

    await start($)
    await stub.settle()
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Not connected/ })).toBeDefined()
    await ui.press({ key: 'connection' })
    await stub.settle()

    expect(await ui.find({ type: 'Text', text: /Connected to Design sync/ })).toBeDefined()
    expect(stub.running()).toBe(1)
    await ui.unmount()
  })
}

test('the pane lists each handoff with what became of it', async ($, on) => {
  const answers = ['the prompt was removed from the queue before it ran']
  const stub = stage(on, { printed: [printed('Rename the flag')], submit: () => answers.shift() })

  await connectSession($, stub)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Rename the flag/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting for your next message/ })).toBeDefined()
    await ui.unmount()
  }

  await complete($)
  await stub.settle()

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Waiting for your next message/ })).toBeUndefined()
    await ui.unmount()
  }
  const desktop = await $.ui.mount(pane('desktop'))
  expect(await desktop.find({ type: 'Text', text: /Sent to Claude/ })).toBeDefined()
  await desktop.unmount()
})

test('a long handoff in the pane shows its opening until it is opened', async ($, on) => {
  const stub = stage(on, { printed: [printed(LONG)] })

  await connectSession($, stub)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /word79/ })).toBeUndefined()

    await ui.press({ key: 'more-1' })
    expect(await ui.find({ type: 'Text', text: /word79/ })).toBeDefined()

    await ui.press({ key: 'more-1' })
    expect(await ui.find({ type: 'Text', text: /word79/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('each handoff in the pane names who sent it, on every surface', async ($, on) => {
  const stub = stage(on, { printed: [printed('Rename the flag', 'Ana', 1), printed('Run the tests', 'Bea', 2)] })

  await connectSession($, stub)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Ana · \d{1,2}:\d{2}/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bea · \d{1,2}:\d{2}/ })).toBeDefined()
    await ui.unmount()
  }
})

test("the pane lists one meeting's handoffs: a connection to another starts it empty", async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command), printed: [printed('Rename the flag')] })
  const listed = async () => {
    const ui = await $.ui.mount(pane('terminal'))
    const found = (await ui.find({ type: 'Text', text: /Rename the flag/ })) !== undefined
    await ui.unmount()
    return found
  }

  await connectSession($, stub)
  expect(await listed()).toBe(true)

  await run($, 'blixel:disconnect')
  await stub.settle()
  expect(await listed()).toBe(true)

  await run($, 'blixel:connect')
  await stub.settle()
  expect(await listed()).toBe(true)

  cli.meeting = 'm-2'
  cli.room = 'Standup'
  await run($, 'blixel:connect')
  await stub.settle()
  expect(await listed()).toBe(false)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Connected to Standup/ })).toBeDefined()
  await ui.unmount()
})

test('a handoff from the new meeting that arrives before the connect is answered stays listed', async ($, on) => {
  const cli = connectedCli()
  let isSlow = false
  const stub = stage(on, {
    isLive: true,
    printed: [printed('Rename the flag')],
    cli: command => {
      const answer = cli.answer(command)
      return isSlow && command === 'status' ? stub.clock.sleep(1_000).then(() => answer) : answer
    },
  })
  const listed = async (text: RegExp) => {
    const ui = await $.ui.mount(pane('terminal'))
    const found = (await ui.find({ type: 'Text', text })) !== undefined
    await ui.unmount()
    return found
  }

  await connectSession($, stub)
  await run($, 'blixel:disconnect')
  await stub.settle()

  cli.meeting = 'm-2'
  isSlow = true
  const connecting = run($, 'blixel:connect')
  await stub.settle()
  stub.print(printed('Run the tests', 'Bea', 2))
  await stub.settle()
  await stub.clock.advance(1_000)
  await connecting
  await stub.settle()

  expect(await listed(/Run the tests/)).toBe(true)
  expect(await listed(/Rename the flag/)).toBe(false)
})

test('a handoff from the meeting the session left is not listed once it connects to another, with no poll between', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { isLive: true, cli: command => cli.answer(command) })
  const listed = async () => {
    const ui = await $.ui.mount(pane('terminal'))
    const found = (await ui.find({ type: 'Text', text: /Rename the flag/ })) !== undefined
    await ui.unmount()
    return found
  }

  await connectSession($, stub)
  stub.print(printed('Rename the flag'))
  await stub.settle()
  expect(await listed()).toBe(true)

  cli.meeting = 'm-2'
  await run($, 'blixel:connect')
  await stub.settle()
  expect(await listed()).toBe(false)
})

test("a handoff from the meeting the session left is not listed once the skill's Bash call connects it to another", async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { isLive: true, cli: command => cli.answer(command) })
  on('tool.call', () => {
    cli.answer('connect')
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await connectSession($, stub)
  stub.print(printed('Rename the flag'))
  await stub.settle()

  cli.meeting = 'm-2'
  await $.tool.call({ tool: 'Bash', command: 'blixel agent connect' })
  await stub.settle()
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Rename the flag/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Connected to Design sync/ })).toBeDefined()
  await ui.unmount()
})

test('a handoff whose sender has no name leads with its time, on every surface', async ($, on) => {
  const stub = stage(on, { printed: [printed('Rename the flag', '')] })

  await connectSession($, stub)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Rename the flag/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^● \d{1,2}:\d{2}/ })).toBeDefined()
    await ui.unmount()
  }
})

test('after /clear empties $.state the pane shows the connection again within a second', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { isLive: true, cli: command => cli.answer(command) })
  // What the engine does to $.state on a /clear; a test cannot write it itself.
  let isCleared = false
  on('session.end', () => {
    isCleared = true
    return { sessionId: 'session-2' }
  })
  on('state.get', ($, e, next) => (isCleared && e.key === 'panel' ? { value: { version: 0 } } : next(e)))
  on('state.set', ($, e, next) => {
    if (e.key === 'panel') isCleared = false
    return next(e)
  })

  await connectSession($, stub)
  await $.session.end({ reason: 'clear' } as never)
  await stub.clock.advance(1_000)
  await stub.settle()

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Connected to Design sync/ })).toBeDefined()
  await ui.unmount()
})

test('a reload keeps the listed handoffs while the session stays in their meeting', async ($, on) => {
  const listed = { n: 1, text: 'Rename the flag', sender: 'Ana', at: 0, state: 'delivered' }
  seedPanel(on, {
    app: 'running', isInMeeting: true, isConnected: true, room: 'Design sync', meeting: 'm-1', approval: 'ask',
    handoffs: [listed],
  })
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command), stored: { [`queue:${PID}:${STARTED}`]: { next: 2, pending: [] } } })

  await start($)
  await stub.settle()

  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Rename the flag/ })).toBeDefined()
  await ui.unmount()
})

const typed = ($: Parameters<typeof start>[0], text: string, kind = 'composer') =>
  $.prompt.submit({ text, origin: { kind } } as never)

test('typed phrases connect, check and disconnect with no turn', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })
  await start($)

  expect(await typed($, 'Connect Blixel')).toEqual({ drop: expect.stringContaining('Connected to the Blixel') })
  await stub.settle()
  expect(await typed($, 'blixel status')).toEqual({ drop: expect.stringContaining('connected to the Blixel') })
  expect(await typed($, 'blixel:disconnect')).toEqual({ drop: expect.stringContaining('Disconnected from the') })

  expect(stub.panes).toEqual(['blixel'])
  expect(cli.calls).toContain('disconnect')
  expect(stub.submitted).toEqual([])
})

test('a typed phrase leaves the prompt box empty', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })
  const filled: string[] = []
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await start($)

  await typed($, 'connect blixel')
  await stub.settle()

  await stub.clock.advance(100)
  await stub.settle()
  expect(filled).toEqual([''])
})

test('a typed connect takes ask or direct', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })
  await start($)

  await typed($, 'blixel connect direct')
  await stub.settle()

  const connects = stub.runs.filter(one => one.argv.includes('connect'))
  expect(connects.map(one => one.argv.slice(-2))).toContainEqual(['--approval', 'direct'])
  expect(stub.submitted).toEqual([])
})

test('a phrase inside a longer prompt reaches the model', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })
  await start($)

  for (const text of ['connect blixel please', 'please connect blixel', 'disconnect blixel ask', 'blixel status direct']) {
    await typed($, text)
  }

  expect(stub.submitted).toHaveLength(4)
  expect(cli.calls).not.toContain('connect')
})

test('a handoff saying a phrase runs nothing', async ($, on) => {
  const cli = connectedCli()
  const stub = stage(on, { cli: command => cli.answer(command) })
  await connectSession($, stub)

  await typed($, 'disconnect blixel', 'plugin')

  expect(stub.submitted).toEqual(['disconnect blixel'])
  expect(cli.calls).not.toContain('disconnect')
})
