import { execFile } from 'node:child_process'
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

/** Kaç yeni dosyayı diff'leyeceğimizin üst sınırı. */
const MAX_UNTRACKED = 50

/** `git diff --no-index` fark bulunca 1 ile çıkar; stdout yine geçerlidir. */
async function gitTolerant(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ''
  }
}

export async function diff(cwd: string): Promise<{ diff: string; status: string }> {
  const [tracked, status, untracked] = await Promise.all([
    git(cwd, ['--no-pager', 'diff', 'HEAD']).catch(() => ''),
    git(cwd, ['status', '--short']).catch(() => ''),
    git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
  ])

  // `git diff HEAD` takip edilmeyen dosyaların içeriğini göstermez. Ajanın en
  // sık yaptığı şey yeni dosya yazmak olduğundan onları ayrıca diff'liyoruz.
  const fresh = untracked.split('\n').filter(Boolean).slice(0, MAX_UNTRACKED)
  const extra = await Promise.all(
    fresh.map((file) => gitTolerant(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', file])),
  )

  return { diff: tracked + extra.join(''), status }
}
