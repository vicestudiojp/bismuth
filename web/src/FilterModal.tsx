import { useEffect, useRef, useState } from 'react'
import type { DueFilter, Filter } from './filter'
import { DUE_OPTIONS, EMPTY_FILTER, PRIORITY_OPTIONS } from './filter'

type Option = { value: string; label: string }

// プルダウン方式の複数選択。ボタンを押すとチェックボックスのパネルが開く。外側クリックで閉じる
function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = 'すべて',
}: {
  options: Option[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])

  const summary =
    selected.length === 0
      ? placeholder
      : options
          .filter((o) => selected.includes(o.value))
          .map((o) => o.label)
          .join(', ')

  return (
    <div className="ms" ref={ref}>
      <button type="button" className="ms-button" onClick={() => setOpen((o) => !o)}>
        <span className={selected.length === 0 ? 'ms-summary ms-summary-empty' : 'ms-summary'}>{summary}</span>
        <span className="ms-caret">▾</span>
      </button>
      {open && (
        <div className="ms-panel">
          {options.length === 0 && <div className="ms-empty">項目なし</div>}
          {options.map((o) => (
            <label key={o.value} className="ms-option">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FilterModal({
  filter,
  onChange,
  projectOptions,
  tagOptions,
  matchedCount,
  totalCount,
  onClose,
}: {
  filter: Filter
  onChange: (next: Filter) => void
  projectOptions: Option[]
  tagOptions: Option[]
  matchedCount: number
  totalCount: number
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">フィルタ</h2>

        <div className="filter-form">
          <div className="filter-row">
            <span className="filter-label">プロジェクト</span>
            <MultiSelect
              options={projectOptions}
              selected={filter.projects}
              onChange={(projects) => onChange({ ...filter, projects })}
            />
          </div>
          <div className="filter-row">
            <span className="filter-label">優先度</span>
            <MultiSelect
              options={PRIORITY_OPTIONS}
              selected={filter.priorities}
              onChange={(priorities) => onChange({ ...filter, priorities })}
            />
          </div>
          <div className="filter-row">
            <span className="filter-label">タグ</span>
            <MultiSelect
              options={tagOptions}
              selected={filter.tags}
              onChange={(tags) => onChange({ ...filter, tags })}
            />
          </div>
          <div className="filter-row">
            <span className="filter-label">期限</span>
            <select
              className="filter-select"
              value={filter.due}
              onChange={(e) => onChange({ ...filter, due: e.target.value as DueFilter })}
            >
              {DUE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="filter-foot">
          <span className="filter-count">
            該当: {matchedCount} / {totalCount} 件
          </span>
          <button className="btn btn-small" onClick={() => onChange({ ...EMPTY_FILTER })}>
            クリア
          </button>
        </div>
        <p className="form-hint">複数選択はいずれかに一致（OR）。項目間は AND。変更は即座に一覧へ反映されます。</p>
      </div>
    </div>
  )
}
