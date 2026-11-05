import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'

import { Blixel, children, pause, ROOT, until } from './agents/blixel.ts'
import type { Receiver } from './agents/blixel.ts'
import { OpenCode, Tui } from './agents/opencode.ts'

const { default: server } = await import('../opencode/server.ts')
const { default: tui } = await import('../opencode/tui.ts')

const SUBMIT = path.join(ROOT, 'opencode', 'submit.sh')
const TEXT = '  First line.\nSecond line, after a break.\n\n  -dash "quoted" $HOME `tick` é✦\n'

let blixel: Blixel
let opencode: OpenCode
let sessions = 0
// Receivers outlive a load of the plugin, so each test disconnects the sessions it made.
let made: string[] = []

const session = () => {
  sessions += 1
  made.push(`ses_${sessions}`)
  return `ses_${sessions}`
}

beforeEach(async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  blixel = await Blixel.start('OPENCODE_SESSION_ID')
  opencode = await new OpenCode().load(server)
})

afterEach(async () => {
  for (const id of made) {
    blixel.connection = id
    await opencode.command(id, 'blixel:disconnect')
  }
  made = []
  await blixel.close()
  mock.timers.reset()
})

const SOCKET = 'BLIXEL_OPENCODE_SOCKET'
const socket = (live: Receiver) => live.call.env[SOCKET]

const connect = async (id: string) => {
  await opencode.command(id, 'blixel:connect')
  return blixel.receivers.get(id)!
}



test('it adds the three commands, and none takes ask or direct', () => {
  assert.deepEqual([...opencode.commands.keys()].sort(), ['blixel:connect', 'blixel:disconnect', 'blixel:status'])
  for (const command of opencode.commands.values()) assert.doesNotMatch(command.description, /ask|direct/)
})

test("it adds the skills, blixel's and connect-agent's, and leaves a skill OpenCode already has", async () => {
  const fresh = new OpenCode()
  const own = { name: 'blixel', description: 'Mine', content: 'Mine', path: '/mine' }
  fresh.skills.set('blixel', own)
  await fresh.load(server)

  assert.equal(fresh.skills.get('blixel'), own)
  const skill = fresh.skills.get('connect-agent')!
  const file = path.join(ROOT, 'skills', 'connect-agent', 'SKILL.md')
  assert.equal(skill.path, file)
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.endsWith(`---\n${skill.content}`))
  assert.ok(skill.description && text.includes(`\ndescription: ${skill.description}\n`))
  assert.equal(opencode.skills.get('blixel')!.path, path.join(ROOT, 'skills', 'blixel', 'SKILL.md'))
})

test('the package gives OpenCode the server and terminal plugins', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.exports, { './server': './opencode/server.ts', './tui': './opencode/tui.ts' })
})

test('it reaches OpenCode only through skills, commands, tools and sessions', async () => {
  const touched = new Set<string>()
  const fresh = new OpenCode()
  const ctx = new Proxy(fresh.ctx, { get: (target, key: string) => (touched.add(key), (target as any)[key]) })
  await server.setup(ctx)
  await fresh.command(session(), 'blixel:status')

  assert.deepEqual([...touched].sort(), ['command', 'session', 'skill', 'tool'])
})

test('nothing runs until a connect', async () => {
  const id = session()
  await opencode.shell(id, 'ls', () => 'README.md')

  assert.deepEqual(blixel.calls, [])
})

test('/blixel:connect with words after it answers its usage and runs nothing', async () => {
  const id = session()
  await opencode.command(id, 'blixel:connect', 'direct')

  assert.equal(opencode.said(id), 'Usage: /blixel:connect')
  assert.deepEqual(blixel.calls, [])
})

test('/blixel:status asks the app as this session, from the server, and shows it with no turn', async () => {
  const id = session()
  await opencode.command(id, 'blixel:status')

  const text = 'This session is not connected to the Blixel meeting. Type /blixel:connect to connect it.'
  assert.deepEqual(opencode.notices, [{ sessionID: id, text, description: text, resume: false }])
  const [call] = blixel.calls
  assert.deepEqual(call.args, ['agent', 'status'])
  assert.equal(call.session, id)
  assert.equal(call.ppid, process.pid)
})

test("/blixel:connect connects, then receives with the plugin's submit program, with no model", async () => {
  const id = session()
  await connect(id)

  assert.equal(opencode.said(id), 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  assert.ok(opencode.notices.every((notice) => notice.resume === false))
  assert.deepEqual(blixel.calls.map((call) => call.args), [['agent', 'connect'], ['agent', 'receive', '--deliver-with', SUBMIT]])
  for (const call of blixel.calls) {
    assert.equal(call.session, id)
    assert.equal(call.ppid, process.pid)
  }
  assert.deepEqual(opencode.prompts, [])

  await opencode.command(id, 'blixel:status')
  assert.equal(opencode.said(id), 'Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.')
})

test('a connect whose receiver has not attached yet says so', async () => {
  const id = session()
  blixel.unattached.add(id)
  const connecting = opencode.command(id, 'blixel:connect')
  await until(() => blixel.ran('receive').length > 0, 'a receive')
  mock.timers.tick(5_000)
  await connecting

  assert.equal(opencode.said(id), 'Connected to the Blixel meeting, but not receiving its handoffs yet. Type /blixel:status to check.')
})

test("a handoff is the session's prompt, exactly, with nothing added", async () => {
  const id = session()
  const live = await connect(id)

  assert.equal(await live.deliver(TEXT), 0)
  assert.deepEqual(opencode.prompts, [{ sessionID: id, text: TEXT }])
})

test('a handoff that says a phrase or a command is only a prompt', async () => {
  const id = session()
  const live = await connect(id)
  const before = blixel.calls.length

  for (const text of ['disconnect blixel', '/blixel:disconnect', 'BLIXEL STATUS']) assert.equal(await live.deliver(text), 0)

  assert.deepEqual(opencode.prompts.map((prompt) => prompt.text), ['disconnect blixel', '/blixel:disconnect', 'BLIXEL STATUS'])
  assert.equal(blixel.calls.length, before)
  assert.equal(blixel.receivers.get(id), live)
})

test('in the desktop app, a typed phrase acts at once, and the model reads its answer after it', async () => {
  const id = session()
  const told = (typed: string, answer: string) => {
    const { text } = opencode.prompts.at(-1)!
    assert.ok(text.startsWith(`${typed}\n\n`))
    assert.ok(text.includes(`answered: ${answer} Tell the user`))
  }

  await opencode.typed(id, 'Connect Blixel')
  told('Connect Blixel', 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  const live = blixel.receivers.get(id)!

  await opencode.typed(id, 'blixel status')
  told('blixel status', 'Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.')

  await opencode.typed(id, 'disconnect blixel')
  told('disconnect blixel', 'Disconnected from the Blixel meeting. Handoffs stop arriving.')
  await blixel.staysStopped(live, SOCKET)
})

test('in the desktop app, words beside a phrase reach the model as typed', async () => {
  const id = session()
  const typed = ['connect blixel please', 'connect blixel ask', 'please blixel status', 'blixel connect direct']

  for (const words of typed) await opencode.typed(id, words)

  assert.deepEqual(opencode.prompts.map((prompt) => prompt.text), typed)
  assert.deepEqual(blixel.calls, [])
})

test('OpenCode taking a moment over a prompt is no doubt that it took it', async () => {
  const id = session()
  const live = await connect(id)
  opencode.promptAnswer = () => pause(500)

  assert.equal(await live.deliver('taken slowly'), 0)
})

test('a prompt OpenCode refuses is a failed delivery', async () => {
  const id = session()
  const live = await connect(id)
  opencode.promptAnswer = async () => {
    throw new Error('Session is busy')
  }

  assert.equal(await live.deliver('Rename the flag'), 69)
})

test("connecting another session on the same server replaces this one's, and each handoff reaches its own", async () => {
  const one = session()
  const two = session()
  const first = await connect(one)
  await connect(two)

  assert.match(opencode.said(two)!, /Another session was connected and no longer receives them\.$/)
  await blixel.staysStopped(first, SOCKET)
  assert.equal(await blixel.receivers.get(two)!.deliver('for the second'), 0)
  assert.deepEqual(opencode.prompts, [{ sessionID: two, text: 'for the second' }])
})

test('a receiver that stops with no word receives again, with no connect', async () => {
  const id = session()
  ;(await connect(id)).kill()
  await blixel.receivesAgain(1)
  await until(() => blixel.receivers.get(id)?.attached === true, 'a receiver')

  assert.equal(await blixel.receivers.get(id)!.deliver('after a restart'), 0)
  assert.deepEqual(blixel.calls.map((call) => call.verb), ['connect', 'receive', 'receive'])

  blixel.receivers.get(id)!.fail('cancelled', 143)
  await blixel.receivesAgain(2)
  assert.equal(blixel.ran('connect').length, 1)
})

test('a receiver that fails with a word stays stopped, and the session shows why with no turn', async () => {
  const id = session()
  const live = await connect(id)
  live.fail('app_unavailable', 5)
  await blixel.staysStopped(live, SOCKET)

  const text = 'Blixel stopped receiving handoffs: It stopped Try again.'
  assert.deepEqual(opencode.notices.at(-1), { sessionID: id, text, description: text, resume: false })
  await opencode.command(id, 'blixel:status')
  assert.equal(opencode.said(id), 'Connected to the Blixel meeting, but not receiving its handoffs. Type /blixel:connect to receive them.')
  await connect(id)
  assert.ok(blixel.receivers.get(id))
})

test('a receiver whose connection ended stays stopped', async () => {
  const id = session()
  const live = await connect(id)
  live.end('meeting_ended')

  await blixel.staysStopped(live, SOCKET)
})

test('a receiver the app refuses as not connected stays stopped, and says nothing', async () => {
  const id = session()
  const live = await connect(id)
  const notices = opencode.notices.length
  blixel.connection = undefined
  live.kill()
  await blixel.receivesAgain(1)

  await blixel.staysStopped(live, SOCKET)
  assert.equal(opencode.notices.length, notices)
})

test('beside another receiver of the session, it leaves the handoffs to that one', async () => {
  const id = session()
  const live = await connect(id)
  blixel.elsewhere.add(id)
  live.kill()
  await blixel.receivesAgain(1)
  await blixel.staysStopped(live, SOCKET)

  await opencode.command(id, 'blixel:connect')
  assert.equal(opencode.said(id), 'Connected to the Blixel meeting. Another receiver in this session takes its handoffs.')
})

test('disconnect stops receiving and removes the socket, and a connect at once receives again', async () => {
  const id = session()
  const live = await connect(id)
  await opencode.command(id, 'blixel:disconnect')

  assert.equal(opencode.said(id), 'Disconnected from the Blixel meeting. Handoffs stop arriving.')
  await blixel.staysStopped(live, SOCKET)

  await connect(id)
  await opencode.command(id, 'blixel:disconnect')
  await connect(id)
  assert.equal(opencode.said(id), 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  assert.ok(blixel.receivers.get(id))
})

test('a disconnect the app answers not connected still stops the receiver', async () => {
  const id = session()
  const live = await connect(id)
  blixel.connection = undefined
  await opencode.command(id, 'blixel:disconnect')

  assert.equal(opencode.said(id), 'This session was not connected to the Blixel meeting.')
  await blixel.staysStopped(live, SOCKET)
})

test('a disconnect of a session that was not connected says so', async () => {
  const id = session()
  await opencode.command(id, 'blixel:disconnect')

  assert.equal(opencode.said(id), 'This session was not connected to the Blixel meeting.')
})

test('a connect that fails says why and receives nothing', async () => {
  const id = session()
  blixel.connectFails = '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting","hint":"Join a room first."}}\n'
  await opencode.command(id, 'blixel:connect')

  assert.equal(opencode.said(id), 'Blixel did not connect: Blixel is not in a meeting Join a room first.')
  assert.deepEqual(blixel.ran('receive'), [])
})

test('the server ending stops its receivers and removes their sockets', async () => {
  const before = new Set(process.listeners('exit'))
  const live = await connect(session())
  // The server's own exit cannot happen inside the test, so its exit listeners run as it would.
  for (const listener of process.listeners('exit').filter((added) => !before.has(added))) listener(0)

  await live.call.gone
  assert.equal(live.call.signal, 'SIGTERM')
  assert.equal(fs.existsSync(socket(live)), false)
})

test('OpenCode loading the plugin anew, as it does after an idle hour, keeps receiving', async () => {
  const id = session()
  const live = await connect(id)
  // A new module instance, as OpenCode evaluates the file again.
  const { default: again } = await import('../opencode/server.ts?again')
  opencode = await new OpenCode().load(again)

  assert.equal(blixel.receivers.get(id), live)
  assert.equal(await live.deliver('after a quiet hour'), 0)
  assert.deepEqual(blixel.ran('disconnect'), [])
  await opencode.command(id, 'blixel:connect')
  assert.equal(opencode.said(id), 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  assert.equal(blixel.ran('receive').length, 1)
  await opencode.command(id, 'blixel:disconnect')
  await blixel.staysStopped(live, SOCKET)
})

test("a command that only mentions connect runs nothing, even one printing a connect's answer", async () => {
  const id = session()
  await opencode.shell(id, 'grep "blixel agent connect" connects.log', () => blixel.connect(id))

  assert.deepEqual(blixel.calls, [])
})

test('a connect the permission denied never ran, and is left alone', async () => {
  opencode.permission = 'deny'

  await assert.rejects(opencode.shell(session(), 'blixel agent connect', () => blixel.connect('x')), /Permission denied/)
  assert.deepEqual(opencode.ran, [])
  assert.deepEqual(blixel.calls, [])
  assert.equal(blixel.connection, undefined)
})

test('a connect waiting for permission runs nothing, and one the person declined is left alone', async () => {
  const id = session()
  opencode.permission = 'ask'
  const running = opencode.shell(id, 'blixel agent connect', () => blixel.connect(id))
  await until(() => opencode.asking, 'a permission asked')
  assert.deepEqual(children(), [])
  assert.deepEqual(blixel.calls, [])

  opencode.reply(false)
  await assert.rejects(running, /declined/)
  assert.deepEqual(blixel.calls, [])
  assert.equal(blixel.connection, undefined)
})

test('a connect the person allowed is taken over once it ran', async () => {
  const id = session()
  opencode.permission = 'ask'
  const running = opencode.shell(id, 'blixel agent connect', () => blixel.connect(id))
  await until(() => opencode.asking, 'a permission asked')
  opencode.reply(true)

  assert.equal(JSON.parse(await running).data.receiving, true)
})

test('a connect that failed, or ran in the background, is left alone', async () => {
  const id = session()
  await opencode.shell(id, 'blixel agent connect', () => '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting"}}\n')
  await opencode.shell(id, 'blixel agent connect', () => blixel.connect(id), { background: true })

  assert.deepEqual(blixel.calls, [])
})

test('a connect for another session is left alone, and the model reads its own answer', async () => {
  let answer = ''
  const read = await opencode.shell(session(), 'env -u OPENCODE_SESSION_ID OTHER=o-1 blixel agent connect --session-env OTHER', () =>
    (answer = blixel.connect('o-1')))

  assert.equal(read, answer)
  assert.deepEqual(blixel.calls.map((call) => call.verb), ['status'])
})

test("the model's connect of this session is taken over: it receives, and the model reads that", async () => {
  const id = session()
  const read = await opencode.shell(id, '"/Applications/Blixel.app/Contents/Resources/bin/blixel" agent connect', () => blixel.connect(id))

  assert.deepEqual(blixel.calls.map((call) => [call.args, call.session]), [
    [['agent', 'status'], id],
    [['agent', 'receive', '--deliver-with', SUBMIT], id],
    [['agent', 'connect'], id],
  ])
  assert.equal(JSON.parse(read).data.receiving, true)
  assert.equal(await blixel.receivers.get(id)!.deliver('after the model connected'), 0)

  await opencode.shell(id, 'blixel agent connect', () => blixel.connect(id))
  assert.equal(blixel.ran('receive').length, 1)
})

test("the model's disconnect ends the receiver, which stays stopped", async () => {
  const id = session()
  const live = await connect(id)
  await opencode.shell(id, 'blixel agent disconnect', () => blixel.disconnect(id))

  await blixel.staysStopped(live, SOCKET)
})

test("the plugin's submit program, with nothing listening, answers doubt", async () => {
  const status = await new Promise<number | null>((resolve) =>
    execFile(SUBMIT, ['text'], { env: { BLIXEL_OPENCODE_SOCKET: '/tmp/blixel-test-nobody' } }, (error) =>
      resolve(error ? (error.code as number) : 0)),
  )

  assert.equal(status, 1)
})

test('the CLI never comes from PATH', async () => {
  const id = session()
  await connect(id)
  await opencode.command(id, 'blixel:status')

  assert.equal(blixel.plantedRan, false)
  assert.equal(blixel.calls.length, 3)
})

test('in the terminal, a phrase becomes its command before Enter submits it, whole and in any case', async () => {
  const terminal = await new Tui().load(tui)

  assert.equal(terminal.enter('Blixel Status'), '/blixel:status')
  assert.equal(terminal.enter('BLIXEL:CONNECT'), '/blixel:connect')
  assert.equal(terminal.enter(' disconnect blixel '), '/blixel:disconnect')
  assert.equal(terminal.enter('status blixel'), '/blixel:status')
})

test('in the terminal, words beside a phrase are submitted as typed', async () => {
  const terminal = await new Tui().load(tui)

  for (const words of ['connect blixel please', 'connect blixel ask', 'please blixel status', 'blixel connect direct']) {
    assert.equal(terminal.enter(words), words)
  }
})

test('in the terminal, a phrase typed as a shell command runs as typed', async () => {
  const terminal = await new Tui().load(tui)

  assert.equal(terminal.enter('blixel status', 'shell'), 'blixel status')
})
