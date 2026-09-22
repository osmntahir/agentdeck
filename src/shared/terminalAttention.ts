import type { TerminalAttention } from './types'

function visibleText(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
}

function conciseQuestion(line: string): string {
  const compact = line.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
}

/**
 * Ham terminal çıktısında yalnız eylem gerektiren, son ekrana yakın istemleri
 * tanır. Sessizlik veya normal model metni tek başına dikkat sayılmaz.
 */
export function terminalAttentionFromText(value: string): Omit<TerminalAttention, 'detectedAt'> | null {
  const lines = visibleText(value).split('\n').map((line) => line.trim()).filter(Boolean)
  const tail = lines.slice(-8).join('\n')

  const approval = [
    /\[[Yy]\/[Nn]\]/,
    /\((?:y\/n|yes\/no)\)/i,
    /\b(?:allow|approve|permission|grant access|proceed)\b[\s\S]{0,100}\?/i,
    /\b(?:do you want to|would you like to)\b[^\n]{0,160}\?/i,
    // Ajan CLI'larının numaralı seçim menüsü: ilk seçenek "Yes"/"Allow".
    /^[❯›>]\s*1\.\s*(?:yes|allow|approve|evet)\b/im,
    /\b(?:izin ver|onayla|devam edilsin mi|devam etmek istiyor musun)\b/i,
  ].some((pattern) => pattern.test(tail))
  if (approval) return { kind: 'approval', message: 'İzin veya onay bekliyor' }

  const last = lines.at(-1)
  if (last?.endsWith('?')) return { kind: 'question', message: conciseQuestion(last) }
  return null
}
