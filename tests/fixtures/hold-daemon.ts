// Ayrı süreçte gerçek daemon tutar; SIGKILL sonrası checkpoint ve orphan
// kurtarmasının ölçüldüğü çöküş senaryosu için. Hazır olduğu stdout'taki
// tek JSON satırıyla anlaşılır.
import { startDaemon } from '../../src/server/daemon'

async function main(): Promise<void> {
  const daemon = await startDaemon({ dataDir: process.argv[2], port: 0 })
  process.stdout.write(`${JSON.stringify({ url: daemon.url, token: daemon.token })}\n`)
}

void main()
