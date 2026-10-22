// プロジェクトのアーカイブ（bismuth-226）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作り、projects 関数と CLI を実際に起動して検証する。
// 実行: npx tsx scripts/verify-archive.ts
//
// 方針（2026-10-22 オーナー指示）:
// - 削除ではなく、一覧から見えなくするだけ。状態は共有設定 projects の archived: true だけで持ち、ノートは
//   _task/<id>/ に置いたまま動かさない。解除はフラグを外すだけ
// - 単位はプロジェクトのみ（タスク単位の非表示は dropped と「完了から N 日で非表示」で足りる）
// - CLI のボード・--list は既定で隠し、--all で含める。--json は機械処理用なので全件を返す
//   （/bismuth の番号引き・done・comment はこれまでどおり効く）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'cli.ts')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const userConf = path.join(vault, 'user-config.json')
fs.mkdirSync(path.join(vault, '.bismuth'), { recursive: true })
fs.writeFileSync(
  path.join(vault, '.bismuth', 'config.json'),
  JSON.stringify({ taskGlobs: ['_task/*/*.md'] }, null, 2),
  'utf-8',
)

const { addProject, archivedProjectIds, ensureProjects, listProjects, updateProject } = await import('../src/projects.js')
const { createTask, getTask, scanTasks, syncProjectsFromTasks } = await import('../src/vault.js')

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

function runCli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('npx', ['tsx', cli, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, BISMUTH_VAULT: vault, BISMUTH_CONFIG: userConf },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

const conf = () => JSON.parse(fs.readFileSync(path.join(vault, '.bismuth', 'config.json'), 'utf-8'))
const confProject = (id: string) => (conf().projects as Record<string, unknown>[]).find((p) => p.id === id)

addProject(vault, { id: 'alpha', description: 'サンプル案件A', todoistProject: 'Alpha' })
addProject(vault, { id: 'beta', description: 'サンプル案件B' })
const a1 = await createTask(vault, { title: 'アルファの作業', project: 'alpha', status: 'dotoday' })
const b1 = await createTask(vault, { title: 'ベータの作業', project: 'beta', status: 'dotoday' })

// 1) 既定はアーカイブされていない。アーカイブしていない間は config に archived を書かない
check('既定: 追加したプロジェクトは archived=false', listProjects(vault).every((p) => p.archived === false))
check('既定: config に archived キーを書かない', confProject('alpha')?.archived === undefined, JSON.stringify(confProject('alpha')))

// 2) アーカイブ＝共有設定に archived: true を付けるだけ。他の項目は変わらない
const archived = updateProject(vault, 'beta', { archived: true })
check('アーカイブ: archived=true で返る', archived?.archived === true)
check('アーカイブ: config に archived: true が入る', confProject('beta')?.archived === true, JSON.stringify(confProject('beta')))
check('アーカイブ: 概要は変わらない', listProjects(vault).find((p) => p.id === 'beta')?.description === 'サンプル案件B')
check('アーカイブ: 他のプロジェクトは変わらない', listProjects(vault).find((p) => p.id === 'alpha')?.archived === false)
check('アーカイブ: archivedProjectIds に入る', [...archivedProjectIds(vault)].join(',') === 'beta')

// 3) ノートは動かさない。スキャン・番号引きにはこれまでどおり出る（web の No・CLI の done / comment と同じ経路）
check('ノート: _task/beta/ に置いたまま', fs.existsSync(path.join(vault, b1.task.file)))
check('ノート: ゴミ箱へは移さない', !fs.existsSync(path.join(vault, '_task', '.trash', 'beta')))
check('ノート: スキャンには出る', (await scanTasks(vault)).some((t) => t.taskId === b1.task.taskId))
check('ノート: task-id で引ける', (await getTask(vault, b1.task.taskId))?.task.title === 'ベータの作業')

// 4) 概要の編集ではアーカイブが外れない（PATCH で archived を省いたとき）
updateProject(vault, 'beta', { description: '改訂' })
check('編集: archived を省いた更新では状態を保つ', listProjects(vault).find((p) => p.id === 'beta')?.archived === true)

// 5) archived は真偽値のみ
let rejected = false
try {
  updateProject(vault, 'beta', { archived: 'yes' as unknown as boolean })
} catch {
  rejected = true
}
check('バリデーション: 真偽値以外の archived を拒否', rejected)
check('バリデーション: 拒否しても状態は変わらない', listProjects(vault).find((p) => p.id === 'beta')?.archived === true)

// 6) 起動時の同期・起票の自動登録でアーカイブが外れない
await syncProjectsFromTasks(vault)
ensureProjects(vault, ['beta', 'gamma'])
check('同期: 起動時の自動登録でアーカイブが外れない', listProjects(vault).find((p) => p.id === 'beta')?.archived === true)
await createTask(vault, { title: 'アーカイブ後のベータ', project: 'beta', status: 'backlog' })
check('起票: アーカイブ済みにも起票でき、状態は保つ', listProjects(vault).find((p) => p.id === 'beta')?.archived === true)

// 7) CLI のボード・--list は既定で隠し、除外した件数を添える
const board = runCli([])
check(
  'CLI ボード: アーカイブ済みのタスクを出さない',
  board.code === 0 && board.out.includes('アルファの作業') && !board.out.includes('ベータの作業'),
  board.out,
)
check('CLI ボード: 除外件数を添える', board.out.includes('アーカイブ済みプロジェクトの 2 件を除外'), board.out)
check('CLI ボード: 件数にアーカイブ済みを数えない', board.out.includes('(1 / 全3件)'), board.out.split('\n')[0])
const list = runCli(['--list'])
check('CLI --list: アーカイブ済みのタスクを出さない', list.code === 0 && !list.out.includes('ベータの作業'), list.out)

// 8) --all で含める
const all = runCli(['--list', '--all'])
check(
  'CLI --list --all: アーカイブ済みも出す',
  all.out.includes('ベータの作業') && all.out.includes('アーカイブ後のベータ') && all.out.includes('アルファの作業'),
  all.out,
)
check('CLI --list --all: 除外の注記を出さない', !all.out.includes('除外'), all.out)

// 9) --json は全件（/bismuth の番号引きが効く）
const json = JSON.parse(runCli(['--json']).out) as { taskId: number; project: string }[]
check('CLI --json: アーカイブ済みも含む', json.length === 3 && json.some((t) => t.taskId === b1.task.taskId))

// 10) 書き込み系の CLI はアーカイブ済みのタスクにも効く
const comment = runCli(['comment', `beta-${b1.task.taskId}`, '保管中のメモ', '--author', '検証'])
check('CLI comment: アーカイブ済みのタスクに追記できる', comment.code === 0, comment.out)
const done = runCli(['done', `beta-${b1.task.taskId}`])
check('CLI done: アーカイブ済みのタスクを完了にできる', done.code === 0 && done.out.includes('完了'), done.out)

// 11) 解除＝フラグを外すだけ。config からも archived キーが消え、CLI に再び出る
const restored = updateProject(vault, 'beta', { archived: false })
check('解除: archived=false で返る', restored?.archived === false)
check('解除: config から archived キーが消える', confProject('beta')?.archived === undefined, JSON.stringify(confProject('beta')))
check('解除: CLI ボードに再び出る', runCli([]).out.includes('アーカイブ後のベータ'))
check('解除: 除外の注記も消える', !runCli([]).out.includes('除外'))

// 12) 存在しない id は null
check('存在しない id は null', updateProject(vault, 'ghost', { archived: true }) === null)

void a1
console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
