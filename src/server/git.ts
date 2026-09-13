import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

/** Verilen yolun git deposu kökünü döner, depo değilse null. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return null
  }
}

/** Bare depo Project olamaz: çalışma kopyası yoktur. */
export async function isBare(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-bare-repository'])).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Git mutasyonlarının serileştirme anahtarı. Bağlı worktree'ler aynı common
 * Git dizinini paylaşır; iki `git worktree` işlemi aynı depoda çakışmamalı.
 */
export async function commonGitDir(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  } catch {
    return cwd
  }
}

/** Çözümlenmiş HEAD OID'si; commit'i olmayan depoda null. */
export async function headOid(cwd: string): Promise<string | null> {
  try {
    const oid = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null
  } catch {
    return null
  }
}

/** Worktree açılışı hareketli HEAD yerine çözümlenmiş OID'den yapılır. */
export async function addWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  commit: string,
): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, commit])
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', worktreePath])
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    return '(bilinmiyor)'
  }
}

/**
 * NUL ayrılmış porcelain durumu. Boş dizi temiz çalışma kopyası demektir;
 * hata durumunda null döner ve "temiz" sonucu çıkarılmaz.
 */
export async function porcelainStatus(cwd: string): Promise<string[] | null> {
  try {
    const out = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
    return out.split('\0').filter((entry) => entry.length > 0)
  } catch {
    return null
  }
}

/** Korunan branch okuması 5 sn ile sınırlıdır (spec §6). */
const BRANCH_TIMEOUT_MS = 5000

export interface BranchRead {
  branches: { name: string; oid: string }[]
  truncated: boolean
  /** Git hatası boş listeyle karıştırılmaz. */
  error: string | null
}

/** Depodaki agentdeck/ branch adları ve tip OID'leri; en çok `limit` ref, fazlası kesik işaretlenir. */
export async function agentdeckBranches(repo: string, limit: number): Promise<BranchRead> {
  try {
    const { stdout } = await pexec(
      'git',
      ['for-each-ref', `--count=${limit + 1}`, '--format=%(refname)%00%(objectname)', 'refs/heads/agentdeck/'],
      { cwd: repo, timeout: BRANCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    )
    const lines = stdout.split('\n').filter((line) => line.includes('\0'))
    return {
      branches: lines.slice(0, limit).map((line) => {
        const [ref, oid] = line.split('\0')
        return { name: ref.slice('refs/heads/'.length), oid }
      }),
      truncated: lines.length > limit,
      error: null,
    }
  } catch (err) {
    const failure = err as { killed?: boolean; stderr?: string; message: string }
    return {
      branches: [],
      truncated: false,
      error: failure.killed
        ? `Branch okuması ${BRANCH_TIMEOUT_MS / 1000} sn sınırını aştı`
        : failure.stderr?.trim() || failure.message,
    }
  }
}

/** Diff okuma sınırları (spec §5). Aşım görünür işaretlenir; sessiz kesme yoktur. */
const DIFF_TIMEOUT_MS = 5000
const MAX_PATCH_BYTES = 1024 * 1024
const MAX_STATUS_BYTES = 1024 * 1024
const MAX_STATUS_ENTRIES = 10_000
/** İçeriği diff'lenen takip edilmeyen dosya sayısı. */
const MAX_UNTRACKED = 50

/**
 * Çıktısı bayt sınırıyla okunan git çağrısı. Sınıra ulaşınca süreç durdurulur
 * ve çıktı kesik işaretlenir. okExitCodes dışındaki çıkış ve süre aşımı hatadır.
 */
function gitCapped(
  cwd: string,
  args: string[],
  capBytes: number,
  deadline: number,
  okExitCodes: number[] = [0],
): Promise<{ out: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return reject(new Error(`Git okuması ${DIFF_TIMEOUT_MS / 1000} sn sınırını aştı`))
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let truncated = false
    let timedOut = false
    let stderr = ''
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, remaining)
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const room = capBytes - size
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        size = capBytes
        truncated = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new Error(`Git okuması ${DIFF_TIMEOUT_MS / 1000} sn sınırını aştı`))
      if (!truncated && !okExitCodes.includes(code ?? -1)) {
        return reject(new Error(stderr.trim() || `git ${args.find((a) => !a.startsWith('-'))} çıkış kodu ${code}`))
      }
      resolve({ out: Buffer.concat(chunks), truncated })
    })
  })
}

/** Kesik patch son tam satırda biter; yarım UTF-8 karakteri ekrana taşınmaz. */
function patchText(out: Buffer, truncated: boolean): string {
  return (truncated ? out.subarray(0, out.lastIndexOf(0x0a) + 1) : out).toString('utf8')
}

/** NUL ayrılmış porcelain çıktısını görünür satırlara çevirir; rename kaynağı aynı satıra yazılır. */
function statusEntries(read: { out: Buffer; truncated: boolean }): {
  lines: string[]
  untracked: string[]
  truncated: boolean
} {
  const tokens = read.out.toString('utf8').split('\0')
  // Kesik çıktının son parçası yarım bir yol olabilir.
  if (read.truncated) tokens.pop()
  const lines: string[] = []
  const untracked: string[] = []
  let truncated = read.truncated
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (entry.length < 4) continue
    if (lines.length >= MAX_STATUS_ENTRIES) {
      truncated = true
      break
    }
    const xy = entry.slice(0, 2)
    if (xy[0] === 'R' || xy[0] === 'C') {
      lines.push(`${entry} ← ${tokens[++i] ?? ''}`)
      continue
    }
    // Klasör olarak görünen iç içe depo içerik diff'i değildir; yalnız listelenir.
    if (xy === '??' && !entry.endsWith('/')) untracked.push(entry.slice(3))
    lines.push(entry)
  }
  return { lines, untracked, truncated }
}

export interface RepoDiffRead {
  diff: string
  status: string
  patchTruncated: boolean
  statusTruncated: boolean
  stale: boolean
  error: string | null
}

/**
 * Çalışma ağacının `against`'e göre farkı: base commit OID'si ("Bu çalışma")
 * veya HEAD ("Commit edilmemiş"). Takip edilmeyen dosyalar ayrıca eklenir.
 * Git hatası veya süre aşımı temiz sonuç sayılmaz; error alanında döner.
 */
export async function diff(cwd: string, against: string): Promise<RepoDiffRead> {
  const deadline = Date.now() + DIFF_TIMEOUT_MS
  const result: RepoDiffRead = {
    diff: '',
    status: '',
    patchTruncated: false,
    statusTruncated: false,
    stale: false,
    error: null,
  }
  try {
    const headBefore = await headOid(cwd)
    // Toplam görünüm yalnız bu depoda erişilebilen commit ile açılır; hareketli ref ikame edilmez.
    await gitCapped(cwd, ['cat-file', '-e', `${against}^{commit}`], 1024, deadline).catch(() => {
      throw new Error(
        against === 'HEAD'
          ? 'HEAD çözümlenemedi; depoda commit yok'
          : `Başlangıç commit'i bu depoda erişilemiyor (${against.slice(0, 12)}); toplam görünüm kapalı`,
      )
    })
    const [status, tracked] = await Promise.all([
      gitCapped(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], MAX_STATUS_BYTES, deadline),
      gitCapped(
        cwd,
        ['-c', 'core.quotepath=off', '--no-pager', 'diff', '--no-color', '--no-ext-diff', against, '--'],
        MAX_PATCH_BYTES,
        deadline,
      ),
    ])
    const entries = statusEntries(status)
    result.status = entries.lines.join('\n')
    result.statusTruncated = entries.truncated

    let patch = patchText(tracked.out, tracked.truncated)
    result.patchTruncated = tracked.truncated || entries.untracked.length > MAX_UNTRACKED
    // `git diff <ref>` takip edilmeyen dosyaların içeriğini göstermez. Ajanın en
    // sık yaptığı şey yeni dosya yazmak olduğundan onlar ayrıca diff'lenir.
    for (const file of entries.untracked.slice(0, MAX_UNTRACKED)) {
      const room = MAX_PATCH_BYTES - Buffer.byteLength(patch)
      if (tracked.truncated || room <= 0) {
        result.patchTruncated = true
        break
      }
      const extra = await gitCapped(
        cwd,
        ['--no-pager', 'diff', '--no-color', '--no-index', '--', '/dev/null', file],
        room,
        deadline,
        // --no-index fark bulunca 1 ile çıkar; çıktı yine geçerlidir.
        [0, 1],
      )
      patch += patchText(extra.out, extra.truncated)
      if (extra.truncated) {
        result.patchTruncated = true
        break
      }
    }
    result.diff = patch
    // CLI'lar dış Git işlemi yapabilir; atomik snapshot vaat edilmez, değişim işaretlenir.
    result.stale = (await headOid(cwd)) !== headBefore
  } catch (err) {
    return { ...result, diff: '', status: '', error: (err as Error).message }
  }
  return result
}
