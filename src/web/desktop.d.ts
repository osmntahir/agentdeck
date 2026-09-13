export {}

declare global {
  interface Window {
    agentdeckDesktop?: {
      selectProjectFolder: () => Promise<string | null>
      onPtyF6?: (cb: () => void) => () => void
    }
  }
}
