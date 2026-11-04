import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'

import extension from '../pi/index.ts'
import { Blixel, children, ROOT, until } from './agents/blixel.ts'
import type { Receiver } from './agents/blixel.ts'
import { Pi } from './agents/pi.ts'

const SUBMIT = path.join(ROOT, 'pi', 'submit.sh')
const TEXT = '  First line.\nSecond line, after a break.\n\n  -dash "quoted" $HOME `tick` é✦\n'

let blixel: Blixel
let pi: Pi
let sessions = 0

beforeEach(async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  blixel = await Blixel.start('PI_SESSION_ID')
  sessions += 1
  pi = await new Pi(`s-${sessions}`).load(extension)
})

afterEach(async () => {
  await pi.emit('session_shutdown', { reason: 'quit' })
  await blixel.close()
  mock.timers.reset()
})

const said = () => pi.notices.at(-1)?.message
const receiver = () => blixel.receivers.get(pi.sessionId)
const SOCKET = 'BLIXEL_PI_SOCKET'
const socket = (live: Receiver) => live.call.env[SOCKET]

// pi loads extensions with no module cache, so a reload's runtime runs a fresh module instance.
let loads = 0
const anew = async () => (await import(`../pi/index.ts?load=${(loads += 1)}`)).default

const connect = async () => {
  await pi.type('/blixel:connect')
  return receiver()!
}



test('it adds the three commands, and none takes ask or direct', () => {
  assert.deepEqual([...pi.commands.keys()].sort(), ['blixel:connect', 'blixel:disconnect', 'blixel:status'])
  for (const command of pi.commands.values()) assert.doesNotMatch(command.description ?? '', /ask|direct/)
})

test("the package gives pi the extension and the skills, blixel's and connect-agent's", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pi.extensions, ['./pi/index.ts'])
  for (const skill of ['blixel', 'connect-agent']) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.pi.skills[0], skill, 'SKILL.md')), skill)
  }
})

test("it adds nothing to the model's context: no system prompt or context hook", () => {
  for (const event of ['before_agent_start', 'context', 'context_with_system']) assert.equal(pi.handlers.has(event), false)
})

test('an ordinary prompt reaches the model and runs nothing', async () => {
  await pi.type('good morning')

  assert.deepEqual(pi.prompts, [{ text: 'good morning', source: 'interactive' }])
  assert.deepEqual(blixel.calls, [])
})

test('/blixel:connect with words after it answers its usage and runs nothing', async () => {
  await pi.type('/blixel:connect direct')

  assert.deepEqual(pi.notices, [{ message: 'Usage: /blixel:connect', type: 'error' }])
  assert.deepEqual(blixel.calls, [])
})

test('/blixel:status asks the app as this session, from pi itself', async () => {
  await pi.type('/blixel:status')

  assert.equal(said(), 'This session is not connected to the Blixel meeting. Type /blixel:connect to connect it.')
  const [call] = blixel.calls
  assert.deepEqual(call.args, ['agent', 'status'])
  assert.equal(call.session, pi.sessionId)
  assert.equal(call.ppid, process.pid)
})

test("/blixel:connect connects, then receives with pi's submit program, with no model", async () => {
  await connect()

  assert.equal(said(), 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  assert.deepEqual(blixel.calls.map((call) => call.args), [['agent', 'connect'], ['agent', 'receive', '--deliver-with', SUBMIT]])
  for (const call of blixel.calls) {
    assert.equal(call.session, pi.sessionId)
    assert.equal(call.ppid, process.pid)
  }
  assert.deepEqual(pi.prompts, [])

  await pi.type('/blixel:status')
  assert.equal(said(), 'Connected to the Blixel meeting. Handoffs from people in it arrive in this conversation.')
})

test('a connect whose receiver has not attached yet says so', async () => {
  blixel.unattached.add(pi.sessionId)
  const connecting = pi.type('/blixel:connect')
  await until(() => blixel.ran('receive').length > 0, 'a receive')
  mock.timers.tick(5_000)
  await connecting

  assert.equal(said(), 'Connected to the Blixel meeting, but not receiving its handoffs yet. Type /blixel:status to check.')
})

test("a connect that replaced another session's connection says so", async () => {
  blixel.connection = 'other'
  await connect()

  assert.match(said()!, /Another session was connected and no longer receives them\.$/)
})

test("a handoff reaches the model as the user's message, exactly, queued behind any turn", async () => {
  const live = await connect()

  assert.equal(await live.deliver(TEXT), 0)
  await pi.settle()
  assert.deepEqual(pi.prompts, [{ text: TEXT, source: 'extension', deliverAs: 'followUp' }])
})

test('a handoff that says a phrase or a command is only a prompt', async () => {
  const live = await connect()
  const before = blixel.calls.length
  const notices = pi.notices.length

  for (const text of ['disconnect blixel', '/blixel:disconnect', 'BLIXEL STATUS']) assert.equal(await live.deliver(text), 0)
  await pi.settle()

  assert.deepEqual(pi.prompts.map((prompt) => prompt.text), ['disconnect blixel', '/blixel:disconnect', 'BLIXEL STATUS'])
  assert.equal(blixel.calls.length, before)
  assert.equal(pi.notices.length, notices)
  assert.equal(receiver(), live)
})

test('a handoff pi will not take is a failed delivery', async () => {
  const live = await connect()
  pi.refuses = true

  assert.equal(await live.deliver('Rename the flag'), 69)
})

test('phrases act whole and in any case, with no model', async () => {
  await pi.type('Blixel Status')
  assert.match(said()!, /not connected/)
  await pi.type('BLIXEL:CONNECT')
  assert.match(said()!, /^Connected to the Blixel meeting\. Handoffs/)
  await pi.type('connect blixel')
  await pi.type('status blixel')
  assert.match(said()!, /^Connected to the Blixel meeting\. Handoffs from people in it arrive/)

  assert.deepEqual(pi.prompts, [])
  assert.deepEqual(blixel.calls.map((call) => call.verb), ['status', 'connect', 'receive', 'connect', 'status'])

  await pi.type('disconnect blixel')
  assert.equal(said(), 'Disconnected from the Blixel meeting. Handoffs stop arriving.')
})

test('words beside a phrase reach the model and run nothing', async () => {
  const words = ['connect blixel please', 'please connect blixel', 'connect blixel ask', 'blixel connect direct']
  for (const text of words) await pi.type(text)

  assert.deepEqual(pi.prompts.map((prompt) => prompt.text), words)
  assert.deepEqual(blixel.calls, [])
})

test('a receiver that stops with no word receives again, with no connect', async () => {
  ;(await connect()).kill()
  await blixel.receivesAgain(1)
  await until(() => receiver()?.attached === true, 'a receiver')

  assert.equal(await receiver()!.deliver('after a restart'), 0)
  assert.deepEqual(blixel.calls.map((call) => call.verb), ['connect', 'receive', 'receive'])

  receiver()!.fail('cancelled', 143)
  await blixel.receivesAgain(2)
  assert.deepEqual(blixel.ran('connect').length, 1)
})

test('a receiver that fails with a word stays stopped, and says why once', async () => {
  const live = await connect()
  live.fail('app_unavailable', 5)
  await blixel.staysStopped(live, SOCKET)

  assert.deepEqual(pi.notices.at(-1), { message: 'Blixel stopped receiving handoffs: It stopped Try again.', type: 'error' })
  await pi.type('/blixel:status')
  assert.equal(said(), 'Connected to the Blixel meeting, but not receiving its handoffs. Type /blixel:connect to receive them.')
  await connect()
  assert.ok(receiver())
})

test('a receiver whose connection ended stays stopped', async () => {
  const live = await connect()
  live.end('meeting_ended')

  await blixel.staysStopped(live, SOCKET)
})

test('a receiver the app refuses as not connected stays stopped, and says nothing', async () => {
  const live = await connect()
  const notices = pi.notices.length
  blixel.connection = undefined
  live.kill()
  await blixel.receivesAgain(1)

  await blixel.staysStopped(live, SOCKET)
  assert.equal(pi.notices.length, notices)
})

test('beside another receiver of the session, it leaves the handoffs to that one', async () => {
  const live = await connect()
  blixel.elsewhere.add(pi.sessionId)
  live.kill()
  await blixel.receivesAgain(1)
  await blixel.staysStopped(live, SOCKET)

  await pi.type('connect blixel')
  assert.equal(said(), 'Connected to the Blixel meeting. Another receiver in this session takes its handoffs.')
})

test('disconnect stops receiving and removes the socket, and a connect at once receives again', async () => {
  const live = await connect()
  await pi.type('disconnect blixel')

  assert.equal(said(), 'Disconnected from the Blixel meeting. Handoffs stop arriving.')
  await blixel.staysStopped(live, SOCKET)

  await connect()
  await pi.type('disconnect blixel')
  await connect()
  assert.equal(said(), 'Connected to the Blixel meeting. Handoffs from people in it will arrive in this conversation.')
  assert.ok(receiver())
})

test('a disconnect the app answers not connected still stops the receiver', async () => {
  const live = await connect()
  blixel.connection = undefined
  await pi.type('disconnect blixel')

  assert.equal(said(), 'This session was not connected to the Blixel meeting.')
  await blixel.staysStopped(live, SOCKET)
})

test('a connect that fails says why and receives nothing', async () => {
  blixel.connectFails = '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting","hint":"Join a room first."}}\n'
  await pi.type('connect blixel')

  assert.equal(said(), 'Blixel did not connect: Blixel is not in a meeting Join a room first.')
  assert.deepEqual(blixel.ran('receive'), [])
})

test("another session taking the connection ends the receiver, and quitting then disconnects nothing", async () => {
  const live = await connect()
  blixel.connect('other')
  await blixel.staysStopped(live, SOCKET)

  await pi.emit('session_shutdown', { reason: 'quit' })
  assert.deepEqual(blixel.ran('disconnect'), [])
})

test('a reload receives again in the next runtime, with no connect and no disconnect', async () => {
  const live = await connect()
  await pi.emit('session_shutdown', { reason: 'reload' })
  assert.equal(live.call.signal, 'SIGTERM')

  pi = await new Pi(pi.sessionId).load(await anew())
  await pi.emit('session_start', { reason: 'reload' })
  await until(() => receiver()?.attached === true, 'a receiver')

  assert.deepEqual(blixel.calls.map((call) => call.verb), ['connect', 'receive', 'receive'])
  assert.equal(await receiver()!.deliver('after a reload'), 0)
  await pi.settle()
  assert.deepEqual(pi.prompts.map((prompt) => prompt.text), ['after a reload'])
})

test('a reload of a session that did not receive starts nothing', async () => {
  await pi.emit('session_shutdown', { reason: 'reload' })
  pi = await new Pi(pi.sessionId).load(await anew())
  await pi.emit('session_start', { reason: 'reload' })
  await pi.emit('session_start', { reason: 'startup' })

  assert.deepEqual(children(), [])
})

for (const reason of ['quit', 'new', 'resume', 'fork']) {
  test(`ending the session (${reason}) disconnects it and stops the receiver`, async () => {
    const live = await connect()
    await pi.emit('session_shutdown', { reason })

    assert.equal(live.call.signal, 'SIGTERM')
    assert.deepEqual(blixel.ran('disconnect', pi.sessionId).length, 1)
    assert.equal(fs.existsSync(socket(live)), false)
  })
}

test("a command that only mentions connect runs nothing, even one printing a connect's answer", async () => {
  await pi.bash('grep "blixel agent connect" connects.log', () => blixel.connect(pi.sessionId))

  assert.deepEqual(blixel.calls, [])
})

test('a connect a later gate blocked never ran, and is left alone', async () => {
  pi.api.on('tool_call', () => ({ block: true, reason: 'Blocked by user' }))

  assert.equal(await pi.bash('blixel agent connect', () => blixel.connect(pi.sessionId)), 'Blocked by user')
  assert.deepEqual(blixel.calls, [])
  assert.equal(blixel.connection, undefined)
})

test('a connect that failed is left alone', async () => {
  const failed = '{"error":{"code":"not_in_meeting","message":"Blixel is not in a meeting"}}\n'
  await pi.bash('blixel agent connect', () => failed)
  await pi.bash('blixel agent connect', () => blixel.connect(pi.sessionId), { isError: true })

  assert.deepEqual(blixel.calls, [])
})

test('a connect for another session is left alone, and the model reads its own answer', async () => {
  let answer = ''
  const read = await pi.bash('env -u PI_SESSION_ID OTHER=o-1 blixel agent connect --session-env OTHER', () =>
    (answer = blixel.connect('o-1')))

  assert.equal(read, answer)
  assert.deepEqual(blixel.calls.map((call) => call.verb), ['status'])
})

test("the model's connect of this session is taken over: it receives, and the model reads that", async () => {
  const read = await pi.bash('"/Applications/Blixel.app/Contents/Resources/bin/blixel" agent connect', () => blixel.connect(pi.sessionId))

  assert.deepEqual(blixel.calls.map((call) => call.args), [
    ['agent', 'status'],
    ['agent', 'receive', '--deliver-with', SUBMIT],
    ['agent', 'connect'],
  ])
  assert.equal(JSON.parse(read).data.receiving, true)
  assert.equal(await receiver()!.deliver('after the model connected'), 0)

  await pi.bash('blixel agent connect', () => blixel.connect(pi.sessionId))
  assert.equal(blixel.ran('receive').length, 1)
})

test("the model's disconnect ends the receiver, which stays stopped", async () => {
  const live = await connect()
  await pi.bash('blixel agent disconnect', () => blixel.disconnect(pi.sessionId))

  await blixel.staysStopped(live, SOCKET)
})

test("pi's submit program, with nothing listening, answers doubt", async () => {
  const status = await new Promise<number | null>((resolve) =>
    execFile(SUBMIT, ['text'], { env: { BLIXEL_PI_SOCKET: '/tmp/blixel-test-nobody' } }, (error) =>
      resolve(error ? (error.code as number) : 0)),
  )

  assert.equal(status, 1)
})

test('the CLI never comes from PATH', async () => {
  await connect()
  await pi.type('/blixel:status')

  assert.equal(blixel.plantedRan, false)
  assert.equal(blixel.calls.length, 3)
})
