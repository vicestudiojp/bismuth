// Todoist 取込（Read 専用）の実地検証。
// 本番 vault・本番 DB・本物の Todoist には触れない。ミニ vault ＋ fetch をモックして検証する。
// 実行: npx tsx scripts/verify-todoist.ts
//
// 方針（F1 設計5章 ／ 2026-07-13 オーナー指示）:
// - 対象は projects の todoistProject が設定されているプロジェクトだけ
// - Todoist には一切書き込まない（このスクリプトも GET しか来ないことを確認する）
// - 重複防止は frontmatter の todoist-id。既取込はスキップ
// - 取込済みかつ Todoist 側で未完 → 掃除リスト（手で消すための一覧）
// - status は backlog 固定。priority は Todoist の p1〜p4 と同じ体系にマップ
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
process.env.TODOIST_API_TOKEN = 'dummy-token-for-verify'
fs.mkdirSync(path.join(vault, '_task'), { recursive: true })
fs.mkdirSync(path.join(vault, '.bismuth'), { recursive: true })
fs.writeFileSync(
  path.join(vault, '.bismuth', 'config.json'),
  JSON.stringify(
    {
      taskGlobs: ['_task/*/*.md'],
      projects: [
        { id: 'alpha', description: '', todoistProject: 'Alpha' },
        { id: 'beta', description: '', todoistProject: 'Beta' },
        { id: 'ghost', description: '', todoistProject: '存在しないプロジェクト' },
        { id: 'unmapped', description: '', todoistProject: '' }, // 対象外（Todoist 名なし）
      ],
    },
    null,
    2,
  ),
  'utf-8',
)

// --- Todoist API のモック（GET 以外が来たら落とす） ---
const calls: string[] = []
const TODOIST_PROJECTS = [
  { id: 'p-alpha', name: 'Alpha' },
  { id: 'p-beta', name: 'Beta' },
  { id: 'p-other', name: '900_Learning' },
]
const TODOIST_TASKS = [
  {
    id: 't-1',
    content: '【改善】個別の概算費用を見積',
    description: '見積の内訳を出す。\n## 見出しは概要に置けないので格下げされる',
    project_id: 'p-alpha',
    parent_id: null,
    due: { date: '2026-07-20' },
    labels: ['next'],
    priority: 4, // → P1
  },
  {
    id: 't-2',
    content: 'サブタスクの親',
    description: '',
    project_id: 'p-alpha',
    parent_id: null,
    due: null,
    labels: [],
    priority: 1, // → 優先度なし
  },
  { id: 't-2a', content: '子その1', description: '', project_id: 'p-alpha', parent_id: 't-2', due: null, labels: [], priority: 1 },
  { id: 't-2b', content: '子その2', description: '', project_id: 'p-alpha', parent_id: 't-2', due: null, labels: [], priority: 1 },
  {
    id: 't-3',
    content: '[TalkNews] GAE の PHP を 8.3 に',
    description: '',
    project_id: 'p-beta',
    parent_id: null,
    due: null,
    labels: [],
    priority: 3, // → P2
  },
  {
    id: 't-9',
    content: '対象外プロジェクトのタスク',
    description: '',
    project_id: 'p-other',
    parent_id: null,
    due: null,
    labels: [],
    priority: 1,
  },
]

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.split('?')[0]}`)
  if (method !== 'GET') throw new Error(`Todoist に書き込もうとしました: ${method} ${url}`)
  const body = url.includes('/projects') ? { results: TODOIST_PROJECTS } : { results: TODOIST_TASKS }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const { previewSync, runSync, todoistEnabled } = await import('../src/todoist.js')
const { scanTasks, getTask } = await import('../src/vault.js')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`PASS: ${name}`)
  } else {
    fail++
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1) プレビュー（ノートは書かない）
const preview = await previewSync(vault)
check('プレビュー: 対象プロジェクトのタスクだけ（900_Learning は入らない）', preview.imports.length === 3, JSON.stringify(preview.imports.map((i) => i.title)))
check('プレビュー: サブタスクは単独タスクにしない', !preview.imports.some((i) => i.title.startsWith('子その')))
check('プレビュー: サブタスクは親のチェックリストに入る', preview.imports.find((i) => i.title === 'サブタスクの親')?.subtasks.join(',') === '子その1,子その2')
check('プレビュー: Todoist 名が見つからないプロジェクトを報告', preview.projects.find((p) => p.project === 'ghost')?.found === false)
check('プレビュー: Todoist 名が未設定のプロジェクトは対象外', !preview.projects.some((p) => p.project === 'unmapped'))
check('プレビュー: ノートを書かない', (await scanTasks(vault)).length === 0)

const item = preview.imports.find((i) => i.todoistId === 't-1')!
check('マッピング: priority 4 → P1', item.priority === 'P1')
check('マッピング: due', item.due === '2026-07-20')
check('マッピング: labels → tags', item.tags.join(',') === 'next')
check('マッピング: priority 1 → 優先度なし', preview.imports.find((i) => i.todoistId === 't-2')?.priority === null)
check('マッピング: priority 3 → P2', preview.imports.find((i) => i.todoistId === 't-3')?.priority === 'P2')

// 2) 実行
const result = await runSync(vault)
check('取込: 3件（親タスクのみ）', result.imported.length === 3 && result.failed.length === 0, JSON.stringify(result.failed))

const tasks = await scanTasks(vault)
check('取込: ノートが作られる', tasks.length === 3)
check('取込: プロジェクトごとに振り分けられる', tasks.filter((t) => t.project === 'alpha').length === 2 && tasks.filter((t) => t.project === 'beta').length === 1)
check('取込: status は backlog 固定', tasks.every((t) => t.status === 'backlog'))
check('取込: todoist-id が記録される', tasks.every((t) => t.todoistId != null))
check('取込: 優先度が入る', tasks.find((t) => t.todoistId === 't-1')?.priority === 'P1')
check('取込: due・tags が入る', tasks.find((t) => t.todoistId === 't-1')?.due === '2026-07-20' && tasks.find((t) => t.todoistId === 't-1')?.tags.join(',') === 'next')
check(
  '取込: ラベル無しは空タグ（既定タグ [project, task] を付けない）',
  tasks.find((t) => t.todoistId === 't-2')?.tags.length === 0 && tasks.find((t) => t.todoistId === 't-3')?.tags.length === 0,
  JSON.stringify([tasks.find((t) => t.todoistId === 't-2')?.tags, tasks.find((t) => t.todoistId === 't-3')?.tags]),
)

const parent = await getTask(vault, tasks.find((t) => t.todoistId === 't-2')!.taskId)
check('取込: サブタスクがチェックリストになる', parent!.body.includes('- [ ] 子その1') && parent!.body.includes('- [ ] 子その2'))

const withDesc = await getTask(vault, tasks.find((t) => t.todoistId === 't-1')!.taskId)
check('取込: description → 概要', withDesc!.overview.includes('見積の内訳を出す。'))
check('取込: 概要の h2 は格下げされる（セクション構造を壊さない）', withDesc!.overview.includes('#### 見出しは概要に置けない') && !/^## /m.test(withDesc!.overview))

// 3) 冪等性（2回目は取り込まない）
const again = await runSync(vault)
check('再同期: 既取込はスキップ', again.imported.length === 0 && again.skipped === 3)
check('再同期: ノートは増えない', (await scanTasks(vault)).length === 3)

// 4) 掃除リスト（取込済みかつ Todoist 側で未完）
check('掃除リスト: 3件', again.cleanup.length === 3, JSON.stringify(again.cleanup))
check('掃除リスト: task-id と Todoist id が対応', again.cleanup.every((c) => c.taskId > 0 && c.todoistId.startsWith('t-')))

// 5) Todoist には書き込まない
check('Read 専用: GET しか呼ばない', calls.every((c) => c.startsWith('GET ')), calls.join(' / '))
check('Read 専用: /projects と /tasks だけ', [...new Set(calls)].every((c) => c.endsWith('/projects') || c.endsWith('/tasks')))

// 6) トークンが無いときは明示的に失敗する（黙って何もしない、にはしない）
delete process.env.TODOIST_API_TOKEN
const home = process.env.HOME
process.env.HOME = vault // ~/.config/todoist/token を無い状態にする
let tokenError = false
try {
  await previewSync(vault)
} catch (err) {
  tokenError = err instanceof Error && err.message.includes('トークン')
}
process.env.HOME = home
check('トークン未設定: エラーを返す', tokenError)

// 7) 有効化スイッチ（bismuth-175）: BISMUTH_TODOIST=1 のときだけ有効。未設定・他の値は無効
const savedFlag = process.env.BISMUTH_TODOIST
delete process.env.BISMUTH_TODOIST
check('有効化スイッチ: 未設定なら無効', todoistEnabled() === false)
process.env.BISMUTH_TODOIST = 'true'
check('有効化スイッチ: 1 以外は無効', todoistEnabled() === false)
process.env.BISMUTH_TODOIST = '1'
check('有効化スイッチ: 1 なら有効', todoistEnabled() === true)
if (savedFlag === undefined) delete process.env.BISMUTH_TODOIST
else process.env.BISMUTH_TODOIST = savedFlag

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
