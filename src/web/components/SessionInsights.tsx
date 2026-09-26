import type { SessionView } from '../../shared/types'
import { contextFill, formatCost, formatTokens, modelLabel, totalTokens, type ConversationUsage, type TokenUsage } from '../../shared/usage'
import { Icon } from './Icon'

/**
 * Oturumun dinlenen portları ve kullanım özeti (ADR 0023). Portlar canlı
 * Run'ın süreç ağacından gözlenir; ayrılan port yalnız ipucudur.
 */
export function PortLinks({ session }: { session: SessionView }) {
  const ports = session.ports ?? []
  if (ports.length === 0) return null
  return (
    <span className="port-links">
      {ports.map((port) => (
        <a
          key={port}
          className="port-link"
          href={`http://localhost:${port}`}
          target="_blank"
          rel="noreferrer"
          draggable={false}
          title={[
            `http://localhost:${port} adresini tarayıcıda aç`,
            port === session.port ? 'Bu oturuma ayrılan port (PORT)' : session.port ? `Bu oturuma ayrılan port: ${session.port}` : null,
          ].filter(Boolean).join('\n')}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="port-pulse" aria-hidden="true" />
          <span>:{port}</span>
          <Icon name="external" size={11} />
        </a>
      ))}
    </span>
  )
}

/** Çok satırlı ipucu: toplam kullanım dökümü ve tahminin ne olduğu. */
export function usageTitle(total: TokenUsage, heading: string): string {
  const cost = formatCost(total.costUsd)
  return [
    `${heading}: ${formatTokens(totalTokens(total))} token${cost ? ` · API karşılığı ≈ ${cost}${total.costPartial ? '+' : ''}` : ''}`,
    `Giriş ${formatTokens(total.input)} · Çıkış ${formatTokens(total.output)}`,
    `Önbellekten okuma ${formatTokens(total.cacheRead)} · Önbelleğe yazma ${formatTokens(total.cacheWrite)}`,
    total.costPartial ? 'Fiyatı bilinmeyen model veya hızlı mod mesajları tutara eklenmedi.' : null,
    cost ? 'Standart API fiyatıyla tahmin; abonelikte ödenen tutar değildir.' : null,
  ].filter(Boolean).join('\n')
}

function fillTone(fill: number | null): 'low' | 'mid' | 'high' {
  if (fill === null || fill < 0.6) return 'low'
  return fill < 0.85 ? 'mid' : 'high'
}

/** Küçük halka: bağlamın ne kadarı dolu; halka ile yazı aynı tonu taşır. */
function Ring({ fill }: { fill: number }) {
  const r = 5.5
  const length = 2 * Math.PI * r
  return (
    <svg className="context-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} className="context-ring-track" />
      <circle cx="7" cy="7" r={r} className="context-ring-fill" strokeDasharray={`${Math.max(0.6, fill * length)} ${length}`} />
    </svg>
  )
}

/**
 * Grup başlığındaki kullanım: canlı konuşmada bağlam halkası ve boyutu,
 * yanında oturumun toplam API karşılığı. Konuşma yoksa hiç görünmez.
 */
export function ContextMeter({ usage, live }: { usage: ConversationUsage | null | undefined; live: boolean }) {
  if (!usage || totalTokens(usage.total) === 0) return null
  const context = live ? usage.context : null
  const fill = context ? contextFill(context) : null
  const cost = formatCost(usage.total.costUsd)
  const title = [
    context
      ? `Bağlam: ${formatTokens(context.tokens)}${context.window ? ` / ${formatTokens(context.window)} token (%${Math.round((fill ?? 0) * 100)})` : ' token'} · ${modelLabel(context.model)}`
      : null,
    context && fill !== null && fill >= 0.85 ? 'Bağlam dolmak üzere: ajan yakında özetleyebilir (/compact).' : null,
    usageTitle(usage.total, 'Bu oturumun toplamı'),
  ].filter(Boolean).join('\n')
  return (
    <span className="context-meter" data-tone={fillTone(fill)} title={title} aria-label={title}>
      {context && fill !== null && <Ring fill={fill} />}
      {context && <span className="context-tokens">{formatTokens(context.tokens)}</span>}
      {context && cost && <span className="context-sep" aria-hidden="true">·</span>}
      {cost && <span className="context-cost">{cost}{usage.total.costPartial ? '+' : ''}</span>}
      {!context && !cost && <span className="context-tokens">{formatTokens(totalTokens(usage.total))}</span>}
    </span>
  )
}

/** Satır içi kısa tutar: "$3,21" veya fiyat yoksa token sayısı; ayrıntı ipucundadır. */
export function UsageAmount({ total, heading, className = '' }: { total: TokenUsage | null | undefined; heading: string; className?: string }) {
  if (!total || totalTokens(total) === 0) return null
  const cost = formatCost(total.costUsd)
  return (
    <span className={`usage-amount ${className}`} title={usageTitle(total, heading)}>
      {cost ? `${cost}${total.costPartial ? '+' : ''}` : `${formatTokens(totalTokens(total))} token`}
    </span>
  )
}
