import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export interface MenuAction { label: string; icon: IconName; run: () => void; disabled?: boolean; danger?: boolean; description?: string }
export interface MenuPosition { x: number; y: number; origin: HTMLElement | null }

export function ActionMenu({ position, actions, onClose }: { position: MenuPosition; actions: MenuAction[]; onClose: () => void }) {
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
  return createPortal(<div className="action-menu" role="menu" aria-label="Oturum işlemleri" ref={ref} onKeyDown={(e) => {
    e.stopPropagation()
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); position.origin?.focus() }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[index]?.focus()
    }
  }}>{actions.map((action, index) => <button role="menuitem" key={index} disabled={action.disabled} className={action.danger ? 'danger' : ''} title={action.description} onClick={() => { onClose(); position.origin?.focus(); action.run() }}><Icon name={action.icon} /><span>{action.label}</span></button>)}</div>, document.body)
}
