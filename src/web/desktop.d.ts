export {}

declare global {
  interface Window {
    agentdeckDesktop?: {
      notify?: (notice: { title: string; detail: string; sessionId: string }) => Promise<void>
      onNotificationClick?: (cb: (sessionId: string) => void) => () => void
      selectProjectFolder: () => Promise<string | null>
      onPtyF6?: (cb: () => void) => () => void
    }
  }
}
