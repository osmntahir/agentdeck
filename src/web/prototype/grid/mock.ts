import type { Session, World } from './model'

/** Sabit saat: idle eşiği (30 sn) açılışta görünür olsun. */
export const T0 = 1_700_000_000_000

const SEED: World = {
  now: T0,
  projects: [
    { id: 'p-deck', name: 'agentdeck', path: '~/Desktop/agentdeck', color: '#7aa2f7', rootMissing: false },
    { id: 'p-shop', name: 'shop-api', path: '~/src/shop-api', color: '#e0af68', rootMissing: false },
    { id: 'p-notes', name: 'notes', path: '/mnt/eski/notes', color: '#bb9af7', rootMissing: true },
  ],
  sessions: [
    sess({
      id: 's-auth',
      projectId: 'p-deck',
      name: 'auth refactor',
      command: 'claude',
      isolation: 'worktree',
      branch: 'agentdeck/auth-a1f3',
      cwd: '~/.agentdeck/worktrees/auth-a1f3',
      lifecycle: 'live',
      lastActivity: T0 - 3_000,
      lines: [
        '$ claude',
        'src/server/sessions.ts içinde stop sırasını kontrol ediyorum.',
        '  await killGroup(session.pid)',
        'worktree: agentdeck/auth-a1f3',
      ],
    }),
    sess({
      id: 's-types',
      projectId: 'p-deck',
      name: 'types cleanup',
      command: 'gemini',
      isolation: 'worktree',
      branch: 'agentdeck/types-c9e2',
      cwd: '~/.agentdeck/worktrees/types-c9e2',
      lifecycle: 'live',
      lastActivity: T0 - 47_000,
      lines: [
        '$ gemini',
        'AgentKind alanını Session kaydından çıkarıyorum.',
        'command: string | null',
        '(son çıktı 47 sn önce)',
      ],
    }),
    sess({
      id: 's-shell',
      projectId: 'p-deck',
      name: 'log tara',
      command: null,
      isolation: 'shared',
      branch: null,
      cwd: '~/Desktop/agentdeck',
      lifecycle: 'live',
      lastActivity: T0 - 8_000,
      lines: ['$ journalctl --user -u agentdeck -n 40', 'Eyl 12 11:02 daemon listening :4711', '$'],
    }),
    sess({
      id: 's-spike',
      projectId: 'p-deck',
      name: 'old spike',
      command: 'codex',
      isolation: 'worktree',
      branch: 'agentdeck/spike-11ab',
      cwd: '~/.agentdeck/worktrees/spike-11ab',
      cwdMissing: true,
      lifecycle: 'exited',
      exitCode: 1,
      endedAt: T0 - 3600_000,
      lines: ['$ codex', 'Error: worktree path does not exist', 'exit 1'],
    }),
    sess({
      id: 's-pay',
      projectId: 'p-shop',
      name: 'payments',
      command: 'claude --permission-mode plan',
      isolation: 'worktree',
      branch: 'agentdeck/pay-44d0',
      cwd: '~/.agentdeck/worktrees/pay-44d0',
      lifecycle: 'live',
      lastActivity: T0 - 92_000,
      lines: [
        '$ claude --permission-mode plan',
        'Refund idempotency anahtarını Invoice satırına taşımayı öneriyorum.',
        'Plan hazır; PTY sessiz.',
      ],
    }),
    sess({
      id: 's-test',
      projectId: 'p-shop',
      name: 'tests',
      command: 'pytest -q',
      isolation: 'worktree',
      branch: 'agentdeck/test-90ee',
      cwd: '~/.agentdeck/worktrees/test-90ee',
      lifecycle: 'exited',
      exitCode: 0,
      endedAt: T0 - 120_000,
      lines: ['$ pytest -q', '........', '9 passed in 1.14s'],
    }),
    sess({
      id: 's-mig',
      projectId: 'p-shop',
      name: 'migrate',
      command: 'gemini',
      isolation: 'worktree',
      branch: 'agentdeck/mig-2b17',
      cwd: '~/.agentdeck/worktrees/mig-2b17',
      lifecycle: 'orphaned',
      lines: ['$ gemini', 'ALTER TABLE invoices …', '(önceki daemon; çıkış sonucu yok)'],
    }),
    sess({
      id: 's-inbox',
      projectId: 'p-notes',
      name: 'inbox',
      command: 'claude',
      isolation: 'worktree',
      branch: 'agentdeck/inbox-0c3a',
      cwd: '~/.agentdeck/worktrees/inbox-0c3a',
      lifecycle: 'live',
      lastActivity: T0 - 12_000,
      lines: ['$ claude', 'notes/inbox.md içindeki etiketleri sadeleştiriyorum.', '3 dosya değişti'],
    }),
    sess({
      id: 's-broken',
      projectId: 'p-notes',
      name: 'reindex',
      command: 'codex',
      isolation: 'shared',
      branch: null,
      cwd: '/mnt/eski/notes',
      lifecycle: 'live',
      lastActivity: T0 - 21_000,
      lines: ['$ codex', 'proje kökü okunamıyor; oturum live duruyor'],
    }),
  ],
}

export function seedWorld(): World {
  return structuredClone(SEED)
}

function sess(
  partial: Omit<Session, 'cwdMissing' | 'exitCode' | 'exitSignal' | 'endedAt' | 'lastActivity'> &
    Partial<Pick<Session, 'cwdMissing' | 'exitCode' | 'exitSignal' | 'endedAt' | 'lastActivity'>>,
): Session {
  return {
    cwdMissing: false,
    exitCode: null,
    exitSignal: null,
    endedAt: null,
    lastActivity: null,
    ...partial,
  }
}
