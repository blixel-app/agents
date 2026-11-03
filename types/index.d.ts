/** One handoff this session received, as the Blixel pane lists it. */
export type PanelHandoff = {
  n: number
  text: string
  /** Who sent it, '' when the receiver did not say. */
  sender: string
  at: number
  state: 'waiting' | 'held' | 'delivered'
}

/** What the Blixel pane shows. */
export type Panel = {
  app: 'unknown' | 'running' | 'closed'
  isInMeeting: boolean
  isConnected: boolean
  isReconnecting: boolean
  /** The name of the room the app is in, if it is in one. */
  room: string | null
  /** The meeting the listed handoffs came from. */
  meeting: string | null
  /** The app's setting, read from the connection. */
  approval: 'ask' | 'direct' | null
  /**
   * What receives the connection's handoffs: this mod, another receiver in the
   * session (a Monitor), or nothing.
   */
  receiver: 'mod' | 'other' | null
  handoffs: PanelHandoff[]
}

declare module 'claude-code' {
  interface PluginState {
    blixel: { panel: Shaped<Panel>; opened: number[] }
  }
}
