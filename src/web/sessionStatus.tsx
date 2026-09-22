import type { SessionView } from '../shared/types'

/**
 * Oturumun tek bakışta okunan durumu. Dikkat yalnız daemon'un doğruladığı onay
 * veya soru için verilir; sessizlik "bekliyor" sayılmaz.
 */
export type StatusTone = 'attention' | 'active' | 'idle' | 'done' | 'error' | 'orphaned'

export function statusTone(session: SessionView): StatusTone {
  if (session.lifecycle === 'live') {
    if (session.attention) return 'attention'
    return session.activity === 'idle' ? 'idle' : 'active'
  }
  if (session.lifecycle === 'orphaned') return 'orphaned'
  return session.exitCode !== null && session.exitCode !== 0 ? 'error' : 'done'
}

/**
 * Canlı etiket sessizliği sessizlik olarak söyler: "bekliyor" veya "hata"
 * sonucu çıkarılmaz. Dikkat bilgisi yalnız açık onay/soru, hata ve orphaned ile ayrılır.
 */
export function stateLabel(session: SessionView): string {
  if (session.lifecycle === 'live') {
    if (session.attention) return session.attention.kind === 'approval' ? 'Onay bekliyor' : 'Yanıt bekliyor'
    return session.activity === 'idle' ? 'Sessiz' : 'Çalışıyor'
  }
  if (session.lifecycle === 'orphaned') return 'Bağlantı yok'
  if (session.exitCode === 0) return 'Bitti'
  if (session.exitCode !== null) return `Hata · kod ${session.exitCode}`
  if (session.exitSignal !== null) return `Durduruldu · ${session.exitSignal}`
  return 'Bitti'
}

export function StatusDot({ session }: { session: SessionView }) {
  return <span className="status-dot" data-tone={statusTone(session)} aria-hidden="true" />
}
