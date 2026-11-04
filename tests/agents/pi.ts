import type {
  ExtensionAPI, ExtensionContext, InputEventResult, RegisteredCommand, ToolResultEventResult,
} from '@earendil-works/pi-coding-agent'

type Handler = (event: any, ctx: ExtensionContext) => unknown
type Command = Omit<RegisteredCommand, 'name' | 'sourceInfo'>
type Part = { type: 'text'; text: string }

/** What reached the model as the user's message, and how pi was asked to queue it. */
export type Prompt = { text: string; source: 'interactive' | 'extension'; deliverAs?: string }

/**
 * pi 1.4.0 as an extension sees it (`dist/core/extensions/types.d.ts`, `docs/extensions.md`,
 * `docs/rpc-commands.md`), only what the extension uses: `on`, `registerCommand`,
 * `sendUserMessage`, and a context with `ui.notify` and the session's id. A typed `/name`
 * runs that command; anything else goes through the `input` handlers in order, and
 * reaches the model unless one handled it. A bash call goes through the `tool_call`
 * handlers, and only one none of them blocked runs and reaches `tool_result`, whose
 * handlers each see the content the one before returned.
 */
export class Pi {
  readonly handlers = new Map<string, Handler[]>()
  readonly commands = new Map<string, Command>()
  readonly notices: { message: string; type?: string }[] = []
  readonly prompts: Prompt[] = []
  /** Makes `sendUserMessage` throw, as pi does when it will not take a message. */
  refuses = false
  private delivering: Promise<unknown>[] = []

  readonly sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  readonly ctx = {
    ui: { notify: (message: string, type?: string) => void this.notices.push({ message, type }) },
    sessionManager: { getSessionId: () => this.sessionId },
  } as unknown as ExtensionContext

  readonly api = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return () => {}
    },
    registerCommand: (name: string, options: Command) => void this.commands.set(name, options),
    sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
      if (this.refuses) throw new Error('Pi is shutting down')
      this.delivering.push(this.input(content, 'extension', options?.deliverAs))
    },
  } as unknown as ExtensionAPI

  /** Loads the extension into this runtime. */
  async load(extension: (pi: ExtensionAPI) => void | Promise<void>) {
    await extension(this.api)
    return this
  }

  async emit(event: string, payload: Record<string, unknown>) {
    for (const handler of this.handlers.get(event) ?? []) await handler({ type: event, ...payload }, this.ctx)
  }

  /** What the person typed. */
  async type(text: string) {
    const typed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    const command = typed && this.commands.get(typed[1])
    if (command) return command.handler(typed[2] ?? '', this.ctx as never)
    await this.input(text, 'interactive')
  }

  /** Lets what `sendUserMessage` started reach the model. */
  async settle() {
    await Promise.all(this.delivering.splice(0))
  }

  /**
   * The model's bash call, which runs and prints what `output` answers unless a
   * `tool_call` handler blocked it, as a gate installed after Blixel's does. What the
   * model reads back.
   */
  async bash(command: string, output: () => string, how: { isError?: boolean } = {}) {
    const input = { command }
    for (const handler of this.handlers.get('tool_call') ?? []) {
      const result = (await handler({ type: 'tool_call', toolCallId: 't-1', toolName: 'bash', input }, this.ctx)) as
        | { block?: boolean; reason?: string }
        | undefined
      if (result?.block) return result.reason ?? 'Blocked'
    }
    let content: Part[] = [{ type: 'text', text: output() }]
    let isError = how.isError === true
    for (const handler of this.handlers.get('tool_result') ?? []) {
      const event = { type: 'tool_result', toolCallId: 't-1', toolName: 'bash', input, content, isError, details: undefined }
      const result = (await handler(event, this.ctx)) as ToolResultEventResult | undefined
      content = (result?.content as Part[] | undefined) ?? content
      isError = result?.isError ?? isError
    }
    return content.map((part) => part.text).join('')
  }

  private async input(text: string, source: Prompt['source'], deliverAs?: string) {
    for (const handler of this.handlers.get('input') ?? []) {
      const result = (await handler({ type: 'input', text, source }, this.ctx)) as InputEventResult | undefined
      if (result?.action === 'handled') return
      if (result?.action === 'transform') text = result.text
    }
    this.prompts.push({ text, source, ...(deliverAs ? { deliverAs } : {}) })
  }
}
