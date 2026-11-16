import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type CardMenuItem = {
  label: string
  onSelect: () => void
  danger?: boolean
  separatorBefore?: boolean // この項目の上に区切り線を引く
}

// カードの右クリックメニュー（bismuth-302）。見た目はプロジェクトの「…」メニューと共通。
// マウスの位置に出し、画面からはみ出す分は内側へ寄せる。外側のクリック、Esc、Tab、スクロール、
// 画面サイズの変更、ウィンドウの切り替えで閉じる。上下キーで項目を移り、Enter で選ぶ
export default function CardMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number
  y: number
  label: string
  items: CardMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 4
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - r.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - r.height - margin)),
    })
    // 項目ではなくメニュー自体にフォーカスする（マウスで開いたときに先頭の項目が選択中に見えないように）
    el.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      if (buttons.length === 0) return
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : i <= 0 ? buttons.length - 1 : i - 1
      buttons[next].focus()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true) // 列の中のスクロールも拾う
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="row-menu-panel card-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore && <div className="card-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={item.danger ? 'row-menu-item row-menu-danger' : 'row-menu-item'}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
