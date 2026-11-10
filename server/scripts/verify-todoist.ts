// Todoist 取込の実地検証。
// 本番 vault・本番 DB・本物の Todoist には触れない。ミニ vault ＋ fetch をモックして検証する。
// 実行: npx tsx scripts/verify-todoist.ts
//
// 方針（F1 設計5章 ／ 2026-07-13 オーナー指示）:
// - 対象は projects の todoistProject か todoistTag が設定されているプロジェクトだけ（アーカイブ済みは除く・bismuth-226）
// - Todoist のタスク1件につき、マッチしたプロジェクトごとに別の Bismuth タスクにする（bismuth-206）
// - Todoist のサブタスクは Bismuth のサブタスクにしない。親子を見ず、タスク自身のプロジェクト・タグで判定する（bismuth-206）
// - 既定では Todoist に書き込まない（GET しか来ないことを確認する）。
//   設定に応じて、取り込んだタスクと掃除リストのタスクを完了・削除する。取りこぼしになるタスクには触らない（bismuth-206）
// - 重複防止は frontmatter の todoist-id と project の組。既取込はスキップ
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
        { id: 'retired', description: '', todoistProject: '900_Learning', todoistTag: 'archived-tag', archived: true }, // 対象外（アーカイブ済み）
        { id: 'focus', description: '', todoistProject: '', todoistTag: 'Focus' }, // タグだけで対応づける
        { id: 'both', description: '', todoistProject: 'Both', todoistTag: 'both-tag' }, // プロジェクト名とタグの両方（both-tag は共有ラベル）
        { id: 'typo', description: '', todoistProject: '', todoistTag: '存在しないタグ' },
        { id: 'idle', description: '', todoistProject: '', todoistTag: 'idle' }, // Todoist にあるが未完タスクには付いていない
      ],
    },
    null,
    2,
  ),
  'utf-8',
)

// --- Todoist API のモック（writable にするまで GET 以外が来たら落とす） ---
const calls: string[] = []
let writable = false
const writes: string[] = [] // 成功した書き込み（順序も検証する）
const failingWrites = new Set<string>() // 書き込みが 500 を返す Todoist タスク
const TODOIST_PROJECTS = [
  { id: 'p-alpha', name: 'Alpha' },
  { id: 'p-beta', name: 'Beta' },
  { id: 'p-both', name: 'Both' },
  { id: 'p-other', name: '900_Learning' },
]
const TODOIST_LABELS = [
  { id: 'l-1', name: 'next' },
  { id: 'l-2', name: 'Focus' },
  { id: 'l-3', name: 'idle' },
]
const TODOIST_TASKS = [
  {
    id: 't-1',
    content: '【改善】個別の概算費用を見積',
    description: '見積の内訳を出す。\n## 見出しは概要に置けないので格下げされる\n```bash\n# comment\n```\n```\n# 閉じていないブロックの中',
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
  { id: 't-10', content: 'タグだけでマッチ（大文字小文字は問わない）', description: '', project_id: 'p-other', parent_id: null, due: null, labels: ['FOCUS'], priority: 1 },
  { id: 't-11', content: 'タグで focus、プロジェクト名で beta にマッチ', description: '', project_id: 'p-beta', parent_id: null, due: null, labels: ['focus'], priority: 1 },
  { id: 't-12', content: '同じプロジェクトに名前とタグの両方でマッチ', description: '', project_id: 'p-both', parent_id: null, due: null, labels: ['both-tag'], priority: 1 },
  { id: 't-13', content: 'タグ付きの親', description: '', project_id: 'p-other', parent_id: null, due: null, labels: ['focus'], priority: 1 },
  { id: 't-13a', content: 'タグなしの子', description: '', project_id: 'p-other', parent_id: 't-13', due: null, labels: [], priority: 1 },
  { id: 't-14', content: 'タグなしの親', description: '', project_id: 'p-other', parent_id: null, due: null, labels: [], priority: 1 },
  { id: 't-14a', content: 'タグ付きの子', description: '', project_id: 'p-other', parent_id: 't-14', due: null, labels: ['focus'], priority: 1 },
  { id: 't-15', content: 'アーカイブ済みプロジェクトのタグ', description: '', project_id: 'p-other', parent_id: null, due: null, labels: ['archived-tag'], priority: 1 },
]

// モックの未完タスク（完了・削除で減る。繰り返しタスクは完了にしても未完のまま残る）
let openTasks: { id: string; parent_id: string | null; due: { is_recurring?: boolean } | null }[] = TODOIST_TASKS

// 本物と同じく、親を完了・削除するとサブタスクも一緒になくなる
function removeWithSubtasks(id: string): void {
  const children = openTasks.filter((t) => t.parent_id === id).map((t) => t.id)
  openTasks = openTasks.filter((t) => t.id !== id)
  for (const child of children) removeWithSubtasks(child)
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.split('?')[0]}`)
  if (method !== 'GET') {
    if (!writable) throw new Error(`Todoist に書き込もうとしました: ${method} ${url}`)
    const m = url.match(/\/tasks\/([^/?]+)(\/close)?$/)
    if (!m || (method === 'POST') !== Boolean(m[2]) || !['POST', 'DELETE'].includes(method)) return new Response('bad request', { status: 400 })
    const id = decodeURIComponent(m[1])
    if (failingWrites.has(id)) return new Response('error', { status: 500 })
    const target = openTasks.find((t) => t.id === id)
    if (!target) return new Response('not found', { status: 404 })
    writes.push(`${method} ${id}`)
    if (method === 'DELETE' || !target.due?.is_recurring) removeWithSubtasks(id)
    return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const results = url.includes('/projects') ? TODOIST_PROJECTS : url.includes('/labels') ? TODOIST_LABELS : openTasks
  const body = { results }
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
const rows = preview.imports.map((i) => `${i.project}/${i.todoistId}`)
const hasRow = (project: string, todoistId: string) => rows.includes(`${project}/${todoistId}`)
check('プレビュー: 対象プロジェクトのタスクだけ（900_Learning は入らない）', !preview.imports.some((i) => i.todoistId === 't-9'), JSON.stringify(rows))
check('プレビュー: 件数', preview.imports.length === 11, JSON.stringify(rows))
check('プレビュー: Todoist 名が見つからないプロジェクトを報告', preview.projects.find((p) => p.project === 'ghost')?.found === false)
check('プレビュー: Todoist 名が未設定のプロジェクトは対象外', !preview.projects.some((p) => p.project === 'unmapped'))
check(
  'プレビュー: アーカイブ済みのプロジェクトは対象外（Todoist 名・タグがあっても取り込まない）',
  !preview.projects.some((p) => p.project === 'retired') && !preview.imports.some((i) => i.project === 'retired' || i.todoistId === 't-15'),
)
check('プレビュー: ノートを書かない', (await scanTasks(vault)).length === 0)

// 1-2) タグでの対応づけ（bismuth-206）
check('タグ: タグだけのプロジェクトに取り込む（Todoist プロジェクトは問わない）', hasRow('focus', 't-10'))
check('タグ: 大文字小文字を区別しない', preview.imports.find((i) => i.todoistId === 't-10')?.project === 'focus')
check('タグ: タグで B・プロジェクト名で C にマッチしたら別々の行になる', hasRow('focus', 't-11') && hasRow('beta', 't-11'), JSON.stringify(rows))
check('タグ: 同じプロジェクトに名前とタグの両方でマッチしても1行', rows.filter((r) => r === 'both/t-12').length === 1)
check('タグ: 行を選択するキーはプロジェクトごとに異なる', new Set(preview.imports.map((i) => i.key)).size === preview.imports.length)
check('タグ: Todoist プロジェクト名が空のプロジェクトを「見つからない」と報告しない', preview.projects.find((p) => p.project === 'focus')?.found === true)
check('タグ: Todoist にないタグを報告', preview.projects.find((p) => p.project === 'typo')?.tagFound === false)
check('タグ: 未完タスクに付いていなくても Todoist にあるタグは報告しない', preview.projects.find((p) => p.project === 'idle')?.tagFound === true)
check('タグ: /labels にない共有ラベルでも未完タスクに付いていれば報告しない', preview.projects.find((p) => p.project === 'both')?.tagFound === true)
check('タグ: タグ未設定のプロジェクトを「見つからない」と報告しない', preview.projects.find((p) => p.project === 'alpha')?.tagFound === true)

// 1-3) サブタスクは親子を見ず、それ自身のプロジェクト・タグで判定する（bismuth-206）
check('サブタスク: プロジェクト名でマッチすれば単独のタスクになる', hasRow('alpha', 't-2') && hasRow('alpha', 't-2a') && hasRow('alpha', 't-2b'), JSON.stringify(rows))
check('サブタスク: 自身のタグでマッチすれば、親がマッチしなくても単独のタスクになる', hasRow('focus', 't-14a') && !preview.imports.some((i) => i.todoistId === 't-14'))
check('サブタスク: 親がタグでマッチしても、タグのない子は取り込まない', hasRow('focus', 't-13') && !preview.imports.some((i) => i.todoistId === 't-13a'))

const item = preview.imports.find((i) => i.todoistId === 't-1')!
check('マッピング: priority 4 → P1', item.priority === 'P1')
check('マッピング: due', item.due === '2026-07-20')
check('マッピング: labels → tags', item.tags.join(',') === 'next')
check('マッピング: priority 1 → 優先度なし', preview.imports.find((i) => i.todoistId === 't-2')?.priority === null)
check('マッピング: priority 3 → P2', preview.imports.find((i) => i.todoistId === 't-3')?.priority === 'P2')

// 2) 選択実行（同じ Todoist タスクでもプロジェクトごとに選べる）
const betaRow = preview.imports.find((i) => i.project === 'beta' && i.todoistId === 't-11')!
const partial = await runSync(vault, [betaRow.key])
check(
  '選択実行: 選んだプロジェクトの行だけ取り込む',
  partial.imported.length === 1 && partial.imported[0].project === 'beta',
  JSON.stringify(partial.imported),
)
const afterPartial = await previewSync(vault)
check(
  '選択実行: 取込済みの行だけスキップされ、別プロジェクトの行は残る',
  !afterPartial.imports.some((i) => i.key === betaRow.key) && afterPartial.imports.some((i) => i.project === 'focus' && i.todoistId === 't-11') && afterPartial.skipped === 1,
  JSON.stringify({ skipped: afterPartial.skipped }),
)

// 3) 実行（残り全件）
const result = await runSync(vault)
check('取込: 残り10件', result.imported.length === 10 && result.failed.length === 0 && result.skipped === 1, JSON.stringify(result.failed))

const tasks = await scanTasks(vault)
check('取込: ノートが作られる', tasks.length === 11)
check(
  '取込: プロジェクトごとに振り分けられる',
  tasks.filter((t) => t.project === 'alpha').length === 4 &&
    tasks.filter((t) => t.project === 'beta').length === 2 &&
    tasks.filter((t) => t.project === 'focus').length === 4 &&
    tasks.filter((t) => t.project === 'both').length === 1,
)
check('取込: status は backlog 固定', tasks.every((t) => t.status === 'backlog'))
check('取込: todoist-id が記録される', tasks.every((t) => t.todoistId != null))
check('取込: 優先度が入る', tasks.find((t) => t.todoistId === 't-1')?.priority === 'P1')
check('取込: due・tags が入る', tasks.find((t) => t.todoistId === 't-1')?.due === '2026-07-20' && tasks.find((t) => t.todoistId === 't-1')?.tags.join(',') === 'next')
check(
  '取込: ラベル無しは空タグ（既定タグ [project, task] を付けない）',
  tasks.find((t) => t.todoistId === 't-2')?.tags.length === 0 && tasks.find((t) => t.todoistId === 't-3')?.tags.length === 0,
  JSON.stringify([tasks.find((t) => t.todoistId === 't-2')?.tags, tasks.find((t) => t.todoistId === 't-3')?.tags]),
)
const split = tasks.filter((t) => t.todoistId === 't-11')
check(
  '取込: 1つの Todoist タスクが別々のノートになる',
  split.length === 2 && split.map((t) => t.project).sort().join(',') === 'beta,focus' && split[0].taskId !== split[1].taskId,
)

const parent = await getTask(vault, tasks.find((t) => t.todoistId === 't-2')!.taskId)
check('取込: 親タスクのサブタスク欄は空（Todoist のサブタスクをチェックリストにしない）', parent!.subtasks.trim() === '', parent!.subtasks)
const child = await getTask(vault, tasks.find((t) => t.todoistId === 't-2a')!.taskId)
check('取込: サブタスクが単独のノートになる', child!.task.title === '子その1' && child!.task.parent === null)

const withDesc = await getTask(vault, tasks.find((t) => t.todoistId === 't-1')!.taskId)
check('取込: description → 概要', withDesc!.overview.includes('見積の内訳を出す。'))
check('取込: 概要の h2 は格下げされる（セクション構造を壊さない）', withDesc!.overview.includes('#### 見出しは概要に置けない') && !/^## /m.test(withDesc!.overview))
check('取込: コードブロックの中の # は格下げしない（bismuth-282）', withDesc!.overview.includes('```bash\n# comment\n```'), withDesc!.overview)
check('取込: 閉じていないコードブロックは末尾で閉じる（bismuth-282）', withDesc!.overview.endsWith('```\n# 閉じていないブロックの中\n```') && withDesc!.subtasks === '' && withDesc!.comments.length === 0, withDesc!.overview)

// 4) 冪等性（2回目は取り込まない）
const again = await runSync(vault)
check('再同期: 既取込はスキップ', again.imported.length === 0 && again.skipped === 11, JSON.stringify({ imported: again.imported.length, skipped: again.skipped }))
check('再同期: ノートは増えない', (await scanTasks(vault)).length === 11)

// 5) 掃除リスト（取込済みかつ Todoist 側で未完）
check('掃除リスト: 11件', again.cleanup.length === 11, JSON.stringify(again.cleanup))
check('掃除リスト: task-id と Todoist id が対応', again.cleanup.every((c) => c.taskId > 0 && c.todoistId.startsWith('t-')))
check('掃除リスト: 同じ Todoist タスクから作ったノートはそれぞれ載る', again.cleanup.filter((c) => c.todoistId === 't-11').length === 2)

// 6) 既定では Todoist に書き込まない
check('既定: GET しか呼ばない', calls.every((c) => c.startsWith('GET ')), calls.join(' / '))
check('既定: /projects・/labels・/tasks だけ', [...new Set(calls)].every((c) => c.endsWith('/projects') || c.endsWith('/labels') || c.endsWith('/tasks')))
check('既定: 同期後の処理は「何もしない」', again.afterSync.action === 'none' && again.afterSync.done.length === 0)

// 7) 対応づけの有無（タグだけでも対象になる。どちらも無ければ明示的に失敗する）
function miniVault(projects: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
  fs.mkdirSync(path.join(dir, '.bismuth'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.bismuth', 'config.json'), JSON.stringify({ taskGlobs: ['_task/*/*.md'], projects }), 'utf-8')
  return dir
}
const tagOnlyVault = miniVault([{ id: 'focus', todoistTag: 'focus' }])
check('対応づけ: タグだけのプロジェクトでも同期できる', (await previewSync(tagOnlyVault)).imports.some((i) => i.project === 'focus'))
const noMapVault = miniVault([{ id: 'plain' }])
let noMapError = ''
try {
  await previewSync(noMapVault)
} catch (err) {
  noMapError = err instanceof Error ? err.message : String(err)
}
check('対応づけ: 名前もタグも無ければエラーを返す', noMapError.includes('タグ'), noMapError)
fs.rmSync(tagOnlyVault, { recursive: true, force: true })
fs.rmSync(noMapVault, { recursive: true, force: true })

// 7-2) 同期後の処理（bismuth-206）。完了と削除で同じシナリオを流す
const after = (id: string, content: string, project_id: string, labels: string[] = [], parent_id: string | null = null, recurring = false) => ({
  id,
  content,
  description: '',
  project_id,
  parent_id,
  due: recurring ? { date: '2026-07-20', is_recurring: true } : null,
  labels,
  priority: 1,
})
const AFTER_TASKS = [
  after('a-1', '単純なタスク', 'p-alpha'),
  after('a-2', '子も取り込む親', 'p-alpha'),
  after('a-2a', '一緒に取り込む子', 'p-alpha', [], 'a-2'),
  after('a-3', '2つのプロジェクトにマッチ', 'p-beta', ['focus']),
  after('a-4', 'タグ付きの親', 'p-other', ['focus']),
  after('a-4a', 'どこにもマッチしない子', 'p-other', [], 'a-4'),
  after('a-5', 'マッチしない親', 'p-other'),
  after('a-5a', 'タグ付きの子', 'p-other', ['focus'], 'a-5'),
  after('a-6', '選択しないタスク', 'p-alpha'),
  after('a-7', '', 'p-alpha'), // タイトルが空なのでノートの作成に失敗する
  after('a-8', 'Todoist 側の処理に失敗するタスク', 'p-alpha'),
  after('a-9', '前回取り込んだタスク', 'p-alpha'),
  after('a-10', '子だけ前回取り込んだ親', 'p-alpha'),
  after('a-10a', '前回取り込んだ子', 'p-alpha', [], 'a-10'),
  after('a-11', '選択しない子を持つ親', 'p-alpha'),
  after('a-11a', '選択しない子', 'p-alpha', [], 'a-11'),
  after('a-12', '子の処理に失敗する親', 'p-alpha'),
  after('a-12a', '処理に失敗する子', 'p-alpha', [], 'a-12'),
  after('a-14', '前回取り込んだ、マッチしない子を持つ親', 'p-other', ['focus']),
  after('a-14a', 'どこにもマッチしない子その2', 'p-other', [], 'a-14'),
  after('a-15', '前回取り込み、処理に失敗するタスク', 'p-alpha'),
  after('a-16', '前回取り込んだ繰り返しタスク', 'p-alpha', [], null, true),
  after('a-17', '今回取り込む繰り返しタスク', 'p-alpha', [], null, true),
]

for (const [action, method] of [['complete', 'POST'], ['delete', 'DELETE']] as const) {
  const afterVault = miniVault([
    { id: 'alpha', todoistProject: 'Alpha' },
    { id: 'beta', todoistProject: 'Beta' },
    { id: 'focus', todoistTag: 'focus' },
  ])
  openTasks = structuredClone(AFTER_TASKS)
  writes.length = 0
  failingWrites.clear()
  for (const id of ['a-8', 'a-12a', 'a-15']) failingWrites.add(id)
  writable = true
  const name = (s: string) => `同期後(${action}): ${s}`
  const ids = (list: { todoistId: string }[]) => list.map((i) => i.todoistId).sort()
  const isOpen = (id: string) => openTasks.some((t) => t.id === id)
  const expectDone = [...(action === 'delete' ? ['a-16'] : []), 'a-1', 'a-10', 'a-10a', 'a-12', 'a-17', 'a-2', 'a-2a', 'a-5a', 'a-9'].sort()

  // 何もしない設定で取り込んでおく（これらが掃除リストのタスクになる）
  await runSync(afterVault, ['alpha:a-9', 'alpha:a-10a', 'alpha:a-12a', 'focus:a-14', 'alpha:a-15', 'alpha:a-16'])
  const quiet = await runSync(afterVault, [])
  check(name('何もしない設定では掃除リストがあっても書き込まない'), writes.length === 0 && quiet.cleanup.length === 6, writes.join(','))

  const unselected = ['focus:a-3', 'alpha:a-6', 'alpha:a-11a']
  const keys = (await previewSync(afterVault)).imports.map((i) => i.key).filter((k) => !unselected.includes(k))
  const r = await runSync(afterVault, keys, action)

  check(name('ノートの取込は設定に関わらず行う'), r.imported.length === 11, JSON.stringify(r.imported.map((i) => i.title)))
  check(name('作成に失敗した行は Todoist を処理しない'), r.failed.length === 1 && r.failed[0].project === 'alpha' && !writes.includes(`${method} a-7`), JSON.stringify(r.failed))
  check(name('処理の種類を結果で返す'), r.afterSync.action === action)
  check(
    name('取り込んだタスクと掃除リストのタスクのうち、取りこぼしのないものを処理する'),
    ids(r.afterSync.done).join(',') === expectDone.join(','),
    ids(r.afterSync.done).join(','),
  )
  check(
    name(`${method} で書き込む`),
    [...writes].sort().join(',') === expectDone.map((id) => `${method} ${id}`).join(','),
    writes.join(','),
  )
  check(name('掃除リストのタスクを処理する'), !isOpen('a-9') && r.afterSync.done.some((d) => d.todoistId === 'a-9'))
  check(
    name('子を親より先に処理する（親が先だと子が 404 になる）'),
    writes.indexOf(`${method} a-2a`) < writes.indexOf(`${method} a-2`) && writes.indexOf(`${method} a-10a`) < writes.indexOf(`${method} a-10`),
    writes.join(','),
  )
  check(name('未選択のタスクは処理しない'), !writes.includes(`${method} a-6`) && openTasks.some((t) => t.id === 'a-6'))
  check(name('マッチしない親は処理しない（サブタスクだけ処理する）'), openTasks.some((t) => t.id === 'a-5') && !openTasks.some((t) => t.id === 'a-5a'))

  const held = (id: string) => r.afterSync.held.find((h) => h.todoistId === id)
  check(name('別のプロジェクトの行が残るタスクは処理せず理由を返す'), held('a-3')?.reason.includes('プロジェクト') === true && openTasks.some((t) => t.id === 'a-3'), JSON.stringify(r.afterSync.held))
  check(name('どこにもマッチしないサブタスクを持つ親は処理しない'), held('a-4')?.reason.includes('サブタスク') === true && openTasks.some((t) => t.id === 'a-4a'), JSON.stringify(r.afterSync.held))
  check(name('選択しなかったサブタスクを持つ親は処理しない'), held('a-11')?.reason.includes('サブタスク') === true && openTasks.some((t) => t.id === 'a-11a'), JSON.stringify(r.afterSync.held))
  check(name('掃除リストのタスクでも取りこぼしになるなら処理しない'), held('a-14')?.reason.includes('サブタスク') === true && isOpen('a-14') && isOpen('a-14a'), JSON.stringify(r.afterSync.held))

  // 繰り返しタスクは完了にしても未完のまま残るので、掃除リストから完了にすると同期のたびに予定が飛ぶ
  if (action === 'complete') {
    check(name('掃除リストの繰り返しタスクは完了にしない'), held('a-16')?.reason.includes('繰り返し') === true && !writes.includes('POST a-16'), JSON.stringify(r.afterSync.held))
    check(name('今回取り込む繰り返しタスクは完了にする'), writes.includes('POST a-17') && isOpen('a-17'), writes.join(','))
  } else {
    check(name('繰り返しタスクも削除する'), !isOpen('a-16') && !isOpen('a-17'), writes.join(','))
  }
  check(name('保留の件数'), r.afterSync.held.length === (action === 'complete' ? 5 : 4), JSON.stringify(r.afterSync.held))

  check(
    name('Todoist 側の失敗を報告し、他のタスクは続行する'),
    ids(r.afterSync.failed).join(',') === 'a-12a,a-15,a-8' && r.afterSync.failed.every((f) => f.error.includes('500')),
    JSON.stringify(r.afterSync.failed),
  )
  check(name('Todoist 側で失敗してもノートは残る'), (await scanTasks(afterVault)).some((t) => t.todoistId === 'a-8'))

  check(name('処理したタスクは掃除リストから外す'), !ids(r.cleanup).includes('a-9') && !ids(r.cleanup).includes('a-10a'), JSON.stringify(r.cleanup))
  check(name('親と一緒になくなった子は、子の処理に失敗しても掃除リストから外す'), !isOpen('a-12a') && !ids(r.cleanup).includes('a-12a'), JSON.stringify(r.cleanup))
  check(name('処理しなかったタスクと失敗したタスクは掃除リストに残る'), ids(r.cleanup).includes('a-14') && ids(r.cleanup).includes('a-15'), JSON.stringify(r.cleanup))

  // 残っていた行を取り込むと、マッチした全プロジェクトへの取込が済むので処理される
  const rest = await runSync(afterVault, ['focus:a-3'], action)
  check(name('全プロジェクトへの取込が済むと処理する'), ids(rest.afterSync.done).join(',') === 'a-3' && !openTasks.some((t) => t.id === 'a-3'), JSON.stringify(rest.afterSync))
  check(name('処理したタスクは結果の掃除リストから外す'), !ids(rest.cleanup).includes('a-3'), JSON.stringify(rest.cleanup))
  check(name('失敗したタスクは次の実行でも処理を試す'), ids(rest.afterSync.failed).join(',') === 'a-15,a-8', JSON.stringify(rest.afterSync.failed))
  if (action === 'complete') {
    check(name('取り込んだ実行の後は繰り返しタスクを完了にしない'), writes.filter((w) => w === 'POST a-17').length === 1 && rest.afterSync.held.some((h) => h.todoistId === 'a-17'), writes.join(','))
  }

  // 取り込む行を選ばなくても、掃除リストのタスクは処理する
  failingWrites.clear()
  const onlyCleanup = await runSync(afterVault, [], action)
  check(name('行を選ばなくても掃除リストを処理する'), onlyCleanup.imported.length === 0 && ids(onlyCleanup.afterSync.done).join(',') === 'a-15,a-8', JSON.stringify(onlyCleanup.afterSync))
  check(name('掃除リストに残るのは処理できないタスクだけ'), ids((await previewSync(afterVault)).cleanup).filter((id) => isOpen(id)).length === (await previewSync(afterVault)).cleanup.length)

  const remaining = (await previewSync(afterVault)).imports.map((i) => i.key).sort().join(',')
  check(name('処理済みのタスクは次回のプレビューに出ない'), remaining === 'alpha:a-11a,alpha:a-6,alpha:a-7', remaining)

  writable = false
  fs.rmSync(afterVault, { recursive: true, force: true })
}
openTasks = TODOIST_TASKS

// 8) トークンが無いときは明示的に失敗する（黙って何もしない、にはしない）
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

// 9) 有効化スイッチ（bismuth-175）: BISMUTH_TODOIST=1 のときだけ有効。未設定・他の値は無効
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
