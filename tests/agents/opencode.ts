import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL(`${import.meta.dirname}/opencode-plugin.ts`).href

// The plugin's imports of OpenCode's own module resolve to the stand-in, so a test
// imports the plugin only after this file.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === '@opencode/plugin' || specifier === '@opencode/plugin/tui'
      ? { url: PLUGIN, shortCircuit: true }
      : next(specifier, context),
})

type Plugin = { id: string; setup: (ctx: any) => unknown }
type Command = { name: string; description: string; execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void> }
type Ran = { output: { output: string; exit: number; status: string }; content: { type: 'text'; text: string }[]; metadata: object }
type Tool = { id: string; execute: (input: Record<string, unknown>, context: { sessionID: string }) => Promise<Ran> }
type Notice = { sessionID: string; text: string; description?: string; resume?: boolean }
type PromptEvent = { sessionID: string; prompt: { text: string }; metadata?: Record<string, unknown> }

/**
 * An OpenCode 2.2.5 server as a plugin's `setup` sees it (the plugin context in the
 * binary's embedded JS), only what the Blixel plugin uses: skill, command and tool
 * editors through `transform`, the session's `prompt` and `synthetic`, and its `prompt`
 * hook, which edits each prompt before the model reads it: what a client sends and what
 * the plugin itself submits alike. The desktop and web apps send what was typed with
 * `metadata.displayText`, which they show in its place. A command's
 * `execute` gets the session and the text after its name. The shell tool asks
 * permission inside its own `execute`, before the command runs: `deny` throws, `ask`
 * waits for `reply`, and a rejected reply throws.
 */
export class OpenCode {
  readonly skills = new Map<string, { name: string; description: string; content: string; path: string }>()
  readonly commands = new Map<string, Command>()
  readonly tools = new Map<string, Tool>()
  private hooks: ((event: PromptEvent) => Promise<void>)[] = []
  /** What reached each session's model as the user's prompt. */
  readonly prompts: { sessionID: string; text: string }[] = []
  /** What each session showed with no model turn, or started one with. */
  readonly notices: Notice[] = []
  /** Answers `session.prompt` once it settles; a rejection is OpenCode refusing it. */
  promptAnswer: () => Promise<void> = async () => {}
  permission: 'allow' | 'deny' | 'ask' = 'allow'
  /** The shell commands that ran, and the session each ran for. */
  readonly ran: { command: string; sessionID: string }[] = []
  private asked: { allow: () => void; reject: () => void } | undefined

  readonly ctx = {
    skill: {
      transform: async (change: (editor: unknown) => void) => {
        change({ get: (name: string) => this.skills.get(name), add: (skill: any) => this.skills.set(skill.name, skill) })
        return { dispose: () => {} }
      },
    },
    command: {
      transform: async (change: (editor: unknown) => void) => {
        change({ add: (command: Command) => this.commands.set(command.name, command) })
        return { dispose: () => {} }
      },
    },
    tool: {
      transform: async (change: (editor: unknown) => void) => {
        change({
          update: (name: string, edit: (tool: Tool) => void) => {
            const tool = { ...this.tools.get(name)! }
            edit(tool)
            this.tools.set(name, tool)
          },
        })
        return { dispose: () => {} }
      },
    },
    session: {
      prompt: async (input: { sessionID: string; text: string }) => {
        await this.promptAnswer()
        await this.enter(input.sessionID, input.text)
      },
      synthetic: async (input: Notice) => void this.notices.push(input),
      hook: async (name: string, hook: (event: PromptEvent) => Promise<void>) => {
        if (name === 'prompt') this.hooks.push(hook)
        return { dispose: () => {} }
      },
    },
  }

  constructor() {
    this.tools.set('shell', { id: 'shell', execute: (input, context) => this.run(input, context as Context) })
  }

  async load(plugin: Plugin) {
    await plugin.setup(this.ctx)
    return this
  }

  /** The person ran `/<name> <text>` in the session. */
  async command(sessionID: string, name: string, text = '') {
    await this.commands.get(name)!.execute({ sessionID, prompt: { text } })
  }

  /** The person typed the text in the desktop app and sent it. */
  async typed(sessionID: string, text: string) {
    await this.enter(sessionID, text, { displayText: text })
  }

  /** What the session showed last. */
  said(sessionID: string) {
    return this.notices.filter((notice) => notice.sessionID === sessionID).at(-1)?.text
  }

  /**
   * The model's shell call in the session, through whatever wraps the tool: once it
   * runs, the command prints what `output` answers. What the model reads back.
   */
  async shell(sessionID: string, command: string, output: () => string, extra: Record<string, unknown> = {}) {
    // The output rides on the call's context, which the wrapper passes on as it is.
    const context: Context = { sessionID, output }
    const ran = await this.tools.get('shell')!.execute({ command, description: 'run it', ...extra }, context)
    return ran.output.output
  }

  /** The person's answer to the shell's pending permission. */
  reply(allow: boolean) {
    const asked = this.asked!
    this.asked = undefined
    if (allow) asked.allow()
    else asked.reject()
  }

  get asking() {
    return this.asked !== undefined
  }

  private async enter(sessionID: string, text: string, metadata?: Record<string, unknown>) {
    const event: PromptEvent = { sessionID, prompt: { text }, metadata }
    for (const hook of this.hooks) await hook(event)
    this.prompts.push({ sessionID, text: event.prompt.text })
  }

  private async run(input: Record<string, unknown>, context: Context): Promise<Ran> {
    if (this.permission === 'deny') throw new Error('Permission denied: shell')
    if (this.permission === 'ask') {
      await new Promise<void>((allow, reject) => {
        this.asked = { allow, reject: () => reject(new Error('The user declined this tool call')) }
      })
    }
    this.ran.push({ command: String(input.command), sessionID: context.sessionID })
    const text = context.output()
    return { output: { output: text, exit: 0, status: 'completed' }, content: [{ type: 'text', text }], metadata: {} }
  }
}

type Context = { sessionID: string; output: () => string }

/**
 * OpenCode's terminal UI as a TUI plugin's `setup` sees it, only what the Blixel plugin
 * uses: a slot it renders with the prompt's input, a keymap layer, and the focused
 * prompt. Enter runs each layer's `return` command; one that answers true handled the
 * key, and otherwise the prompt submits its text.
 */
export class Tui {
  readonly prompt = { plainText: '', setText(text: string) { this.plainText = text } }
  private slots: { append: string; render: (input: { mode: string }) => unknown }[] = []
  private layers: (() => { commands: { bind: string; run: () => boolean }[] })[] = []

  readonly ctx = {
    ui: { slot: (slot: (typeof this.slots)[number]) => void this.slots.push(slot) },
    keymap: { layer: (layer: (typeof this.layers)[number]) => void this.layers.push(layer) },
    renderer: { currentFocusedRenderable: this.prompt },
  }

  async load(plugin: Plugin) {
    await plugin.setup(this.ctx)
    return this
  }

  /** Types the text in the prompt, in this mode, and presses Enter: what it submits, if anything. */
  enter(text: string, mode = 'normal') {
    this.prompt.plainText = text
    for (const slot of this.slots) if (slot.append === 'prompt.footer.status') slot.render({ mode })
    for (const layer of this.layers) {
      for (const command of layer().commands) if (command.bind === 'return' && command.run()) return undefined
    }
    return this.prompt.plainText
  }
}
