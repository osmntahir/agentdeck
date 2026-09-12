import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './prototype/grid/prototype-grid.css'
import { PrototypeSwitcher, useVariantParam } from './prototype/PrototypeSwitcher'
import { seedWorld } from './prototype/grid/mock'
import { StateDump, VARIANTS } from './prototype/grid/shared'
import { VariantA } from './prototype/grid/VariantA'
import { VariantB } from './prototype/grid/VariantB'
import { VariantC } from './prototype/grid/VariantC'
import { VariantD } from './prototype/grid/VariantD'
import type { World } from './prototype/grid/model'

// Four variants of the session overview, switchable via ?variant=,
// on throwaway /prototype-grid.html. D is the mix: left Project/Session list + center grid.

const KEYS = VARIANTS.map((v) => v.key)

function PrototypeGrid() {
  const [variant, setVariant] = useVariantParam(KEYS)
  const [world, setWorld] = useState<World>(seedWorld)
  const [selectedId, setSelectedId] = useState<string | null>('s-auth')
  const [daemonDown, setDaemonDown] = useState(false)

  const patchSelected = (fn: (w: World) => void) => {
    setWorld((prev) => {
      const next = structuredClone(prev)
      fn(next)
      return next
    })
  }

  return (
    <div className="pg-root">
      {daemonDown && (
        <div className="pg-banner">
          daemon yok — oturum kutusu değil, uygulama şeridi. Kutuların lifecycle’ı değişmez.
        </div>
      )}

      <div className="pg-harness">
        <strong>PROTOTYPE</strong>
        <span className="pg-note">
          ürün kodu değil · V0 anlamsal ajan durumu bilmez (thinking / waiting for user yok) · ← →
        </span>
        <button type="button" className={daemonDown ? 'on' : ''} onClick={() => setDaemonDown((v) => !v)}>
          daemon koptu
        </button>
        <button
          type="button"
          onClick={() =>
            patchSelected((w) => {
              w.now += 30_000
            })
          }
        >
          30 sn ileri
        </button>
        <button
          type="button"
          onClick={() =>
            patchSelected((w) => {
              const s = w.sessions.find((x) => x.id === selectedId)
              if (!s || s.lifecycle !== 'live') return
              s.lastActivity = w.now
              s.lines = [...s.lines, `PTY çıktı @ ${new Date(w.now).toISOString().slice(11, 19)}`]
            })
          }
        >
          seçilide çıktı
        </button>
        <button
          type="button"
          onClick={() =>
            patchSelected((w) => {
              const s = w.sessions.find((x) => x.id === selectedId)
              if (s) s.cwdMissing = true
            })
          }
        >
          cwd kaybolsun
        </button>
        <button
          type="button"
          onClick={() => {
            setWorld(seedWorld())
            setSelectedId('s-auth')
            setDaemonDown(false)
          }}
        >
          sıfırla
        </button>
      </div>

      <div className="pg-body">
        <div className="pg-stage">
          {variant === 'D' && <VariantD world={world} selectedId={selectedId} onSelect={setSelectedId} />}
          {variant === 'A' && <VariantA world={world} selectedId={selectedId} onSelect={setSelectedId} />}
          {variant === 'B' && <VariantB world={world} selectedId={selectedId} onSelect={setSelectedId} />}
          {variant === 'C' && <VariantC world={world} selectedId={selectedId} onSelect={setSelectedId} />}
        </div>
        <StateDump variant={variant} world={world} selectedId={selectedId} />
      </div>

      <PrototypeSwitcher variants={[...VARIANTS]} current={variant} onChange={setVariant} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<PrototypeGrid />)
