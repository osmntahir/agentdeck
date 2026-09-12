import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'

/**
 * Tek yazar kilidi. Daemon, canonical veri dizinine bağlı hash'li Linux
 * abstract socket'ini bind etmeden state'e dokunmaz; böylece aynı veri dizinini
 * farklı porttan veya symlink alias'ından açan ikinci daemon reddedilir.
 * Network namespace paylaşımı kapsam dışıdır.
 */
export class LockError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LockError'
    this.code = code
  }
}

export interface DaemonLock {
  readonly address: string
  release(): Promise<void>
}

function abstractAddress(dataDir: string): string {
  // Alias'ların aynı kilide düşmesi için gerçek yola çözülür.
  let canonical: string
  try {
    canonical = fs.realpathSync(dataDir)
  } catch {
    canonical = dataDir
  }
  const key = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)
  return `\0agentdeck-${key}`
}

export function acquireDaemonLock(dataDir: string): Promise<DaemonLock> {
  const address = abstractAddress(dataDir)
  const server = net.createServer()
  // Kilit soketine bağlanan olmaz; gelen bağlantı varsa da tutulmaz.
  server.on('connection', (socket) => socket.destroy())

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new LockError(
            'data_dir_locked',
            `Bu veri dizinini başka bir daemon tutuyor: ${dataDir}. İkinci yazar açılmaz.`,
          ),
        )
        return
      }
      reject(new LockError('lock_failed', `Tek yazar kilidi alınamadı: ${err.message}`))
    })
    server.listen(address, () => {
      resolve({
        address,
        release: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
