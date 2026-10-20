// 繰り返しタスクのルール（frontmatter の repeat）。ノートを使い回し、done にしたら期限を次回へ進めて backlog に戻す（bismuth-191）。
// 書式は Obsidian で手書きしても読める短い文字列にする:
//   daily / weekly / biweekly / monthly / weekly:mon,thu（曜日指定）/ every:3d（N 日ごと）
// 日付は YYYY-MM-DD 文字列のまま扱い、UTC の暦で計算する（タイムゾーンによる 1 日ずれを避ける）

export type RepeatRule =
  | { kind: 'daily' }
  | { kind: 'weekly' }
  | { kind: 'biweekly' }
  | { kind: 'monthly' }
  | { kind: 'weekdays'; days: number[] } // 0 = 日曜
  | { kind: 'every'; days: number }

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

export const REPEAT_FORMAT_MESSAGE =
  '繰り返しは daily / weekly / biweekly / monthly / weekly:mon,thu / every:3d の形式で指定してください'

// 書式に合わなければ null（空・未設定も null＝繰り返さない）
export function parseRepeat(value: string | null | undefined): RepeatRule | null {
  const s = (value ?? '').trim().toLowerCase()
  if (s === 'daily' || s === 'weekly' || s === 'biweekly' || s === 'monthly') return { kind: s }
  const wd = /^weekly:([a-z,\s]+)$/.exec(s)
  if (wd) {
    const names = wd[1].split(',').map((x) => x.trim()).filter(Boolean)
    const days = names.map((n) => (WEEKDAYS as readonly string[]).indexOf(n))
    if (days.length === 0 || days.some((d) => d < 0)) return null
    return { kind: 'weekdays', days: [...new Set(days)].sort((a, b) => a - b) }
  }
  const ev = /^every:(\d+)d$/.exec(s)
  if (ev && Number(ev[1]) >= 1) return { kind: 'every', days: Number(ev[1]) }
  return null
}

// 保存用の正規形（曜日は日曜始まりの順に並べ直す）
export function formatRepeat(rule: RepeatRule): string {
  if (rule.kind === 'weekdays') return `weekly:${rule.days.map((d) => WEEKDAYS[d]).join(',')}`
  if (rule.kind === 'every') return `every:${rule.days}d`
  return rule.kind
}

// 入力値を検証して正規形にする。空・null は「繰り返さない」＝ null
export function normalizeRepeat(value: string | null | undefined): string | null {
  if (!(value ?? '').trim()) return null
  const rule = parseRepeat(value)
  if (!rule) throw new Error(REPEAT_FORMAT_MESSAGE)
  return formatRepeat(rule)
}

export function repeatLabel(rule: RepeatRule): string {
  switch (rule.kind) {
    case 'daily':
      return '毎日'
    case 'weekly':
      return '毎週'
    case 'biweekly':
      return '隔週'
    case 'monthly':
      return '毎月'
    case 'weekdays':
      return `毎週 ${rule.days.map((d) => WEEKDAY_LABELS[d]).join('・')}`
    case 'every':
      return `${rule.days} 日ごと`
  }
}

function toUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(date: string, n: number): string {
  const d = toUtc(date)
  d.setUTCDate(d.getUTCDate() + n)
  return fromUtc(d)
}

// 翌月の同日。その日が無い月は月末にする（1/31 → 2/28。以後は 28 日を引き継ぐ・Q-5）
function addMonth(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return fromUtc(new Date(Date.UTC(y, m, Math.min(d, lastDay))))
}

function step(rule: RepeatRule, date: string): string {
  switch (rule.kind) {
    case 'daily':
      return addDays(date, 1)
    case 'weekly':
      return addDays(date, 7)
    case 'biweekly':
      return addDays(date, 14)
    case 'monthly':
      return addMonth(date)
    case 'every':
      return addDays(date, rule.days)
    case 'weekdays': {
      // 翌日以降で最初に一致する曜日
      let next = date
      for (let i = 0; i < 7; i++) {
        next = addDays(next, 1)
        if (rule.days.includes(toUtc(next).getUTCDay())) return next
      }
      return next
    }
  }
}

// 次回期限。基準日は「期限があれば期限、無ければ今日（完了した日）」。
// 1 回進めても今日以前なら今日を越えるまで進める（溜めた回は消化させない・Q-1）
export function nextDue(rule: RepeatRule, due: string | null, today: string): string {
  let next = step(rule, due ?? today)
  while (next <= today) next = step(rule, next)
  return next
}
