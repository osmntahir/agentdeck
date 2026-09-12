// Ayrı süreçte tek yazar kilidini tutar; SIGKILL sonrası kilidin gerçekten
// bırakıldığını ölçmek için kullanılır. Hazır olduğu, kilidin dışarıdan
// alınamamasıyla anlaşılır; stdio sinyali yoktur.
import { acquireDaemonLock } from '../../src/server/lock'

async function main(): Promise<void> {
  await acquireDaemonLock(process.argv[2])
  // Kilit süreç ölene kadar tutulur.
  setInterval(() => {}, 1000)
}

void main()
