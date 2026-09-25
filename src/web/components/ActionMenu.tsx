import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface MenuAction { label: string; icon: IconName; run: () => void; disabled?: boolean; danger?: boolean; description?: string; /** Simgenin yerine çizilir (ör. ajan logosu). */ leading?: ReactNode; /** Sağda gösterilen kısayol. */ hint?: string; /** Öncesine ayırıcı çizgi. */ divider?: boolean }
export interface MenuPosition { x: number; y: number; origin: HTMLElement | null }

/** header: menünün başındaki tıklanamayan bilgi satırı (ör. oturumun projesi, işi, branch'i). */
export function ActionMenu({ position, actions, onClose, label = 'Oturum işlemleri', header }: { position: MenuPosition; actions: MenuAction[]; onClose: () => void; label?: string; header?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = ref.current!
    menu.style.left = `${Math.max(8, Math.min(position.x, innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(position.y, innerHeight - menu.offsetHeight - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) onClose() }
    const close = () => onClose()
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close) }
  }, [position, onClose])
  return createPortal(<div className="action-menu" role="menu" aria-label={label} ref={ref} onKeyDown={(e) => {
    e.stopPropagation()
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); position.origin?.focus() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index]?.focus()
    }
  }}>{header && <div className="action-menu-header" role="presentation">{header}</div>}{actions.map((action, index) => <button role="menuitem" key={index} disabled={action.disabled} className={[action.danger ? 'danger' : '', action.divider ? 'divider-before' : ''].join(' ').trim()} title={action.description} onClick={() => { onClose(); position.origin?.focus(); action.run() }}>{action.leading ?? <Icon name={action.icon} />}<span>{action.label}</span>{action.hint && <kbd className="menu-hint">{action.hint}</kbd>}</button>)}</div>, document.body)
}
