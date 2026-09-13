export {}

declare global {
  interface Window {
    agentdeckDesktop?: {
      selectProjectFolder: () => Promise<string | null>
    }
  }
}
