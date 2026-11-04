import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { mock } from 'node:test'

// Taken before a test mocks the clock: waits on the stand-in's real processes.
const realTimeout = globalThis.setTimeout
export const pause = (ms: number) => new Promise<void>((resolve) => realTimeout(resolve, ms))

export const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** Waits until `check` holds, calling `step` between tries: what moves the test's clock, if it has one. */
export async function until(check: () => boolean, what: string, step: () => void = () => {}) {
  for (let tries = 0; tries < 500; tries += 1) {
    if (check()) return
    step()
    await pause(10)
  }
  throw new Error(`never: ${what}`)
}

/** The processes this test started that are still alive. */
export const children = () => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n')
  } catch {
    return []
  }
}

export type Call = {
  args: string[]
  /** connect, status, disconnect or receive. */
  verb: string
  /** The session the CLI would take it for: the agent's variable, or the one `--session-env` names. */
  session: string | undefined
  env: Record<string, string>
  pid: number
  ppid: number
  /** Settles once the process has exited. */
  gone: Promise<void>
  signal?: string
}

export type Receiver = {
  call: Call
  /** Runs the deliver program with the text, as `receive` does for each handoff; its exit status. */
  deliver: (text: string) => Promise<number>
  /** Stops it with no word, as SIGKILL does. */
  kill: () => void
  /** Ends it with `ended` and this reason, exit 0. */
  end: (reason: string) => void
  /** Stops it with this error on stderr and exit status. */
  fail: (code: string, status: number) => void
  /** Whether it printed `receiving`. */
  attached: boolean
  /** Prints `receiving`, for a receiver started in `unattached`. */
  attach: () => void
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const event = (name: string, data: unknown) => line({ data, event: name, schema_version: 1 })
const error = (code: string, message: string, hint?: string) => line({ error: { code, message, ...(hint ? { hint } : {}) } })

// Runs in its own process for each call, as the real CLI does, and asks the test what
// to print, to run and how to exit. Plain CommonJS, so it needs no file extension.
const standIn = (socket: string) => `#!${process.execPath}
const fs = require('node:fs')
const net = require('node:net')
const { spawn } = require('node:child_process')
const socket = net.connect(${JSON.stringify(socket)})
const send = (message) => socket.write(JSON.stringify(message) + '\\n')
let leaving = false
send({ argv: process.argv.slice(2), env: process.env, pid: process.pid, ppid: process.ppid })
let rest = ''
socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  const parts = (rest + chunk).split('\\n')
  rest = parts.pop()
  for (const part of parts) act(JSON.parse(part))
})
socket.on('error', () => {})
socket.on('close', () => process.exit(leaving ? 143 : 70))
function act(message) {
  if (message.stdout) fs.writeSync(1, message.stdout)
  if (message.stderr) fs.writeSync(2, message.stderr)
  if (message.deliver) {
    const { program, text, env, id } = message.deliver
    const child = spawn(program, [text], { env: { ...process.env, ...env }, stdio: 'ignore' })
    // A program that cannot start answers as \`receive\` takes it: doubt.
    child.on('error', () => send({ delivered: id, code: 127 }))
    child.on('close', (code) => code !== null && send({ delivered: id, code }))
  }
  // A receiver takes a moment to stop, as the real one does, and the app counts it
  // live until it has.
  if (message.exit !== undefined) setTimeout(() => process.exit(message.exit), message.linger ?? 0)
}
process.on('SIGTERM', () => {
  leaving = true
  send({ signal: 'SIGTERM' })
  setTimeout(() => socket.end(), 300)
})
`

/**
 * Stands in for the `blixel` CLI and the app behind it, as the real ones answer: a
 * meeting has one connection, and connecting replaces another session's; `receive`
 * refuses a session with no connection (`not_connected`, exit 5), ends at once with
 * `received_elsewhere` beside a live receiver of that session, and otherwise prints
 * `receiving` and ends with `ended` when the connection does. SIGTERM stops a receiver
 * with no word, exit 143.
 */
export class Blixel {
  readonly dir: string
  readonly calls: Call[] = []
  /** The session holding the meeting's connection. */
  connection: string | undefined
  /** What `connect` prints on stderr, exit 5, instead of connecting. */
  connectFails: string | undefined
  /** Sessions another receiver holds, as the model's own can. */
  readonly elsewhere = new Set<string>()
  readonly receivers = new Map<string, Receiver>()
  /** Sessions whose next receiver never prints `receiving`. */
  readonly unattached = new Set<string>()
  private server: net.Server
  private sockets = new Set<net.Socket>()
  private delivering = new Map<number, (code: number) => void>()
  private handoffs = 0

  private constructor(dir: string, server: net.Server) {
    this.dir = dir
    this.server = server
  }

  /** A stand-in in a new folder, first on BLIXEL_HOOK_PATH, under the variable that names the agent's session. */
  static async start(variable: string) {
    const dir = fs.realpathSync(fs.mkdtempSync('/tmp/blixel-test-'))
    let blixel: Blixel
    const server = net.createServer((socket) => blixel.accept(socket, variable))
    blixel = new Blixel(dir, server)
    const socket = path.join(dir, 'cli')
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.writeFileSync(path.join(dir, 'bin', 'blixel'), standIn(socket), { mode: 0o755 })
    // A blixel on PATH, which nothing may run.
    fs.mkdirSync(path.join(dir, 'planted'))
    fs.writeFileSync(path.join(dir, 'planted', 'blixel'), `#!/bin/sh\necho "$*" >>"${dir}/planted-ran"\n`, { mode: 0o755 })
    process.env.BLIXEL_HOOK_PATH = `${dir}/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    process.env.PATH = `${dir}/planted:${process.env.PATH}`
    return blixel
  }

  /** Whether the blixel on PATH ran. */
  get plantedRan() {
    return fs.existsSync(path.join(this.dir, 'planted-ran'))
  }

  /** The calls of this verb, for this session if one is named. */
  ran(verb: string, session?: string) {
    return this.calls.filter((call) => call.verb === verb && (session === undefined || call.session === session))
  }

  /** What `connect` prints for this session, as the model's own `blixel agent connect` would. */
  connect(session: string) {
    const replaced = this.connection !== undefined && this.connection !== session
    const before = this.connection
    this.connection = session
    if (replaced) this.receivers.get(before!)?.end('replaced')
    const receiving = this.receivers.get(session)?.attached === true
    return line({
      data: { outcome: 'connected', receiving, replaced, connection: { connection_id: `c-${session}`, provider: 'test' } },
      schema_version: 1,
    })
  }

  /** What `disconnect` prints for this session. */
  disconnect(session: string) {
    if (this.connection !== session) return line({ data: { outcome: 'not_connected' }, schema_version: 1 })
    this.connection = undefined
    this.receivers.get(session)?.end('disconnected')
    return line({ data: { outcome: 'disconnected', connection_id: `c-${session}` }, schema_version: 1 })
  }

  status(session: string | undefined) {
    const mine = session !== undefined && this.connection === session
    const receiving = mine && this.receivers.get(session)?.attached === true
    return line({
      data: {
        meeting_id: 'm-1',
        session: mine ? { connected: true, receiving, connection_id: `c-${session}` } : {},
        ...(this.connection === undefined ? {} : { connection: { connection_id: `c-${this.connection}` } }),
      },
      schema_version: 1,
    })
  }

  /** Waits for the next `receive` past `count`, moving the mocked clock past each backoff. */
  async receivesAgain(count: number) {
    await until(() => this.ran('receive').length > count, 'a receive again', () => mock.timers.tick(1_000))
  }

  /**
   * The plugin stopped this receiver for good: the folder of the socket its deliver
   * program reaches went, and no backoff on the mocked clock starts another.
   */
  async staysStopped(live: Receiver, socket: string) {
    const count = this.ran('receive').length
    await until(() => !fs.existsSync(path.dirname(live.call.env[socket])), 'the socket folder removed')
    // Before the clock moves, or the plugin's 3 s wait for a stopping receiver runs out
    // while the stand-in is still stopping, which the real one never takes so long to do.
    await live.call.gone
    for (let i = 0; i < 10; i += 1) mock.timers.tick(60_000)
    const others = [...this.receivers.values()].map((receiver) => String(receiver.call.pid))
    assert.deepEqual(children().filter((pid) => !others.includes(pid)), [])
    assert.equal(this.ran('receive').length, count)
  }

  /** Kills what is left of this test's processes, and removes the folder. */
  async close() {
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(this.calls.map((call) => call.gone))
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    fs.rmSync(this.dir, { recursive: true, force: true })
  }

  private accept(socket: net.Socket, variable: string) {
    this.sockets.add(socket)
    const send = (message: unknown) => socket.write(line(message))
    let call: Call | undefined
    let rest = ''
    let exited: () => void
    const gone = new Promise<void>((resolve) => (exited = resolve))
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => {
      this.sockets.delete(socket)
      exited()
    })
    socket.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\n')
      rest = parts.pop() ?? ''
      for (const part of parts) {
        const message = JSON.parse(part)
        if (message.argv) {
          const args: string[] = message.argv
          const named = args.indexOf('--session-env')
          const session = named >= 0 ? message.env[args[named + 1]] : message.env[variable]
          call = { args, verb: args[1], session, env: message.env, pid: message.pid, ppid: message.ppid, gone }
          this.calls.push(call)
          this.answer(call, send, socket)
        } else if (message.signal) {
          call!.signal = message.signal
        } else if (message.delivered !== undefined) {
          this.delivering.get(message.delivered)?.(message.code)
        }
      }
    })
  }

  private answer(call: Call, send: (message: unknown) => void, socket: net.Socket) {
    const { verb, session } = call
    if (call.args[0] !== 'agent') return send({ stderr: error('unknown', 'Not a command this stand-in knows'), exit: 64 })
    if (verb === 'connect') {
      send({ stderr: event('request_id', { request_id: 'r-1' }) })
      if (this.connectFails !== undefined) return send({ stderr: this.connectFails, exit: 5 })
      return send({ stdout: this.connect(session!), exit: 0 })
    }
    if (verb === 'status') return send({ stdout: this.status(session), exit: 0 })
    if (verb === 'disconnect') return send({ stdout: this.disconnect(session!), exit: 0 })
    if (verb !== 'receive') return send({ stderr: error('unknown', 'Not a command this stand-in knows'), exit: 64 })
    if (session === undefined || this.connection !== session) {
      return send({
        stderr: error('not_connected', 'This session is not connected to the meeting', 'Run `blixel agent connect` first.'),
        exit: 5,
      })
    }
    if (this.receivers.has(session) || this.elsewhere.has(session)) {
      return send({ stdout: event('ended', { reason: 'received_elsewhere' }), exit: 0 })
    }
    const receiver: Receiver = {
      call,
      deliver: (text) => {
        const id = (this.handoffs += 1)
        const program = call.args[call.args.indexOf('--deliver-with') + 1]
        const env = { BLIXEL_HANDOFF_ID: String(id), BLIXEL_HANDOFF_SENDER: 'Ana' }
        return new Promise<number>((resolve) => {
          this.delivering.set(id, resolve)
          send({ deliver: { program, text, env, id } })
        })
      },
      kill: () => process.kill(call.pid, 'SIGKILL'),
      end: (reason) => send({ stdout: event('ended', { reason }), exit: 0, linger: 300 }),
      fail: (code, status) => send({ stderr: error(code, 'It stopped', 'Try again.'), exit: status }),
      attached: false,
      attach: () => {
        receiver.attached = true
        send({ stdout: event('receiving', { connection_id: `c-${session}` }) })
      },
    }
    this.receivers.set(session, receiver)
    socket.on('close', () => {
      if (this.receivers.get(session) === receiver) this.receivers.delete(session)
    })
    if (!this.unattached.delete(session)) receiver.attach()
  }
}
