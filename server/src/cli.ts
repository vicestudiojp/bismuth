// Bismuth CLI — vault を直読みしてタスク一覧を出す（サーバ不要・ヘッドレスで動く）。
// AI エージェントや人が web と同じ一覧をターミナルで見る／読むために使う。
//
// 使い方（リポジトリルートから）:
//   npm run cli                     # ボード表示（IceBox/Backlog/Ready/InProgress/Done）
//   npm run cli -- --list           # フラットな一覧
//   npm run cli -- --json           # JSON（他のツールが機械処理する用）
//   npm run cli -- --project alpha --status ready,inprogress --priority P1,P2 --due 1week --tag waiting
//   npm run cli -- --all            # アーカイブ済みプロジェクトのタスクも含める（既定は隠す）
//   npm run cli -- sync-todoist            # Todoist を取り込む（capture=inbox → Bismuth。BISMUTH_TODOIST=1 のときだけ）
//   npm run cli -- sync-todoist --preview  # 取り込み予定だけ表示（書き込まない）
//   npm run cli -- done bismuth-33 34      # タスクを完了にする（ID は project-N でも数字でも可）
//   npm run cli -- create --project alpha --title "日次レビュー" --due 2026-07-20 --repeat daily   # 繰り返しタスクを起票
//   npm run cli -- comment bismuth-33 "実施メモ" [--author 秘書]   # コメントを追記（書式は仕様どおり CLI が付ける）
//   npm run cli -- tag bismuth-33 --add ai-done --remove ai        # タグを付け外しする（カンマ区切りで複数可）
import { archivedProjectIds } from './projects.js'
import { applyLayout, resolveSettings } from './settings.js'
import { previewSync, runSync, todoistEnabled, TODOIST_DISABLED_MESSAGE } from './todoist.js'
import { addComment, createTask, scanTasks, updateTask, type NewTaskInput, type TaskCard } from './vault.js'

const COLUMNS: { key: string; label: string }[] = [
  { key: 'icebox', label: 'IceBox' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'ready', label: 'Ready' },
  { key: 'inprogress', label: 'InProgress' },
  { key: 'done', label: 'Done' },
]

// 位置引数は先頭を command、残りを args にする（`done bismuth-33 34` のように複数取れる）
function parseArgs(argv: string[]): {
  command: string
  args: string[]
  flags: Record<string, string>
  bools: Set<string>
} {
  const flags: Record<string, string> = {}
  const bools = new Set<string>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next != null && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        bools.add(key)
      }
    } else {
      positional.push(a)
    }
  }
  return { command: positional[0] ?? '', args: positional.slice(1), flags, bools }
}

// タスク ID の指定を解釈する。会話・一覧に出る `bismuth-33` でも、素の `33` でも受ける。
// project 付きで渡されたときは実データと突き合わせて、取り違え（別プロジェクトの同番号）を防ぐ
function parseTaskRef(ref: string): { taskId: number; project: string | null } | null {
  const s = ref.trim()
  if (/^\d+$/.test(s)) return { taskId: Number(s), project: null }
  const m = /^(.+?)-(\d+)$/.exec(s)
  return m ? { taskId: Number(m[2]), project: m[1] } : null
}

function priorityRank(p: string | null): number {
  const i = ['P1', 'P2', 'P3', 'P4'].indexOf(p ?? '')
  return i < 0 ? 99 : i
}

function byPriorityThenOrderThenId(a: TaskCard, b: TaskCard): number {
  const ap = priorityRank(a.priority)
  const bp = priorityRank(b.priority)
  if (ap !== bp) return ap - bp
  const ao = a.order ?? Number.MAX_SAFE_INTEGER
  const bo = b.order ?? Number.MAX_SAFE_INTEGER
  return ao !== bo ? ao - bo : a.taskId - b.taskId
}

function fmtDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 「N以内」の境界日（期限フィルタ）。web の filter.ts と同じ意味
function dueBoundary(f: string, now: Date): string | null {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days: Record<string, number> = { today: 0, tomorrow: 1, '3days': 3, '1week': 7, '2weeks': 14 }
  if (f in days) {
    d.setDate(d.getDate() + days[f])
    return fmtDate(d)
  }
  if (f === '1month') d.setMonth(d.getMonth() + 1)
  else if (f === '2months') d.setMonth(d.getMonth() + 2)
  else if (f === '1year') d.setFullYear(d.getFullYear() + 1)
  else if (f === '2years') d.setFullYear(d.getFullYear() + 2)
  else return null
  return fmtDate(d)
}

function matchesDue(due: string | null, f: string | undefined, now: Date): boolean {
  if (!f || f === 'all') return true
  if (f === 'none') return due == null
  if (due == null) return false
  const b = dueBoundary(f, now)
  return b != null && due <= b
}

function applyFilters(tasks: TaskCard[], flags: Record<string, string>, now: Date): TaskCard[] {
  let out = tasks
  const csv = (v: string) => new Set(v.split(',').map((s) => s.trim()).filter(Boolean))
  if (flags.project) {
    const set = csv(flags.project)
    out = out.filter((t) => set.has(t.project))
  }
  if (flags.status) {
    const set = csv(flags.status)
    out = out.filter((t) => set.has(t.status))
  }
  if (flags.priority) {
    const set = csv(flags.priority)
    out = out.filter((t) => set.has(t.priority ?? 'none'))
  }
  if (flags.tag) {
    const set = csv(flags.tag)
    out = out.filter((t) => t.tags.some((x) => set.has(x)))
  }
  if (flags.due) {
    out = out.filter((t) => matchesDue(t.due, flags.due, now))
  }
  return out
}

// 1タスク1行。例: alpha-5   [P1] タイトル ↻ (⚠07-18) #waiting ⏱2h（↻ = 繰り返し）
function line(t: TaskCard, today: string, idWidth: number): string {
  const id = `${t.project}-${t.taskId}`.padEnd(idWidth)
  const prio = t.priority ? `[${t.priority}] ` : ''
  const overdue = t.due != null && t.due < today && t.status !== 'done'
  const due = t.due ? ` (${overdue ? '⚠' : ''}${t.due})` : ''
  const tags = t.tags.length > 0 ? ` ${t.tags.map((x) => `#${x}`).join(' ')}` : ''
  const est = t.estimate != null ? ` ⏱${t.estimate}h` : ''
  const repeat = t.repeat ? ' ↻' : ''
  return `  ${id}  ${prio}${t.title}${repeat}${due}${tags}${est}`
}

function idWidthOf(tasks: TaskCard[]): number {
  return tasks.reduce((w, t) => Math.max(w, `${t.project}-${t.taskId}`.length), 0)
}

function renderBoard(tasks: TaskCard[], today: string): string {
  const width = idWidthOf(tasks)
  const out: string[] = []
  for (const { key, label } of COLUMNS) {
    const cards = tasks.filter((t) => t.status === key).sort(byPriorityThenOrderThenId)
    out.push(`\n## ${label} (${cards.length})`)
    if (cards.length === 0) out.push('  （なし）')
    else for (const t of cards) out.push(line(t, today, width))
  }
  // dropped（やらない）はカラムに無い。--status dropped で明示されて残ったときだけ末尾に出す（bismuth-179）
  const dropped = tasks.filter((t) => t.status === 'dropped').sort(byPriorityThenOrderThenId)
  if (dropped.length > 0) {
    out.push(`\n## Dropped (${dropped.length})`)
    for (const t of dropped) out.push(line(t, today, width))
  }
  return out.join('\n')
}

function renderList(tasks: TaskCard[], today: string): string {
  const width = idWidthOf(tasks)
  const order = COLUMNS.map((c) => c.key).concat('dropped')
  const sorted = [...tasks].sort((a, b) => {
    const sa = order.indexOf(a.status)
    const sb = order.indexOf(b.status)
    if (sa !== sb) return sa - sb
    return byPriorityThenOrderThenId(a, b)
  })
  return sorted.map((t) => `${t.status.padEnd(11)}${line(t, today, width)}`).join('\n')
}

async function main(): Promise<void> {
  const { command, args, flags, bools } = parseArgs(process.argv.slice(2))

  if (bools.has('help') || command === 'help') {
    console.log(
      [
        'Bismuth CLI — vault のタスク一覧（サーバ不要）',
        '',
        '  (既定)          ボード表示',
        '  --list          フラット一覧（dropped=やらない は --status dropped のときだけ出す）',
        '  --json          JSON 出力',
        '  --project <ids> / --status <s> / --priority <P1,none> / --due <1week> / --tag <t>（カンマ区切り）',
        '  --all           アーカイブ済みプロジェクトのタスクもボード・一覧に含める（--json は常に全件）',
        '  create --project <id> --title "..." [--status --priority --due --repeat --tags --estimate --body]   タスクを新規作成',
        '                  --repeat: daily / weekly / biweekly / monthly / weekly:mon,thu / every:3d',
        '  done <id...>    タスクを完了にする（例: done alpha-12 13。複数まとめて可。繰り返しタスクは次回期限で backlog に戻る）',
        '  comment <id> "本文" [--author 秘書]   コメントを追記（既定の書き手=秘書。見出し #〜### は本文に使えない）',
        '  tag <id> [--add a,b] [--remove c]   タグを付け外しする',
        ...(todoistEnabled() ? ['  sync-todoist [--preview]   Todoist を取り込む（capture=inbox → Bismuth）'] : []),
      ].join('\n'),
    )
    return
  }

  const settings = resolveSettings()
  applyLayout(settings)
  const vault = settings.root

  if (command === 'sync-todoist') {
    if (!todoistEnabled()) {
      console.error(TODOIST_DISABLED_MESSAGE)
      process.exit(1)
    }
    if (bools.has('preview')) {
      const p = await previewSync(vault)
      console.log(`取込予定: ${p.imports.length}件 / スキップ(取込済): ${p.skipped}件`)
      for (const i of p.imports) console.log(`  + ${i.project}: ${i.title}${i.tags.length ? ` #${i.tags.join(' #')}` : ''}`)
      if (p.cleanup.length) console.log(`\n掃除候補(Todoist側で未完のまま): ${p.cleanup.length}件`)
      return
    }
    const r = await runSync(vault)
    console.log(`取込: ${r.imported.length}件 / スキップ: ${r.skipped}件 / 失敗: ${r.failed.length}件`)
    for (const i of r.imported) console.log(`  + ${i.project}-${i.taskId} ${i.title}`)
    for (const f of r.failed) console.log(`  ! 失敗: ${f.title} — ${f.error}`)
    if (r.cleanup.length) console.log(`\n掃除候補(Todoist側で未完のまま): ${r.cleanup.length}件`)
    return
  }

  if (command === 'create' || command === 'add') {
    const title = flags.title
    const project = flags.project
    if (!title || !project) {
      console.error(
        'create には --title と --project が必要です。\n' +
          '例: bismuth-tasks cli create --project alpha --title "ログイン画面の不具合調査" ' +
          '[--status backlog --priority P2 --due 2026-07-20 --repeat weekly --tags a,b --estimate 2 --body "概要"]',
      )
      process.exit(1)
    }
    const input: NewTaskInput = { title, project }
    if (flags.status) input.status = flags.status
    if (flags.priority) input.priority = flags.priority
    if (flags.due) input.due = flags.due
    if (flags.repeat) input.repeat = flags.repeat
    if (flags.tags) input.tags = flags.tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (flags.estimate) {
      const est = Number(flags.estimate)
      if (Number.isFinite(est)) input.estimate = est
    }
    if (flags.body) input.body = flags.body
    const detail = await createTask(vault, input)
    console.log(`作成: ${detail.task.project}-${detail.task.taskId}  ${detail.task.title}`)
    console.log(`  ${detail.task.file}`)
    return
  }

  if (command === 'done') {
    if (args.length === 0) {
      console.error('done には完了にするタスクの ID が必要です。\n例: bismuth-tasks cli done alpha-12 13')
      process.exit(1)
    }
    const all = await scanTasks(vault)
    let failed = 0
    for (const ref of args) {
      const parsed = parseTaskRef(ref)
      if (!parsed) {
        console.error(`! ${ref}: ID は「alpha-12」か「12」の形式で指定してください`)
        failed++
        continue
      }
      const task = all.find((t) => t.taskId === parsed.taskId)
      if (!task) {
        console.error(`! ${ref}: task-id ${parsed.taskId} のタスクが見つかりません`)
        failed++
        continue
      }
      // 別プロジェクトの同番号を掴んでいないか確かめる（ID はグローバル通し番号なので取り違えが起きうる）
      if (parsed.project && parsed.project !== task.project) {
        console.error(`! ${ref}: task-id ${parsed.taskId} は ${task.project} のタスクです（${task.title}）`)
        failed++
        continue
      }
      if (task.status === 'done') {
        console.log(`- ${task.project}-${task.taskId}  ${task.title}（既に done）`)
        continue
      }
      const result = await updateTask(vault, task.taskId, { status: 'done' })
      if (result?.recurred) {
        console.log(
          `繰り返し: ${task.project}-${task.taskId}  ${task.title}（次回期限 ${result.recurred.to} で backlog に戻しました）`,
        )
      } else {
        console.log(`完了: ${task.project}-${task.taskId}  ${task.title}（${task.status} → done）`)
      }
    }
    if (failed > 0) process.exit(1)
    return
  }

  if (command === 'comment') {
    const ref = args[0]
    const body = args.slice(1).join(' ')
    if (!ref || !body.trim()) {
      console.error(
        'comment にはタスク ID と本文が必要です。\n' +
          '例: bismuth-tasks cli comment alpha-12 "実施内容のメモ" [--author "作業メモ"]',
      )
      process.exit(1)
    }
    const parsed = parseTaskRef(ref)
    if (!parsed) {
      console.error(`! ${ref}: ID は「alpha-12」か「12」の形式で指定してください`)
      process.exit(1)
    }
    const all = await scanTasks(vault)
    const task = all.find((t) => t.taskId === parsed.taskId)
    if (!task) {
      console.error(`! ${ref}: task-id ${parsed.taskId} のタスクが見つかりません`)
      process.exit(1)
    }
    // 別プロジェクトの同番号を掴んでいないか確かめる（done と同じ取り違え防止）
    if (parsed.project && parsed.project !== task.project) {
      console.error(`! ${ref}: task-id ${parsed.taskId} は ${task.project} のタスクです（${task.title}）`)
      process.exit(1)
    }
    // 書き手の既定は「秘書」（web 経由が「オーナー」名義。F1 設計 2.2 の書き手の値に合わせる）
    const author = flags.author ?? '秘書'
    const detail = await addComment(vault, task.taskId, { body, author })
    if (!detail) {
      console.error(`! ${ref}: タスクノートに書き込めませんでした`)
      process.exit(1)
    }
    const added = detail.comments[detail.comments.length - 1]
    console.log(`コメント追記: ${task.project}-${task.taskId}  ${task.title}`)
    console.log(`  ### ${added.at} — ${added.author}`)
    return
  }

  // タグの付け外し。無人実行（外部の自動化スクリプトなど）が ai → ai-done の付け替えに使う
  if (command === 'tag') {
    const ref = args[0]
    const csvList = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const add = csvList(flags.add)
    const remove = csvList(flags.remove)
    if (!ref || (add.length === 0 && remove.length === 0)) {
      console.error(
        'tag にはタスク ID と --add / --remove のどちらかが必要です。\n' +
          '例: bismuth-tasks cli tag alpha-24 --add ai-done --remove ai',
      )
      process.exit(1)
    }
    const parsed = parseTaskRef(ref)
    if (!parsed) {
      console.error(`! ${ref}: ID は「alpha-12」か「12」の形式で指定してください`)
      process.exit(1)
    }
    const all = await scanTasks(vault)
    const task = all.find((t) => t.taskId === parsed.taskId)
    if (!task) {
      console.error(`! ${ref}: task-id ${parsed.taskId} のタスクが見つかりません`)
      process.exit(1)
    }
    if (parsed.project && parsed.project !== task.project) {
      console.error(`! ${ref}: task-id ${parsed.taskId} は ${task.project} のタスクです（${task.title}）`)
      process.exit(1)
    }
    const removeSet = new Set(remove)
    const tags = task.tags.filter((t) => !removeSet.has(t))
    for (const t of add) if (!tags.includes(t)) tags.push(t)
    await updateTask(vault, task.taskId, { tags })
    console.log(`タグ更新: ${task.project}-${task.taskId}  ${task.title}`)
    console.log(`  ${task.tags.map((t) => `#${t}`).join(' ') || '（なし）'} → ${tags.map((t) => `#${t}`).join(' ') || '（なし）'}`)
    return
  }

  const now = new Date()
  const today = fmtDate(now)
  const all = await scanTasks(vault)
  const tasks = applyFilters(all, flags, now)

  if (bools.has('json')) {
    console.log(JSON.stringify(tasks, null, 2))
    return
  }

  // dropped（やらない）は web のボードと同じく既定では出さない。--status で明示したときだけ出す（bismuth-179）。
  // アーカイブ済みプロジェクトのタスクも web と同じく既定では出さず、--all で含める（bismuth-226）。
  // --json は機械処理用なので上で全件のまま返す
  const archived = bools.has('all') ? new Set<string>() : archivedProjectIds(vault)
  const unarchived = tasks.filter((t) => !archived.has(t.project))
  const shown = flags.status ? unarchived : unarchived.filter((t) => t.status !== 'dropped')
  const header = `# Bismuth タスク  (${shown.length}${shown.length !== all.length ? ` / 全${all.length}` : ''}件)  ${today}`
  // 隠したことに気づけるよう、除外した件数を末尾に添える
  const hidden = tasks.length - unarchived.length
  const footer = hidden > 0 ? `\n（アーカイブ済みプロジェクトの ${hidden} 件を除外。--all で表示）` : ''
  if (bools.has('list')) {
    console.log(`${header}\n`)
    console.log(shown.length ? renderList(shown, today) : '（該当なし）')
  } else {
    console.log(header)
    console.log(renderBoard(shown, today))
  }
  if (footer) console.log(footer)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
