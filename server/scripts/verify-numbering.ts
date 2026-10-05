// 採番（config.json の nextTaskId カウンター）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-numbering.ts
//
// 方針（2026-07-13 オーナー指示 / 2026-07-16 保存先を SQLite → 共有設定 config.json に変更）:
// - 起票のたびに vault を全走査しない。採番は共有設定 <vault>/.bismuth/config.json の nextTaskId から払い出す
// - カウンターは導出値。無い・捨てられた・壊れたときは vault から作り直せる（F1 設計 3章）
// - 払い出した ID は削除しても戻さない（ゴミ箱のノートを復元しても衝突しない）
// - カウンターが vault からずれていた場合（他マシンで採番されたノートが Drive 同期で届いた等）は、
//   ファイル名の衝突を検知して走査し直し、採り直す
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readNextTaskId } from '../src/projects.js'
import { createTask, deleteTask, ensureTaskIdCounter, resyncTaskIdCounter } from '../src/vault.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

const configFile = path.join(vault, '.bismuth', 'config.json')

// カウンターを捨てる（旧: DB ファイルを削除）。projects など他のキーは残す＝
// 「カウンターだけ失われても vault から再構築できる」ことを検証するため
function clearCounter(): void {
  let conf: Record<string, unknown> = {}
  try {
    conf = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>
  } catch {
    conf = {}
  }
  delete conf.nextTaskId
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(configFile, `${JSON.stringify(conf, null, 2)}\n`, 'utf-8')
}

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

// 1) 空の vault → カウンターを 1 から作る
const first = await ensureTaskIdCounter(vault)
check('初期化: 空の vault なら次は 1', first.next === 1 && first.rebuilt)
check('初期化: config.json に nextTaskId が書かれる', readNextTaskId(vault) === 1)

// 2) 採番はカウンターから連番で払い出される
const t1 = await createTask(vault, { title: '1件目', project: 'testproj' })
const t2 = await createTask(vault, { title: '2件目', project: 'testproj' })
check('採番: 連番で払い出す', t1.task.taskId === 1 && t2.task.taskId === 2)
check('採番: カウンターが進む', readNextTaskId(vault) === 3)

// 3) 2回目以降の起動では走査しない（カウンターがあれば再構築しない）
const second = await ensureTaskIdCounter(vault)
check('起動: カウンターがあれば再構築しない', second.next === 3 && !second.rebuilt)

// 4) 削除しても払い出し済みの ID は戻さない
await deleteTask(vault, 2)
const t3 = await createTask(vault, { title: '削除後の起票', project: 'testproj' })
check('削除: ID を再利用しない', t3.task.taskId === 3, `taskId=${t3.task.taskId}`)

// 5) vault を走査していないことの確認。
//    手で task-id 100 のノートを置いてもカウンターは動かない（走査していれば 101 になるはず）
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-100 手で置いたノート.md'),
  ['---', 'task-id: 100', 'title: 手で置いたノート', 'project: testproj', 'status: backlog', '---', ''].join('\n'),
  'utf-8',
)
const t4 = await createTask(vault, { title: '走査していない証拠', project: 'testproj' })
check('採番: 起票時に vault を走査しない（100 を見ていない）', t4.task.taskId === 4, `taskId=${t4.task.taskId}`)

// 6) カウンターを捨てても vault から再構築できる（ゴミ箱の ID も数える）
clearCounter()
check('再構築: カウンターを捨てた状態', readNextTaskId(vault) === null)

const rebuilt = await ensureTaskIdCounter(vault)
check('再構築: vault の最大 ID + 1 になる（手置きの 100 を含む）', rebuilt.next === 101 && rebuilt.rebuilt)

const t5 = await createTask(vault, { title: '再構築後の起票', project: 'testproj' })
check('再構築: その後の採番が続く', t5.task.taskId === 101)

// 7) カウンターが vault からずれている場合（他マシンで採番されたノートが同期されてきた等）は
//    衝突を検知して採り直す
await resyncTaskIdCounter(vault) // → 102
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-102 他マシンで採番されたノート.md'),
  ['---', 'task-id: 102', 'title: 他マシンで採番されたノート', 'project: testproj', 'status: backlog', '---', ''].join(
    '\n',
  ),
  'utf-8',
)
const t6 = await createTask(vault, { title: '衝突の回避', project: 'testproj' })
check('衝突: 既に使われている ID を避けて採り直す', t6.task.taskId === 103, `taskId=${t6.task.taskId}`)
check(
  '衝突: 既存ノートを上書きしていない',
  fs.existsSync(path.join(vault, '_task', 'testproj', 'testproj-102 他マシンで採番されたノート.md')),
)

// 8) ゴミ箱の中の ID も再構築時に数える
await deleteTask(vault, 103)
clearCounter()
const rebuilt2 = await ensureTaskIdCounter(vault)
check('再構築: ゴミ箱の ID も数える（103 → 次は 104）', rebuilt2.next === 104, `next=${rebuilt2.next}`)

// 9) 衝突検知はファイル名で行うので、現行規則の命名で置かれたノートも拾えること。
//    （7 は旧規則のファイル名で同じことを検証している＝新旧どちらも探せる）
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-task-104-現行規則で置かれたノート.md'),
  ['---', 'task-id: 104', 'title: 現行規則で置かれたノート', 'project: testproj', 'status: backlog', '---', ''].join('\n'),
  'utf-8',
)
const t7 = await createTask(vault, { title: '現行規則の衝突を避ける', project: 'testproj' })
check('衝突: 現行規則のファイル名でも検知して採り直す', t7.task.taskId === 105, `taskId=${t7.task.taskId}`)
check(
  '衝突: 現行規則の既存ノートを上書きしていない',
  fs.readFileSync(
    path.join(vault, '_task', 'testproj', 'testproj-task-104-現行規則で置かれたノート.md'),
    'utf-8',
  ).includes('title: 現行規則で置かれたノート'),
)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
