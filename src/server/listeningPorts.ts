import fs from 'node:fs'
import net from 'node:net'

/**
 * Oturum başına port (ADR 0023). İki parça:
 * - Ayırma: her oturuma sabit bir port; Run'a PORT olarak verilir. Uymak
 *   programın kararıdır (Vite ve benzerleri kendi portunu seçer).
 * - Gözlem: canlı Run'ın süreç ağacında dinlenen TCP portları Linux /proc'tan
 *   okunur. Önizleme adresi buradan gelir; ayrılan porta güvenilmez.
 */

export const PORT_RANGE = { first: 4800, last: 5799 } as const

/** Bir oturumda gösterilecek en çok port. */
const MAX_PORTS_PER_SESSION = 6
/** Bir taramada okunacak en çok süreç; daemon'ın kontrol işlerini boğmaz. */
const MAX_PROCESSES = 4096

/** /proc/net/tcp{,6} satırlarından LISTEN (0A) soketlerin inode → port eşlemesi. */
export function parseListening(text: string, into = new Map<string, number>()): Map<string, number> {
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== '0A') continue
    const port = Number.parseInt(fields[1]!.split(':')[1] ?? '', 16)
    const inode = fields[9]!
    if (Number.isInteger(port) && port > 0 && inode !== '0') into.set(inode, port)
  }
  return into
}

/** /proc/<pid>/stat: komut adı parantez içinde boşluk içerebilir; alanlar son ')'dan sonra okunur. */
export function parseStat(text: string): { ppid: number; sid: number } | null {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const ppid = Number(fields[1])
  const sid = Number(fields[3])
  return Number.isInteger(ppid) && Number.isInteger(sid) ? { ppid, sid } : null
}

/**
 * Kök pid'lerin süreçleri: aynı oturum (setsid) veya kökün soyundan gelen.
 * PTY lideri kendi oturumunu açar; ajanın arka plana attığı sunucu da çoğunlukla
 * o oturumda kalır.
 */
export function ownedProcesses(procs: Map<number, { ppid: number; sid: number }>, roots: Map<string, number>): Map<string, number[]> {
  const byRoot = new Map<number, string>()
  for (const [id, pid] of roots) byRoot.set(pid, id)
  const owner = new Map<number, string | null>()
  const resolve = (pid: number, depth: number): string | null => {
    if (owner.has(pid)) return owner.get(pid)!
    const direct = byRoot.get(pid)
    if (direct !== undefined) return direct
    const proc = procs.get(pid)
    if (!proc || depth > 64) return null
    const found = byRoot.get(proc.sid) ?? (proc.ppid > 1 ? resolve(proc.ppid, depth + 1) : null)
    owner.set(pid, found)
    return found
  }
  const result = new Map<string, number[]>()
  for (const pid of procs.keys()) {
    const id = resolve(pid, 0)
    if (id === null) continue
    const list = result.get(id) ?? []
    list.push(pid)
    result.set(id, list)
  }
  for (const [id, pid] of roots) if (!result.has(id)) result.set(id, [pid])
  return result
}

async function readProcs(): Promise<Map<number, { ppid: number; sid: number }>> {
  const procs = new Map<number, { ppid: number; sid: number }>()
  const names = (await fs.promises.readdir('/proc')).filter((name) => /^\d+$/.test(name)).slice(0, MAX_PROCESSES)
  await Promise.all(names.map(async (name) => {
    try {
      const stat = parseStat(await fs.promises.readFile(`/proc/${name}/stat`, 'utf8'))
      if (stat) procs.set(Number(name), stat)
    } catch {
      // süreç okuma sırasında bitebilir
    }
  }))
  return procs
}

async function socketInodes(pid: number): Promise<string[]> {
  let fds: string[]
  try {
    fds = await fs.promises.readdir(`/proc/${pid}/fd`)
  } catch {
    return []
  }
  const inodes: string[] = []
  await Promise.all(fds.map(async (fd) => {
    try {
      const target = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`)
      if (target.startsWith('socket:[')) inodes.push(target.slice(8, -1))
    } catch {
      // fd kapanmış olabilir
    }
  }))
  return inodes
}

/** Oturum kimliği → PTY lider pid'i için dinlenen portlar. /proc yoksa boş döner. */
export async function scanListeningPorts(roots: Map<string, number>): Promise<Record<string, number[]>> {
  if (roots.size === 0) return {}
  const listening = new Map<string, number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      parseListening(await fs.promises.readFile(file, 'utf8'), listening)
    } catch {
      // IPv6 kapalı olabilir
    }
  }
  if (listening.size === 0) return {}
  let procs: Map<number, { ppid: number; sid: number }>
  try {
    procs = await readProcs()
  } catch {
    return {}
  }
  const result: Record<string, number[]> = {}
  for (const [id, pids] of ownedProcesses(procs, roots)) {
    const ports = new Set<number>()
    for (const pid of pids) for (const inode of await socketInodes(pid)) {
      const port = listening.get(inode)
      if (port !== undefined) ports.add(port)
    }
    if (ports.size > 0) result[id] = [...ports].sort((a, b) => a - b).slice(0, MAX_PORTS_PER_SESSION)
  }
  return result
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** Aralıkta kayıtlı oturumlara ayrılmamış ve şu an boş ilk port; hiçbiri yoksa null. */
export async function allocatePort(taken: ReadonlySet<number>): Promise<number | null> {
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) {
    if (taken.has(port)) continue
    if (await portFree(port)) return port
  }
  return null
}
