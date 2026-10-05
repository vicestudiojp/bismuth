// プロジェクトの追加・編集（正本は <vault>/.bismuth/config.json の projects）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-projects.ts
//
// 方針（2026-07-13 オーナー指示）:
// - 項目は id（必須・半角英数/ハイフン/アンダースコア）・概要（任意）・Todoist プロジェクト名（任意）
// - id は不変（ファイル名 <project>-<task-id> と置き場 _task/<project>/ に使うため）
// - vault のノートが正本。アプリ外で作られたプロジェクトは起動時に自動登録する
// - 共有設定の未知キー（taskGlobs 等・人が手で足した設定）は温存する
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task'), { recursive: true })
fs.mkdirSync(path.join(vault, '.bismuth'), { recursive: true })

// 既存の共有設定（手で書いた taskGlobs と旧形式の todoistProjectMap）
fs.writeFileSync(
  path.join(vault, '.bismuth', 'config.json'),
  JSON.stringify({ taskGlobs: ['_task/*/*.md'], todoistProjectMap: { legacy: '900_Learning' } }, null, 2),
  'utf-8',
)

const { addProject, deleteProject, listProjects, updateProject } = await import('../src/projects.js')
const { createTask, scanTasks, syncProjectsFromTasks } = await import('../src/vault.js')

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

const conf = () => JSON.parse(fs.readFileSync(path.join(vault, '.bismuth', 'config.json'), 'utf-8'))

// 1) 旧形式（todoistProjectMap）を読み込める
check('移行: 旧 todoistProjectMap を読み込む', listProjects(vault).some((p) => p.id === 'legacy'))
check(
  '移行: Todoist 名も引き継ぐ',
  listProjects(vault).find((p) => p.id === 'legacy')?.todoistProject === '900_Learning',
)

// 2) 追加（3項目）
const alpha = addProject(vault, {
  id: 'alpha',
  description: 'サンプル案件A',
  todoistProject: 'Alpha',
})
check('追加: 3項目が保存される', alpha.id === 'alpha' && alpha.description === 'サンプル案件A' && alpha.todoistProject === 'Alpha')
check('追加: config.json の projects に入る', conf().projects.some((p: { id: string }) => p.id === 'alpha'))
check('追加: 旧 todoistProjectMap は統合されて消える', conf().todoistProjectMap === undefined)
check('追加: 未知キー（taskGlobs）は温存される', JSON.stringify(conf().taskGlobs) === JSON.stringify(['_task/*/*.md']))

// 3) 任意項目は省略できる
const minimal = addProject(vault, { id: 'gamma' })
check('追加: 概要・Todoist 名は省略できる', minimal.description === '' && minimal.todoistProject === '')

// 4) id のバリデーション
for (const [name, id] of [
  ['空', ''],
  ['日本語', 'イオーダー'],
  ['スペース入り', 'my project'],
  ['スラッシュ', 'a/b'],
  ['ドット', 'a.b'],
  ['先頭がハイフン', '-abc'],
] as const) {
  let rejected = false
  try {
    addProject(vault, { id })
  } catch {
    rejected = true
  }
  check(`バリデーション: ${name} の id を拒否`, rejected)
}
const ok = addProject(vault, { id: 'Talk_News-v2' })
check('バリデーション: 英数・ハイフン・アンダースコアは通る', ok.id === 'Talk_News-v2')

// 5) 重複（大文字小文字違いも弾く。ファイル名が衝突するため）
let dupRejected = false
try {
  addProject(vault, { id: 'Alpha' })
} catch {
  dupRejected = true
}
check('重複: 大文字小文字違いの id を拒否', dupRejected)

// 6) 更新（id は不変。概要と Todoist 名だけ）
const updated = updateProject(vault, 'gamma', { description: 'サンプル案件C', todoistProject: 'Gamma' })
check('更新: 概要と Todoist 名を変更できる', updated?.description === 'サンプル案件C' && updated?.todoistProject === 'Gamma')
check('更新: 片方だけの更新で他方は消えない', updateProject(vault, 'gamma', { description: '改訂' })?.todoistProject === 'Gamma')
check('更新: 空文字で消せる', updateProject(vault, 'gamma', { todoistProject: '' })?.todoistProject === '')
check('更新: 存在しない id は null', updateProject(vault, 'nope', { description: 'x' }) === null)

// 7) 起票すると未登録プロジェクトは自動登録される（vault が正本）
const task = await createTask(vault, { title: '新プロジェクトのタスク', project: 'delta' })
check('自動登録: 起票時に未登録プロジェクトを登録する', listProjects(vault).some((p) => p.id === 'delta'))
check('自動登録: タスクは _task/delta/ に作られる', task.task.file.startsWith(path.join('_task', 'delta')))
check('既定タグ: tags 未指定でも自動で付けない', task.task.tags.length === 0, JSON.stringify(task.task.tags))

// 8) アプリ外で作られたノート（秘書・セッションが直接書いた）も起動時に拾う
fs.mkdirSync(path.join(vault, '_task', 'talknews'), { recursive: true })
fs.writeFileSync(
  path.join(vault, '_task', 'talknews', 'talknews-80 手で作ったノート.md'),
  ['---', 'task-id: 80', 'title: 手で作ったノート', 'project: talknews', 'status: backlog', '---', ''].join('\n'),
  'utf-8',
)
const added = await syncProjectsFromTasks(vault)
check('同期: アプリ外のプロジェクトを起動時に登録する', added.includes('talknews'))
check('同期: 2回目は何も登録しない', (await syncProjectsFromTasks(vault)).length === 0)
check('同期: タスクは一覧に出る', (await scanTasks(vault)).some((t) => t.project === 'talknews'))

// 9) 一覧は id 順
const ids = listProjects(vault).map((p) => p.id)
check('一覧: id 順に並ぶ', JSON.stringify(ids) === JSON.stringify([...ids].sort((a, b) => a.localeCompare(b))), ids.join(','))

// 10) 削除＝config から外し、タスクフォルダ（_task/<id>/）を丸ごとゴミ箱へ移動する
const beforeDelta = fs.existsSync(path.join(vault, '_task', 'delta'))
const delDelta = deleteProject(vault, 'delta')
check('削除: フォルダのあるプロジェクトを削除できる', delDelta != null && beforeDelta)
check('削除: config の projects から外れる', !listProjects(vault).some((p) => p.id === 'delta'))
check('削除: 元のタスクフォルダは無くなる', !fs.existsSync(path.join(vault, '_task', 'delta')))
check('削除: _task/.trash/delta/ へ移動される', delDelta?.to === path.join(vault, '_task', '.trash', 'delta'))
check(
  '削除: タスクノートごと移動する（中身が残る）',
  fs.existsSync(path.join(vault, '_task', '.trash', 'delta')) &&
    fs.readdirSync(path.join(vault, '_task', '.trash', 'delta')).some((f) => f.endsWith('.md')),
)
check('削除: 削除後はスキャンに出ない', !(await scanTasks(vault)).some((t) => t.project === 'delta'))
check('削除: 起動同期でも復活しない（フォルダはゴミ箱）', !(await syncProjectsFromTasks(vault)).includes('delta'))

// 11) フォルダの無いプロジェクト（タスク未作成）は config から消えるだけ
check('削除: alpha はフォルダ無し', !fs.existsSync(path.join(vault, '_task', 'alpha')))
const delAlpha = deleteProject(vault, 'alpha')
check(
  '削除: フォルダ無しでも config から外れる（移動なし）',
  delAlpha != null && delAlpha.to === '' && !listProjects(vault).some((p) => p.id === 'alpha'),
)

// 12) ゴミ箱に同名があれば Windows 風に連番退避（上書きしない）
addProject(vault, { id: 'delta' })
await createTask(vault, { title: '2代目 delta のタスク', project: 'delta' })
const delDelta2 = deleteProject(vault, 'delta')
check('連番: 既存の delta を避けて delta (2) へ', delDelta2?.to === path.join(vault, '_task', '.trash', 'delta (2)'))
check('連番: 1代目 _task/.trash/delta/ は上書きされず残る', fs.existsSync(path.join(vault, '_task', '.trash', 'delta')))
check('連番: 2代目は _task/.trash/delta (2)/ に入る', fs.existsSync(path.join(vault, '_task', '.trash', 'delta (2)')))

// 13) 存在しないプロジェクトの削除は null
check('削除: 存在しない id は null', deleteProject(vault, 'ghost') === null)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
