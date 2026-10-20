import { useState } from 'react'

// 繰り返しルールの入力欄（新規作成・編集で共用）。書式はサーバの recurrence.ts と同じ:
//   daily / weekly / biweekly / monthly / weekly:mon,thu（曜日指定）/ every:3d（N 日ごと）
// 値は保存用の文字列で受け渡し、空文字＝繰り返さない

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

type Kind = '' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'weekdays' | 'every'

const KINDS: { value: Kind; label: string }[] = [
  { value: '', label: 'なし' },
  { value: 'daily', label: '毎日' },
  { value: 'weekly', label: '毎週' },
  { value: 'biweekly', label: '隔週' },
  { value: 'monthly', label: '毎月' },
  { value: 'weekdays', label: '曜日指定' },
  { value: 'every', label: 'N 日ごと' },
]

type Parsed = { kind: Kind; days: number[]; every: number } | null

function parse(value: string | null): Parsed {
  const s = (value ?? '').trim().toLowerCase()
  if (!s) return { kind: '', days: [], every: 3 }
  if (s === 'daily' || s === 'weekly' || s === 'biweekly' || s === 'monthly') return { kind: s, days: [], every: 3 }
  const wd = /^weekly:([a-z,\s]+)$/.exec(s)
  if (wd) {
    const days = wd[1].split(',').map((x) => WEEKDAYS.indexOf(x.trim()))
    if (days.length > 0 && days.every((d) => d >= 0)) return { kind: 'weekdays', days, every: 3 }
  }
  const ev = /^every:(\d+)d$/.exec(s)
  if (ev && Number(ev[1]) >= 1) return { kind: 'every', days: [], every: Number(ev[1]) }
  return null // 手書きの不正値
}

function format(kind: Kind, days: number[], every: number): string {
  if (kind === 'weekdays') return `weekly:${[...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(',')}`
  if (kind === 'every') return `every:${every}d`
  return kind
}

// 表示名（毎日・毎週 月・木・3 日ごと など）。書式に合わない値はそのまま返す
export function repeatLabel(value: string | null): string {
  const p = parse(value)
  if (!p) return `${value}（書式不正）`
  if (p.kind === 'weekdays') return `毎週 ${[...p.days].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join('・')}`
  if (p.kind === 'every') return `${p.every} 日ごと`
  return KINDS.find((k) => k.value === p.kind)!.label
}

export default function RepeatInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // 書式不正の値は「なし」から選び直してもらう（保存すると上書きされる）
  const initial = parse(value) ?? { kind: '' as Kind, days: [], every: 3 }
  const [kind, setKind] = useState<Kind>(initial.kind)
  const [days, setDays] = useState<number[]>(initial.days.length > 0 ? initial.days : [1])
  const [every, setEvery] = useState(initial.every)

  function update(k: Kind, d: number[], n: number) {
    setKind(k)
    setDays(d)
    setEvery(n)
    onChange(format(k, d, n))
  }

  function toggleDay(d: number) {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]
    if (next.length === 0) return // 曜日指定は 1 つ以上
    update(kind, next, every)
  }

  return (
    <div className="repeat-input">
      <label>
        繰り返し
        <select value={kind} onChange={(e) => update(e.target.value as Kind, days, every)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      {kind === 'weekdays' && (
        <div className="repeat-days">
          {WEEKDAY_LABELS.map((label, d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={days.includes(d)} onChange={() => toggleDay(d)} />
              {label}
            </label>
          ))}
        </div>
      )}
      {kind === 'every' && (
        <label className="repeat-every">
          間隔（日）
          <input
            type="number"
            min="1"
            step="1"
            value={every}
            onChange={(e) => {
              const n = Math.max(1, Math.floor(Number(e.target.value) || 1))
              update(kind, days, n)
            }}
          />
        </label>
      )}
      {kind !== '' && (
        <p className="form-hint">done にすると期限を次回へ進めて backlog に戻します（履歴はコメントに残ります）</p>
      )}
    </div>
  )
}
