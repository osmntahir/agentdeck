import { useEffect, useState } from 'react'

interface Props {
  variants: { key: string; name: string }[]
  current: string
  onChange: (key: string) => void
}

/** Sabit alt bar — tasarımın parçası değil. Üretimde yok. */
export function PrototypeSwitcher({ variants, current, onChange }: Props) {
  if (import.meta.env.PROD) return null

  const i = Math.max(0, variants.findIndex((v) => v.key === current))
  const go = (dir: number) => {
    const next = variants[(i + dir + variants.length) % variants.length]
    onChange(next.key)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const idx = Math.max(0, variants.findIndex((v) => v.key === current))
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      const next = variants[(idx + dir + variants.length) % variants.length]
      onChange(next.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, variants, onChange])

  const label = variants[i]

  return (
    <div className="pg-switcher">
      <button type="button" onClick={() => go(-1)} aria-label="önceki varyant">
        ←
      </button>
      <span>
        {label?.key} — {label?.name}
      </span>
      <button type="button" onClick={() => go(1)} aria-label="sonraki varyant">
        →
      </button>
    </div>
  )
}

export function useVariantParam(keys: string[]): [string, (key: string) => void] {
  const [variant, setVariant] = useState(() => readVariant(keys))

  const set = (key: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', key)
    history.replaceState(null, '', url)
    setVariant(key)
  }

  useEffect(() => {
    const onPop = () => setVariant(readVariant(keys))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [keys])

  return [variant, set]
}

function readVariant(keys: string[]): string {
  const v = new URLSearchParams(window.location.search).get('variant') ?? keys[0]
  return keys.includes(v) ? v : keys[0]
}
