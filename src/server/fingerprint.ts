import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

/**
 * Silme onayının içerik fingerprint'i (spec §6). Kaldırılacak çalışma
 * kopyasında geri getirilemeyecek her şey hash edilir: index'teki blob
 * kimlikleri, değişmiş takip edilen dosyalar, takip edilmeyen ve ignored
 * dosyaların içeriği. Temiz takip edilen dosyalar branch'te durduğu için
 * okunmaz. Symlink izlenmez; hedef metni hash edilir, dış içerik okunmaz.
 *
 * Bütçe aşılırsa veya bir şey okunamazsa fingerprint üretilmez: "değişmedi"
 * sonucu hash edilmemiş içerik için hiçbir zaman çıkarılmaz.
 */

export interface BudgetLimits {
  timeoutMs: number
  maxFiles: number
  maxBytes: number
}

export const DELETE_PREVIEW_LIMITS: BudgetLimits = {
  timeoutMs: 5000,
  maxFiles: 10_000,
  maxBytes: 128 * 1024 * 1024,
}

/** Birden çok çalışma kopyasına paylaştırılır; bir sınır N çağrıyla gizlice aşılamaz. */
export interface Budget {
  readonly limits: BudgetLimits
  readonly deadline: number
  files: number
  bytes: number
}

export function createBudget(limits: Partial<BudgetLimits> = {}): Budget {
  const merged = { ...DELETE_PREVIEW_LIMITS, ...limits }
  return { limits: merged, deadline: Date.now() + merged.timeoutMs, files: 0, bytes: 0 }
}

export type ContentFingerprint =
  | { ok: true; digest: string; changedEntries: number; ignoredEntries: number }
  | { ok: false; reason: 'budget' | 'unreadable'; message: string }

class BudgetExceeded extends Error {}

function checkTime(budget: Budget): void {
  if (Date.now() >= budget.deadline) {
    throw new BudgetExceeded(`İçerik okuması ${budget.limits.timeoutMs / 1000} sn sınırını aştı`)
  }
}

/** Okunacak her giriş dosya bütçesinden, içeriği bayt bütçesinden düşer. */
function charge(budget: Budget, bytes: number): void {
  checkTime(budget)
  budget.files += 1
  budget.bytes += bytes
  if (budget.files > budget.limits.maxFiles) {
    throw new BudgetExceeded(`Okunacak dosya sayısı ${budget.limits.maxFiles} sınırını aştı`)
  }
  if (budget.bytes > budget.limits.maxBytes) {
    throw new BudgetExceeded(`Okunacak içerik ${budget.limits.maxBytes / (1024 * 1024)} MiB sınırını aştı`)
  }
}

/**
 * Git yolları bayt dizisidir; latin1 bayt-bayt korunur ve dosya sistemine
 * aynı baytlarla geri verilir.
 */
async function gitBytes(cwd: string, args: string[], budget: Budget): Promise<string> {
  checkTime(budget)
  try {
    const { stdout } = await pexec('git', args, {
      cwd,
      encoding: 'buffer',
      timeout: budget.deadline - Date.now(),
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.toString('latin1')
  } catch (err) {
    if ((err as { killed?: boolean }).killed) {
      throw new BudgetExceeded(`İçerik okuması ${budget.limits.timeoutMs / 1000} sn sınırını aştı`)
    }
    throw err
  }
}

type Feed = (...parts: (string | Buffer)[]) => void

async function hashPath(root: Buffer, rel: string, budget: Budget, feed: Feed): Promise<void> {
  checkTime(budget)
  const abs = Buffer.concat([root, Buffer.from(`/${rel}`, 'latin1')])
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(abs)
  } catch (err) {
    // Yalnız ENOENT "yok" demektir; başka okuma hatası okunamazlıktır.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      feed('yok', rel)
      return
    }
    throw err
  }
  if (stat.isSymbolicLink()) {
    charge(budget, 0)
    feed('link', rel, await fs.promises.readlink(abs, { encoding: 'buffer' }))
    return
  }
  if (stat.isDirectory()) {
    feed('dizin', rel)
    const names = (await fs.promises.readdir(abs, { encoding: 'buffer' })).map((name) => name.toString('latin1')).sort()
    for (const name of names) await hashPath(root, `${rel}/${name}`, budget, feed)
    return
  }
  if (stat.isFile()) {
    charge(budget, stat.size)
    const content = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(abs)) content.update(chunk as Buffer)
    feed('dosya', rel, String(stat.mode & 0o777), content.digest())
    return
  }
  // Soket/FIFO içerik taşımaz; yalnız türü kaydedilir.
  charge(budget, 0)
  feed('özel', rel)
}

export async function contentFingerprint(dir: string, budget: Budget): Promise<ContentFingerprint> {
  const hash = crypto.createHash('sha256')
  const feed: Feed = (...parts) => {
    for (const part of parts) {
      const bytes = typeof part === 'string' ? Buffer.from(part, 'latin1') : part
      hash.update(`${bytes.length}:`)
      hash.update(bytes)
    }
  }
  try {
    // Index: HEAD'e göre staged girişlerin blob kimlikleri; çalışma ağacı aynı kalsa da görülür.
    feed('index', await gitBytes(dir, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames'], budget))
    const status = await gitBytes(
      dir,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames'],
      budget,
    )
    const root = Buffer.from(dir)
    let changedEntries = 0
    let ignoredEntries = 0
    for (const entry of status.split('\0')) {
      if (entry.length < 4) continue
      const xy = entry.slice(0, 2)
      if (xy === '!!') ignoredEntries += 1
      else changedEntries += 1
      feed('giriş', entry)
      // Ignored klasörler ve iç içe depolar tek giriş olarak gelir; içleri dolaşılır.
      await hashPath(root, entry.slice(3).replace(/\/$/, ''), budget, feed)
    }
    return { ok: true, digest: hash.digest('hex'), changedEntries, ignoredEntries }
  } catch (err) {
    if (err instanceof BudgetExceeded) return { ok: false, reason: 'budget', message: err.message }
    return { ok: false, reason: 'unreadable', message: (err as Error).message }
  }
}
