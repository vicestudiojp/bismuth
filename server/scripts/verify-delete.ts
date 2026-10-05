// 削除（ノートを _task/.trash/ へ移動）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-delete.ts
//
// 方針（2026-07-13 オーナー指示）:
// - 削除してもノートの実体は消さない。_task/.trash/ に移動するだけ（復元は手で戻す）
// - .trash はドット始まりなのでスキャングロブ（_task/*/*.md）の対象外 → カンバンから消える
// - 採番はゴミ箱の中も数える。数えないと削除直後の起票で ID が再利用され、
//   ゴミ箱のノートを復元したときに重複 ID になる
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTask, deleteTask, getTask, scanTasks } from '../src/vault.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

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

const today = new Date()
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
  today.getDate(),
).padStart(2, '0')}`

// 3件起票（1・2・3）
await createTask(vault, { title: '残すタスク', project: 'testproj', body: '消えないこと。' })
await createTask(vault, { title: '消すタスク', project: 'testproj', body: 'ゴミ箱に入ること。' })
await createTask(vault, { title: 'もう1つ残す', project: 'testproj' })
check('前提: 3件ある', (await scanTasks(vault)).length === 3)

// 1) 削除 = ゴミ箱へ移動
const deleted = await deleteTask(vault, 2)
const trashPath = path.join(vault, '_task', '.trash', 'testproj-task-2-消すタスク.md')

check('削除: 結果が返る', deleted?.taskId === 2 && deleted?.title === '消すタスク')
check('削除: 移動先が _task/.trash/', deleted?.to === path.join('_task', '.trash', 'testproj-task-2-消すタスク.md'))
check('削除: 元の場所から消えている', !fs.existsSync(path.join(vault, '_task', 'testproj', 'testproj-task-2-消すタスク.md')))
check('削除: ゴミ箱にファイルが存在する', fs.existsSync(trashPath))

const trashed = fs.readFileSync(trashPath, 'utf-8')
check('削除: 中身は消さない', trashed.includes('ゴミ箱に入ること。') && trashed.includes('task-id: 2'))
check('削除: frontmatter に deleted 日付を記録', trashed.includes(`deleted: ${todayStr}`))

// 2) スキャン（＝カンバン）から見えなくなる
const live = await scanTasks(vault)
check('スキャン: 2件になる', live.length === 2, JSON.stringify(live.map((t) => t.taskId)))
check('スキャン: 削除したタスクが出てこない', !live.some((t) => t.taskId === 2))
check('スキャン: 残したタスクは無事', live.some((t) => t.taskId === 1) && live.some((t) => t.taskId === 3))
check('取得: 削除したタスクは getTask でも null', (await getTask(vault, 2)) === null)
check('取得: 存在しない id の削除は null', (await deleteTask(vault, 999)) === null)

// 3) 採番の再利用が起きない（最重要）
const created = await createTask(vault, { title: '削除後の起票', project: 'testproj' })
check('採番: ゴミ箱の ID を再利用しない（4 になる）', created.task.taskId === 4, `taskId=${created.task.taskId}`)

// 4) 最大 ID のタスクを削除してもなお再利用しない
await deleteTask(vault, 4)
const created2 = await createTask(vault, { title: '最大 ID を削除した直後の起票', project: 'testproj' })
check('採番: 最大 ID を削除しても再利用しない（5 になる）', created2.task.taskId === 5, `taskId=${created2.task.taskId}`)

// 5) 同名ファイルがゴミ箱にある場合は上書きしない
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-task-2-消すタスク.md'),
  ['---', 'task-id: 6', 'title: 消すタスク', 'project: testproj', 'status: backlog', '---', '', '# 6 同名の別ノート', ''].join(
    '\n',
  ),
  'utf-8',
)
// ↑ ファイル名が既存のゴミ箱と同じ（task-id は別）ケースを作って削除する
const dup = await deleteTask(vault, 6)
check('衝突: 連番を付けて退避する', dup?.to === path.join('_task', '.trash', 'testproj-task-2-消すタスク (2).md'), dup?.to)
check('衝突: 先にあったゴミ箱のノートを上書きしない', fs.readFileSync(trashPath, 'utf-8').includes('task-id: 2'))
check(
  '衝突: 退避した方の中身も残る',
  fs.readFileSync(path.join(vault, '_task', '.trash', 'testproj-task-2-消すタスク (2).md'), 'utf-8').includes('task-id: 6'),
)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
