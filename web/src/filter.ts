// 一覧フィルタの判定ロジック（純粋関数）。App から使い、日付計算をテストしやすいよう now を引数で受ける。

export type DueFilter =
  | 'all'
  | 'none'
  | 'today'
  | 'tomorrow'
  | '3days'
  | '1week'
  | '2weeks'
  | '1month'
  | '2months'
  | '1year'
  | '2years'

export type Filter = {
  projects: string[] // 空 = すべて。含まれるプロジェクトのみ
  priorities: string[] // 空 = すべて。P1〜P4 と 'none'（優先度なし）
  tags: string[] // 空 = すべて。いずれかのタグを持つ（OR）
  due: DueFilter // 単一選択
}

export const EMPTY_FILTER: Filter = { projects: [], priorities: [], tags: [], due: 'all' }

export type FilterableTask = {
  project: string
  priority: string | null
  tags: string[]
  due: string | null // YYYY-MM-DD or null
}

// プルダウンの選択肢（期限は単一選択）
export const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'none', label: '期限なし' },
  { value: 'today', label: '今日' },
  { value: 'tomorrow', label: '明日以内' },
  { value: '3days', label: '3日以内' },
  { value: '1week', label: '1週間以内' },
  { value: '2weeks', label: '2週間以内' },
  { value: '1month', label: '1ヶ月以内' },
  { value: '2months', label: '2ヶ月以内' },
  { value: '1year', label: '1年以内' },
  { value: '2years', label: '2年以内' },
]

export const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
  { value: 'P4', label: 'P4' },
  { value: 'none', label: 'なし' },
]

function fmtDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 「N以内」の境界日（今日からの相対）。'all'/'none' は境界なしで null を返す
export function dueBoundary(f: DueFilter, now: Date = new Date()): string | null {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()) // 時刻を落とす
  switch (f) {
    case 'today':
      break
    case 'tomorrow':
      d.setDate(d.getDate() + 1)
      break
    case '3days':
      d.setDate(d.getDate() + 3)
      break
    case '1week':
      d.setDate(d.getDate() + 7)
      break
    case '2weeks':
      d.setDate(d.getDate() + 14)
      break
    case '1month':
      d.setMonth(d.getMonth() + 1)
      break
    case '2months':
      d.setMonth(d.getMonth() + 2)
      break
    case '1year':
      d.setFullYear(d.getFullYear() + 1)
      break
    case '2years':
      d.setFullYear(d.getFullYear() + 2)
      break
    default:
      return null // all / none
  }
  return fmtDate(d)
}

// 期限フィルタ。「N以内」は期限日 <= 境界日（期限切れも含む）。期限なしタスクは 'none'/'all' のみ一致
export function matchesDue(due: string | null, f: DueFilter, now: Date = new Date()): boolean {
  if (f === 'all') return true
  if (f === 'none') return due == null
  if (due == null) return false
  const boundary = dueBoundary(f, now)
  return boundary != null && due <= boundary
}

export function matchesFilter(t: FilterableTask, f: Filter, now: Date = new Date()): boolean {
  if (f.projects.length > 0 && !f.projects.includes(t.project)) return false
  if (f.priorities.length > 0 && !f.priorities.includes(t.priority ?? 'none')) return false
  if (f.tags.length > 0 && !f.tags.some((tag) => t.tags.includes(tag))) return false
  if (!matchesDue(t.due, f.due, now)) return false
  return true
}

export function isFilterActive(f: Filter): boolean {
  return f.projects.length > 0 || f.priorities.length > 0 || f.tags.length > 0 || f.due !== 'all'
}
