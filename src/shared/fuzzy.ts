/**
 * Komut paleti eşleşmesi. Sorgu boşlukla parçalanır; her parça metinde ya
 * doğrudan ya da harf sırası korunarak geçmelidir. Doğrudan, kelime başı ve
 * ardışık eşleşme daha yüksek puan alır. Eşleşme yoksa null döner.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const haystack = text.toLocaleLowerCase('tr')
  let total = 0
  for (const token of query.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean)) {
    const score = tokenScore(token, haystack)
    if (score === null) return null
    total += score
  }
  return total
}

const BOUNDARY = /[\s/\\\-_.·:]/

function tokenScore(token: string, haystack: string): number | null {
  const direct = haystack.indexOf(token)
  if (direct >= 0) {
    const atWord = direct === 0 || BOUNDARY.test(haystack[direct - 1]!)
    return 100 + token.length * 4 + (atWord ? 40 : 0) - Math.min(direct, 30)
  }
  let from = 0
  let score = 0
  let streak = 0
  for (const char of token) {
    const index = haystack.indexOf(char, from)
    if (index < 0) return null
    streak = index === from ? streak + 1 : 0
    score += 1 + streak * 2 + (index === 0 || BOUNDARY.test(haystack[index - 1]!) ? 4 : 0)
    from = index + 1
  }
  return score
}
