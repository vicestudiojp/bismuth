// 優先度（P1〜P4 ／ 優先度なし）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-priority.ts
//
// 方針（2026-07-13 オーナー指示）:
// - P1〜P4（P1 が最優先）と「優先度なし」で設定できる。既定は優先度なし（Todoist 準拠）
// - 優先度なしは UI に何も表示しない（「なし」とも書かない）→ サーバーは null を返す
// - 並び順は 優先度 → order → task-id（優先度なしは最後）。並び自体は web 側で行う
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

const { createTask, getTask, scanTasks, updateTask } = await import('../src/vault.js')

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

// 1) 既定は「優先度なし」
const none = await createTask(vault, { title: '優先度を指定しない', project: 'testproj' })
check('起票: 既定は優先度なし（null）', none.task.priority === null, String(none.task.priority))
const noneNote = fs.readFileSync(path.join(vault, none.task.file), 'utf-8')
check('起票: frontmatter は空の priority 行', /^priority:\s*$/m.test(noneNote), noneNote.split('\n')[4])

// 2) 指定して起票
const p1 = await createTask(vault, { title: 'P1 のタスク', project: 'testproj', priority: 'P1' })
check('起票: P1 を設定できる', p1.task.priority === 'P1')
check(
  '起票: frontmatter に書かれる',
  fs.readFileSync(path.join(vault, p1.task.file), 'utf-8').includes('priority: P1'),
)

// 3) 小文字・空白も受ける（手書き frontmatter の揺れを吸収）
const p4 = await createTask(vault, { title: 'p4 のタスク', project: 'testproj', priority: ' p4 ' })
check('起票: 小文字・空白を正規化する', p4.task.priority === 'P4')

// 4) 更新（設定・変更・解除）
const set = await updateTask(vault, none.task.taskId, { priority: 'P2' })
check('更新: 優先度なし → P2', set?.task.priority === 'P2')

const changed = await updateTask(vault, none.task.taskId, { priority: 'P1' })
check('更新: P2 → P1（引き上げ）', changed?.task.priority === 'P1')

const cleared = await updateTask(vault, none.task.taskId, { priority: null })
check('更新: null で優先度なしに戻せる', cleared?.task.priority === null)
const clearedNote = fs.readFileSync(path.join(vault, cleared!.task.file), 'utf-8')
check('更新: 解除すると priority 行が空になる', /^priority:\s*$/m.test(clearedNote))
check('更新: 空文字でも解除できる', (await updateTask(vault, p4.task.taskId, { priority: '' }))?.task.priority === null)

// 5) 他のフィールドを壊さない
const keep = await updateTask(vault, p1.task.taskId, { priority: 'P2' })
const keepNote = fs.readFileSync(path.join(vault, keep!.task.file), 'utf-8')
check('更新: 他の frontmatter を壊さない', keepNote.includes('status: backlog') && keepNote.includes('task-id: 2'))
check('更新: 本文を壊さない', keepNote.includes('## 作業記録') && keepNote.includes('## コメント'))

// 6) 不正値は拒否（ファイルも変えない）
const before = fs.readFileSync(path.join(vault, p1.task.file), 'utf-8')
for (const [name, value] of [
  ['P0', 'P0'],
  ['P5', 'P5'],
  ['高', '高'],
  ['数字', '1'],
] as const) {
  let rejected = false
  try {
    await updateTask(vault, p1.task.taskId, { priority: value })
  } catch {
    rejected = true
  }
  check(`バリデーション: ${name} を拒否`, rejected)
}
check('バリデーション: 拒否時はファイル不変', fs.readFileSync(path.join(vault, p1.task.file), 'utf-8') === before)

let rejectedCreate = false
try {
  await createTask(vault, { title: '不正な優先度', project: 'testproj', priority: 'P0' })
} catch {
  rejectedCreate = true
}
check('バリデーション: 起票時も拒否', rejectedCreate)

// 7) priority を持たない既存ノート（ストーリー1〜10 のノート・Todoist 取込を想定）
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-90 priority のない既存ノート.md'),
  ['---', 'task-id: 90', 'title: priority のない既存ノート', 'project: testproj', 'status: backlog', '---', ''].join(
    '\n',
  ),
  'utf-8',
)
const legacy = await getTask(vault, 90)
check('既存ノート: priority 行が無くても null で読める', legacy?.task.priority === null)

// 8) 一覧（scanTasks）にも載る
const all = await scanTasks(vault)
check('一覧: priority が返る', all.every((t) => t.priority === null || ['P1', 'P2', 'P3', 'P4'].includes(t.priority!)))
// 最終状態: none=解除 / p1=P2（5 で引き下げ）/ p4=解除 / 既存ノート=なし
check('一覧: P2 が1件・P1 は0件', all.filter((t) => t.priority === 'P2').length === 1 && all.every((t) => t.priority !== 'P1'))
check('一覧: 優先度なしが3件', all.filter((t) => t.priority === null).length === 3)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
