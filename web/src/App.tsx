import { Fragment, useCallback, useEffect, useState } from 'react'
import NewTaskModal from './NewTaskModal'
import ProjectsModal from './ProjectsModal'
import type { Project } from './ProjectsModal'
import FilterModal from './FilterModal'
import OpenByNumberModal from './OpenByNumberModal'
import SettingsModal from './SettingsModal'
import SyncModal from './SyncModal'
import TaskModal from './TaskModal'
import { applyTheme } from './theme'
import { EMPTY_FILTER, isFilterActive, matchesFilter } from './filter'
import type { Filter } from './filter'

type Health = 'checking' | 'ok' | 'ng'

type Task = {
  taskId: number
  title: string
  project: string
  status: string
  priority: string | null
  due: string | null
  repeat: string | null
  tags: string[]
  estimate: number | null
  parent: number | null
  order: number | null
  updated: string | null
  completed: string | null
  file: string
}

type CardFields = {
  priority: boolean
  due: boolean
  tags: boolean
  estimate: boolean
}

const DEFAULT_CARD_FIELDS: CardFields = { priority: true, due: true, tags: false, estimate: false }

const COLUMNS: { key: string; label: string }[] = [
  { key: 'icebox', label: 'IceBox' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'ready', label: 'Ready' },
  { key: 'inprogress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
]

// カラムごとの並べ替え（bismuth-44。タスク番号・更新日は bismuth-122 で追加）。設定はサーバのユーザー設定（cardFields と同じ場所）に保存する
type SortMode =
  | 'priority'
  | 'due'
  | 'project-asc'
  | 'project-desc'
  | 'manual'
  | 'completed-asc'
  | 'completed-desc'
  | 'id-asc'
  | 'id-desc'
  | 'updated-asc'
  | 'updated-desc'

// 並べ替えの UI は「種別」と「向き（昇順・降順）」の2つのプルダウンに分ける（bismuth-175）。
// 保存値は従来どおり SortMode 1つ（例: 'project-asc'）。向きを持たない種別（優先度・期限・手動）では向きのプルダウンを出さない
type SortKind = 'priority' | 'due' | 'project' | 'manual' | 'completed' | 'id' | 'updated'
type SortDir = 'asc' | 'desc'

const SORT_KINDS: { value: SortKind; label: string; directional: boolean }[] = [
  { value: 'priority', label: '優先度', directional: false },
  { value: 'due', label: '期限', directional: false },
  { value: 'project', label: 'プロジェクト', directional: true },
  { value: 'manual', label: '手動', directional: false },
  { value: 'completed', label: '完了日', directional: true },
  { value: 'id', label: 'タスク番号', directional: true },
  { value: 'updated', label: '更新日', directional: true },
]

function splitSortMode(mode: SortMode): { kind: SortKind; dir: SortDir | null } {
  const m = /^(.*)-(asc|desc)$/.exec(mode)
  return m ? { kind: m[1] as SortKind, dir: m[2] as SortDir } : { kind: mode as SortKind, dir: null }
}

// 種別を切り替えたときは直前の向きを引き継ぐ（向きを持たない種別からなら昇順）
function joinSortMode(kind: SortKind, dir: SortDir | null): SortMode {
  const directional = SORT_KINDS.find((k) => k.value === kind)?.directional ?? false
  return (directional ? `${kind}-${dir ?? 'asc'}` : kind) as SortMode
}

const DEFAULT_COLUMN_SORT: Record<string, SortMode> = Object.fromEntries(COLUMNS.map((c) => [c.key, 'priority'] as const))

// 見積時間の合計表示用。小数第1位までに丸め、末尾の 0 は削る（例: 3, 3.5）
function formatHours(n: number): string {
  return String(Math.round(n * 10) / 10)
}

// 優先度の高い順（P1 が上）。優先度なしは最後（Todoist と同じ扱い）
function priorityRank(p: string | null): number {
  const i = ['P1', 'P2', 'P3', 'P4'].indexOf(p ?? '')
  return i < 0 ? 99 : i
}

function byPriorityThenOrderThenId(a: Task, b: Task) {
  const ap = priorityRank(a.priority)
  const bp = priorityRank(b.priority)
  if (ap !== bp) return ap - bp
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  return ao !== bo ? ao - bo : a.taskId - b.taskId
}

// 手動: order の昇順。order なしは最後
function byManualOrder(a: Task, b: Task) {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  return ao !== bo ? ao - bo : a.taskId - b.taskId
}

// 日付文字列の比較。null（期限なし・完了日なし）は昇順・降順どちらでも最後に沈める
function compareDate(a: string | null, b: string | null, desc: boolean): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  const c = a < b ? -1 : a > b ? 1 : 0
  return desc ? -c : c
}

// 完了日。completed が無い旧 done ノートは updated（done にした日に一致）で代用する
function completedDate(t: Task): string | null {
  return t.completed ?? t.updated
}

function comparator(mode: SortMode): (a: Task, b: Task) => number {
  switch (mode) {
    case 'due':
      return (a, b) => compareDate(a.due, b.due, false) || byPriorityThenOrderThenId(a, b)
    case 'project-asc':
      return (a, b) => a.project.localeCompare(b.project) || byPriorityThenOrderThenId(a, b)
    case 'project-desc':
      return (a, b) => b.project.localeCompare(a.project) || byPriorityThenOrderThenId(a, b)
    case 'manual':
      return byManualOrder
    case 'completed-asc':
      return (a, b) => compareDate(completedDate(a), completedDate(b), false) || byPriorityThenOrderThenId(a, b)
    case 'completed-desc':
      return (a, b) => compareDate(completedDate(a), completedDate(b), true) || byPriorityThenOrderThenId(a, b)
    // タスク番号: task-id は一意なのでタイブレーク不要
    case 'id-asc':
      return (a, b) => a.taskId - b.taskId
    case 'id-desc':
      return (a, b) => b.taskId - a.taskId
    // 更新日: 時刻付き（bismuth-223）なら時刻順。同じ値どうしは既定（優先度→order→id）で安定させる。updated なしは昇順・降順とも最後
    case 'updated-asc':
      return (a, b) => compareDate(a.updated, b.updated, false) || byPriorityThenOrderThenId(a, b)
    case 'updated-desc':
      return (a, b) => compareDate(a.updated, b.updated, true) || byPriorityThenOrderThenId(a, b)
    default:
      return byPriorityThenOrderThenId
  }
}

function todayString(): string {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

export default function App() {
  const [health, setHealth] = useState<Health>('checking')
  // Todoist 取込が有効か（サーバの環境変数 BISMUTH_TODOIST=1 のときだけ。/api/health が返す）
  const [todoistEnabled, setTodoistEnabled] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [managingProjects, setManagingProjects] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [openByNo, setOpenByNo] = useState(false) // 番号でタスクを開くダイアログ（bismuth-121）
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [cardFields, setCardFields] = useState<CardFields>(DEFAULT_CARD_FIELDS)
  const [columnSort, setColumnSort] = useState<Record<string, SortMode>>(DEFAULT_COLUMN_SORT)
  const [doneHideAfterDays, setDoneHideAfterDays] = useState<number | null>(null) // 完了から N 日経過した done を非表示（bismuth-45）
  // 手動ソートのカラムで「どのカードの間に落とすか」（index はソート済みカード列の挿入位置）
  const [dropPos, setDropPos] = useState<{ col: string; index: number } | null>(null)
  const today = todayString()

  // アーカイブ済みプロジェクトのタスクはボード・フィルタの選択肢に出さない（bismuth-226）。
  // tasks 自体は削らないので、番号でタスクを開く（No）からはこれまでどおり開ける
  const archivedProjects = new Set(projects.filter((p) => p.archived).map((p) => p.id))
  const visibleTasks = tasks.filter((t) => !archivedProjects.has(t.project))

  // 完了から N 日経過した done タスクはボードに出さない（bismuth-45）。ノートの実体はそのまま・
  // tasks 自体も削らないので、番号でタスクを開く（No）などの検索はこれまで通り一致する
  function isHiddenDone(t: Task): boolean {
    if (doneHideAfterDays == null || t.status !== 'done') return false
    const d = completedDate(t) // completed が無い旧 done ノートは updated で代用（完了日ソートと同じ扱い）
    if (d == null) return false
    const b = new Date()
    b.setDate(b.getDate() - doneHideAfterDays)
    const m = String(b.getMonth() + 1).padStart(2, '0')
    const day = String(b.getDate()).padStart(2, '0')
    return d.slice(0, 10) <= `${b.getFullYear()}-${m}-${day}` // 時刻付き（bismuth-223）は日付部分で比べる
  }

  const loadTasks = useCallback(() => {
    fetch('/api/tasks')
      .then((r) => r.json())
      .then((d) => {
        setTasks(d.tasks ?? [])
        setWarnings(d.warnings ?? [])
      })
      .catch(() => setTasks([]))
  }, [])

  const loadProjects = useCallback(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]))
  }, [])

  const loadSettings = useCallback(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d.settings?.cardFields) setCardFields(d.settings.cardFields)
        if (d.settings?.columnSort) setColumnSort({ ...DEFAULT_COLUMN_SORT, ...d.settings.columnSort })
        setDoneHideAfterDays(d.settings?.doneHideAfterDays ?? null)
        applyTheme(d.settings?.theme ?? 'dark')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => {
        setHealth(d.status === 'ok' ? 'ok' : 'ng')
        setTodoistEnabled(d.features?.todoist === true)
      })
      .catch(() => setHealth('ng'))
    loadTasks()
    loadProjects()
    loadSettings()
  }, [loadTasks, loadProjects, loadSettings])

  async function moveTask(taskId: number, status: string) {
    const task = tasks.find((t) => t.taskId === taskId)
    if (!task || task.status === status) return
    // 楽観更新してから PATCH。失敗したら再読込で巻き戻す
    setTasks((prev) => prev.map((t) => (t.taskId === taskId ? { ...t, status } : t)))
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } finally {
      loadTasks()
    }
  }

  // カラムの並べ替えを変更し、ユーザー設定（サーバ）に保存する
  function changeColumnSort(col: string, mode: SortMode) {
    const next = { ...columnSort, [col]: mode }
    setColumnSort(next)
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnSort: next }),
    }).catch(() => {
      // 保存に失敗しても表示は維持する（次回起動時に元へ戻るだけ）
    })
  }

  // 手動ソートのカラムへのドロップ。index はソート済みカード列（ドラッグ中のカード込み）の挿入位置。
  // 隣接カードの order の中間値を割り当ててドラッグしたカード1枚だけを書き換える。
  // 中間値が作れない（order 未設定のカードが混ざる等）ときだけカラム全体を振り直す
  async function dropManual(taskId: number, col: string, index: number) {
    const task = tasks.find((t) => t.taskId === taskId)
    if (!task) return
    const rendered = visibleTasks
      .filter((t) => matchesFilter(t, filter) && t.status === col)
      .sort(byManualOrder)
    const selfIdx = rendered.findIndex((t) => t.taskId === taskId)
    const others = rendered.filter((t) => t.taskId !== taskId)
    let at = selfIdx >= 0 && index > selfIdx ? index - 1 : index
    at = Math.max(0, Math.min(at, others.length))
    if (selfIdx >= 0 && at === selfIdx) return // 位置が変わらない

    const prev = at > 0 ? others[at - 1] : null
    const next = at < others.length ? others[at] : null
    let newOrder: number | null = null
    if (!prev && !next) newOrder = 10
    else if (!prev && next && next.order != null) newOrder = next.order - 10
    else if (prev && prev.order != null && !next) newOrder = prev.order + 10
    else if (prev?.order != null && next?.order != null && next.order - prev.order > 1e-9)
      newOrder = (prev.order + next.order) / 2

    const statusPatch = task.status !== col ? { status: col } : {}
    try {
      if (newOrder != null) {
        setTasks((p) => p.map((t) => (t.taskId === taskId ? { ...t, ...statusPatch, order: newOrder } : t)))
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...statusPatch, order: newOrder }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } else {
        // 振り直し: 並べ替え後のカラム全体に 10, 20, 30… を割り当て、変わったカードだけ PATCH
        const arranged = [...others.slice(0, at), task, ...others.slice(at)]
        const updates = arranged
          .map((t, i) => ({ t, order: (i + 1) * 10 }))
          .filter(({ t, order }) => t.order !== order || t.taskId === taskId)
        setTasks((p) =>
          p.map((t) => {
            const u = updates.find((x) => x.t.taskId === t.taskId)
            return u ? { ...t, ...(t.taskId === taskId ? statusPatch : {}), order: u.order } : t
          }),
        )
        for (const { t, order } of updates) {
          const res = await fetch(`/api/tasks/${t.taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t.taskId === taskId ? { ...statusPatch, order } : { order }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
        }
      }
    } finally {
      loadTasks()
    }
  }

  // フィルタ適用後のタスクと、プルダウンの選択肢
  const filtered = visibleTasks.filter((t) => matchesFilter(t, filter))
  const activeProjects = projects.filter((p) => !p.archived).map((p) => p.id)
  const allProjects = Array.from(new Set([...activeProjects, ...visibleTasks.map((t) => t.project)])).sort((a, b) =>
    a.localeCompare(b),
  )
  const projectOptions = allProjects.map((id) => ({ value: id, label: id }))
  const tagOptions = Array.from(new Set(visibleTasks.flatMap((t) => t.tags)))
    .sort((a, b) => a.localeCompare(b))
    .map((t) => ({ value: t, label: t }))

  return (
    <div className="app">
      <header className="header">
        <h1>Bismuth</h1>
        <span className={`health health-${health}`}>
          {health === 'ok' ? 'server: ok' : health === 'checking' ? '…' : 'server: 接続不可'}
        </span>
        <span className="header-spacer" />
        {todoistEnabled && (
          <button className="btn" onClick={() => setSyncing(true)}>
            Todoist 同期
          </button>
        )}
        <button className="btn" onClick={() => setManagingProjects(true)}>
          プロジェクト
        </button>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          ＋ 新規タスク
        </button>
        <button className="btn btn-icon" title="更新" aria-label="更新" onClick={loadTasks}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 2.5a5.49 5.49 0 0 0-4.13 1.87l1.2 1.2A.25.25 0 0 1 4.9 6H1.25A.25.25 0 0 1 1 5.75V2.1a.25.25 0 0 1 .43-.17l1.38 1.38A7 7 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.18A5.5 5.5 0 0 0 8 2.5Zm-6.3 5.5a.75.75 0 0 1 .84.66 5.5 5.5 0 0 0 9.59 2.97l-1.2-1.2a.25.25 0 0 1 .17-.43h3.65a.25.25 0 0 1 .25.25v3.65a.25.25 0 0 1-.43.17l-1.38-1.38A7 7 0 0 1 1.05 8.84.75.75 0 0 1 1.7 8Z"
            />
          </svg>
        </button>
        <button
          className="btn btn-icon"
          title="番号でタスクを開く"
          aria-label="番号でタスクを開く"
          onClick={() => setOpenByNo(true)}
        >
          No
        </button>
        <button
          className={isFilterActive(filter) ? 'btn btn-icon btn-icon-active' : 'btn btn-icon'}
          title="フィルタ"
          aria-label="フィルタ"
          onClick={() => setFilterOpen(true)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M1.5 2h13a.5.5 0 0 1 .38.83L10 8.7V13a.5.5 0 0 1-.72.45l-2.5-1.25A.5.5 0 0 1 6.5 11.7V8.7L1.12 2.83A.5.5 0 0 1 1.5 2Z"
            />
          </svg>
        </button>
        <button className="btn btn-icon" title="設定" aria-label="設定" onClick={() => setSettingsOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              d="M1.5 3.5h1.75M6.75 3.5h7.75M1.5 8h7.75M12.75 8h1.75M1.5 12.5h3.25M8.25 12.5h6.25"
            />
            <circle cx="5" cy="3.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="11" cy="8" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="6.5" cy="12.5" r="1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </header>
      {warnings.length > 0 && (
        <div className="warnings">
          {warnings.map((w) => (
            <p key={w}>⚠ {w}</p>
          ))}
        </div>
      )}
      <main className="board">
        {COLUMNS.map(({ key, label }) => {
          const sortMode = columnSort[key] ?? 'priority'
          const manual = sortMode === 'manual'
          const { kind: sortKind, dir: sortDir } = splitSortMode(sortMode)
          const cards = filtered.filter((t) => t.status === key && !isHiddenDone(t)).sort(comparator(sortMode))
          const estimateTotal =
            key === 'backlog' ? cards.reduce((sum, t) => sum + (t.estimate ?? 0), 0) : 0
          return (
            <section
              key={key}
              className={dragOver === key ? 'column column-dragover' : 'column'}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(key)
                // カード上は各カードのハンドラが位置を決める（stopPropagation）。ここに来るのは余白＝末尾
                if (manual) setDropPos((cur) => (cur?.col === key && cur.index === cards.length ? cur : { col: key, index: cards.length }))
              }}
              onDragLeave={() => {
                setDragOver((cur) => (cur === key ? null : cur))
                setDropPos((cur) => (cur?.col === key ? null : cur))
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                const pos = dropPos
                setDropPos(null)
                const id = Number(e.dataTransfer.getData('text/plain'))
                if (!Number.isFinite(id)) return
                if (manual) void dropManual(id, key, pos && pos.col === key ? pos.index : cards.length)
                else void moveTask(id, key)
              }}
            >
              <h2>
                {label}
                {cards.length > 0 && <span className="count">{cards.length}</span>}
                {estimateTotal > 0 && <span className="count">⏱ {formatHours(estimateTotal)}h</span>}
                <span className="sort-controls">
                  <select
                    className="sort-select"
                    title="並べ替え"
                    aria-label={`${label} の並べ替え`}
                    value={sortKind}
                    onChange={(e) => changeColumnSort(key, joinSortMode(e.target.value as SortKind, sortDir))}
                  >
                    {SORT_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  {sortDir != null && (
                    <select
                      className="sort-select"
                      title="昇順・降順"
                      aria-label={`${label} の昇順・降順`}
                      value={sortDir}
                      onChange={(e) => changeColumnSort(key, joinSortMode(sortKind, e.target.value as SortDir))}
                    >
                      <option value="asc">昇順</option>
                      <option value="desc">降順</option>
                    </select>
                  )}
                </span>
              </h2>
              {cards.length === 0 && <p className="empty">タスクなし</p>}
              {cards.map((t, cardIndex) => {
                const overdue = t.due != null && t.due < today && t.status !== 'done'
                // タイトル下に出す項目（左から 優先度 → 期限 → タグ → 見積）
                const showPriority = cardFields.priority && !!t.priority
                const showDue = cardFields.due && !!t.due
                const showTags = cardFields.tags && t.tags.length > 0
                const showEstimate = cardFields.estimate && t.estimate != null
                const showFields = showPriority || showDue || showTags || showEstimate
                return (
                  <Fragment key={t.taskId}>
                  {manual && dropPos?.col === key && dropPos.index === cardIndex && <div className="drop-line" />}
                  <article
                    className="card card-clickable"
                    title={t.file}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.taskId))}
                    onDragOver={(e) => {
                      // 手動ソート時のみ「カードの間に差し込む」。上半分なら自分の前、下半分なら後ろ
                      if (!manual) return
                      e.preventDefault()
                      e.stopPropagation()
                      setDragOver(key)
                      const r = e.currentTarget.getBoundingClientRect()
                      const idx = e.clientY < r.top + r.height / 2 ? cardIndex : cardIndex + 1
                      setDropPos((cur) => (cur?.col === key && cur.index === idx ? cur : { col: key, index: idx }))
                    }}
                    onClick={() => setSelected(t.taskId)}
                  >
                    <div className="card-head">
                      <span className="card-id">
                        {t.project}-{t.taskId}
                      </span>
                    </div>
                    <div className="card-title">
                      {t.title}
                      {t.repeat && (
                        <span className="card-repeat" title="繰り返しタスク">
                          {' '}
                          ↻
                        </span>
                      )}
                    </div>
                    {showFields && (
                      <div className="card-fields">
                        {/* 優先度なしは何も出さない（Todoist 準拠） */}
                        {showPriority && <span className={`prio prio-${t.priority}`}>{t.priority}</span>}
                        {showDue && (
                          <span className={overdue ? 'due due-over' : 'due'}>
                            {overdue ? '⚠ ' : ''}
                            {t.due}
                          </span>
                        )}
                        {showTags && (
                          <span className="card-tags">
                            {t.tags.map((tag) => (
                              <span key={tag} className="card-tag">
                                #{tag}
                              </span>
                            ))}
                          </span>
                        )}
                        {showEstimate && <span className="card-est">⏱ {t.estimate}h</span>}
                      </div>
                    )}
                  </article>
                  </Fragment>
                )
              })}
              {manual && dropPos?.col === key && dropPos.index === cards.length && <div className="drop-line" />}
            </section>
          )
        })}
      </main>
      {selected != null && (
        <TaskModal taskId={selected} onClose={() => setSelected(null)} onUpdated={loadTasks} />
      )}
      {creating && (
        <NewTaskModal
          projects={activeProjects}
          onClose={() => setCreating(false)}
          onCreated={(taskId) => {
            setCreating(false)
            loadTasks()
            loadProjects() // 未登録プロジェクトで起票された場合に備えて読み直す
            setSelected(taskId)
          }}
        />
      )}
      {managingProjects && (
        <ProjectsModal
          todoist={todoistEnabled}
          onClose={() => setManagingProjects(false)}
          onChanged={() => {
            loadProjects()
            loadTasks() // 削除でタスクフォルダも trash へ移るため、フィルタの選択肢を古い tasks で汚さないよう再読込
          }}
        />
      )}
      {syncing && <SyncModal onClose={() => setSyncing(false)} onImported={loadTasks} />}
      {openByNo && (
        <OpenByNumberModal
          taskIds={tasks.map((t) => t.taskId)}
          onOpen={(taskId) => {
            setOpenByNo(false)
            setSelected(taskId)
          }}
          onClose={() => setOpenByNo(false)}
        />
      )}
      {filterOpen && (
        <FilterModal
          filter={filter}
          onChange={setFilter}
          projectOptions={projectOptions}
          tagOptions={tagOptions}
          matchedCount={filtered.length}
          totalCount={visibleTasks.length}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            loadTasks()
            loadProjects()
            loadSettings()
          }}
        />
      )}
    </div>
  )
}
