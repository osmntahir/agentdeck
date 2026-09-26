/**
 * Konuşma araması için metin katlama (ADR 0023). Büyük/küçük harf ve Türkçe
 * işaretler yok sayılır: "gorev" "Görev"i, "istanbul" "İSTANBUL"u bulur.
 * Katlama karakter başına yapılır ve uzunluğu korur; katlanmış metindeki
 * konum özgün metinde de aynı parçayı gösterir.
 */
export function foldText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const lower = c.toLocaleLowerCase('tr')
    const base = lower.length === 1 ? lower.normalize('NFD')[0]! : c.toLowerCase()
    out += base === 'ı' ? 'i' : base.length === 1 ? base : c
  }
  return out
}

/** Sorgunun terimleri: boşlukla ayrılmış, katlanmış, tekrarsız; en çok 8. */
export function searchTerms(query: string): string[] {
  return [...new Set(foldText(query).split(/\s+/).filter((term) => term.length > 0))].slice(0, 8)
}

export interface Snippet {
  text: string
  ranges: Array<[number, number]>
}

/**
 * İlk eşleşmenin çevresinden kısa bir parça; eşleşen bütün terimler işaretlenir.
 * Satır sonları boşluğa döner, kesilen uçlara … eklenir.
 */
export function makeSnippet(text: string, folded: string, terms: string[], before = 48, after = 140): Snippet {
  let first = -1
  for (const term of terms) {
    const at = folded.indexOf(term)
    if (at >= 0 && (first < 0 || at < first)) first = at
  }
  const start = first <= before ? 0 : text.lastIndexOf(' ', first - before) + 1 || first - before
  const end = Math.min(text.length, Math.max(first, 0) + after)
  const lead = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const body = text.slice(start, end).replace(/\s/g, ' ')
  const foldedBody = folded.slice(start, end)
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let at = foldedBody.indexOf(term)
    while (at >= 0) {
      ranges.push([lead.length + at, lead.length + at + term.length])
      at = foldedBody.indexOf(term, at + term.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return { text: `${lead}${body}${tail}`, ranges: merged }
}
