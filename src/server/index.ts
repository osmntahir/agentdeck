import os from 'node:os'
import path from 'node:path'
import { startDaemon } from './daemon'
import { claudePaths } from './claudeAccounts'
import { StateError } from './store'
import { LockError } from './lock'

/** Port AGENTDECK_PORT, yoksa legacy PORT, yoksa 4711 (spec §7). */
const PORT = Number(process.env.AGENTDECK_PORT || process.env.PORT || 4711)
const DATA_DIR = process.env.AGENTDECK_DATA_DIR || path.join(os.homedir(), '.agentdeck')

async function main(): Promise<void> {
  const daemon = await startDaemon({
    dataDir: DATA_DIR,
    port: PORT,
    serveWeb: true,
    environmentFile: path.join(os.homedir(), '.config', 'agentdeck', 'environment.json'),
    // macOS'ta kimlik anahtar zincirindedir; dosya geçişi yalnız diğer platformlarda açılır.
    claudeAccounts: process.platform === 'darwin' ? undefined : { live: claudePaths() },
    // Konuşmaları işlere bağlayan SessionStart kancası (ADR 0018).
    claudeSettingsFile: path.join(path.dirname(claudePaths().credentials), 'settings.json'),
    // İşe bağlanan Claude arka plan oturumları `claude agents` ile okunur.
    claudeAgents: { command: 'claude', claudeDir: path.dirname(claudePaths().credentials) },
  })
  console.log(`agentdeck hazır:  ${daemon.url}/?token=${daemon.token}`)
  console.log(`vite ile geliştirme: http://127.0.0.1:4710/?token=${daemon.token}`)

  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    console.log(`[agentdeck] ${signal}: yeni mutation durduruldu, süreç grupları durduruluyor`)
    daemon
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[agentdeck] kapanışta hata: ${(err as Error).message}`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  if (err instanceof StateError || err instanceof LockError) {
    // Sözleşme: bu durumlarda boş state yazılmaz ve hiçbir dosya süpürülmez.
    console.error(`[agentdeck] başlatılamadı (${err.code}): ${err.message}`)
    process.exit(2)
  }
  console.error(`[agentdeck] başlatılamadı: ${(err as Error).message}`)
  process.exit(1)
})
