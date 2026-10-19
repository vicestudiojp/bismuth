// タスク更新（属性・概要・タイトル変更時のリネーム）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-update.ts
//
// 方針（2026-07-10 オーナー判断）:
// - タイトル変更時はファイル名をリネームする。ただし vault 全体のリンク書き換えは
//   リスクが大きいため行わない（リンク非追従は UI が警告する）→ ここでは
//   「他ノートのリンクが書き換えられないこと」を検証する
// - 本文編集は「## 概要」セクションのみ。概要に h1/h2 見出しは使用不可（登録時も）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTask, findDuplicateIds, scanTasks, updateTask } from '../src/vault.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

const oldTitle = '旧タイトル(検証+用)テキスト'
const oldBase = `testproj-1 ${oldTitle}`

fs.writeFileSync(
  path.join(vault, '_task', 'testproj', `${oldBase}.md`),
  [
    '---',
    'task-id: 1',
    `title: ${oldTitle}`,
    'project: testproj',
    'status: backlog',
    'due:',
    'tags: [testproj, task]',
    'estimate:',
    'parent:',
    'order:',
    'created: 2026-07-10',
    'updated: 2026-07-10',
    'todoist-id:',
    '---',
    '',
    `# 1 ${oldTitle}`,
    '',
    '## 概要',
    '',
    '検証用の概要。差し替え前のテキスト。',
    '',
    '## サブタスク',
    '',
    '- [ ] 温存されるべきサブタスク',
    '',
    '## コメント',
    '',
    '### 2026-07-10 — 秘書',
    '温存されるべきコメント。',
    '',
  ].join('\n'),
  'utf-8',
)

fs.writeFileSync(
  path.join(vault, 'ref.md'),
  `参照リンク（書き換えられないこと）: [[${oldBase}]]\n`,
  'utf-8',
)

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

// 1) 属性＋タイトル変更（リネーム）
const newTitle = '新タイトル 更新版'
const result = await updateTask(vault, 1, {
  title: newTitle,
  status: 'dotoday',
  due: '2026-07-15',
  estimate: 90,
  tags: ['testproj', 'task', 'edited'],
})

// 種ノートは旧規則 `testproj-1 <title>` で置いてある（＝アプリ導入前からある既存ノート）。
// タイトル変更時のリネームは現行規則 `testproj-task-1-<title>` に移すことを検証する
const newBase = `testproj-task-1-${newTitle}`
const newPath = path.join(vault, '_task', 'testproj', `${newBase}.md`)

check('リネーム: 現行規則の新ファイル名で存在', fs.existsSync(newPath))
check('リネーム: renamed 情報が返る', result?.renamed?.to === `${newBase}.md`)
check('リネーム: 旧規則のファイルは残っていない', !fs.existsSync(path.join(vault, '_task', 'testproj', `${oldBase}.md`)))

const note1 = fs.readFileSync(newPath, 'utf-8')
check(
  'frontmatter: title/status/due/estimate/tags 更新',
  note1.includes(`title: ${newTitle}`) &&
    note1.includes('status: dotoday') &&
    note1.includes('due: 2026-07-15') &&
    note1.includes('estimate: 90') &&
    note1.includes('tags: [testproj, task, edited]'),
)
check('本文 H1 がタイトルに同期', note1.includes(`# 1 ${newTitle}`))

const ref = fs.readFileSync(path.join(vault, 'ref.md'), 'utf-8')
check('他ノートの [[リンク]] は書き換えない', ref.includes(`[[${oldBase}]]`), ref)

// 2) 概要のみの差し替え（他セクション温存）
await updateTask(vault, 1, { overview: '差し替え後の概要。\n\n### h3 は使ってよい' })
const note2 = fs.readFileSync(newPath, 'utf-8')
check('概要: 新テキストが反映', note2.includes('差し替え後の概要。'))
check('概要: h3 は許可', note2.includes('### h3 は使ってよい'))
check('概要: 旧テキストが消えている', !note2.includes('差し替え前のテキスト。'))
check('概要: サブタスク温存', note2.includes('- [ ] 温存されるべきサブタスク'))
check('概要: コメント温存', note2.includes('温存されるべきコメント。'))
check('概要: H1 温存', note2.includes(`# 1 ${newTitle}`))

// 3) 概要の h1/h2 バリデーション（更新時）
let rejected = false
try {
  await updateTask(vault, 1, { overview: '## 見出しを入れてみる' })
} catch {
  rejected = true
}
check('概要バリデーション: h2 を拒否（更新時）', rejected)
check('概要バリデーション: 拒否時にファイル不変', fs.readFileSync(newPath, 'utf-8') === note2)

// 3b) サブタスクの差し替え（bismuth-175。概要・コメントは温存。### 小見出しは可、h1/h2 は拒否）
const sub1 = await updateTask(vault, 1, { subtasks: '### 小見出し\n- [x] 済んだもの\n- [ ] 追加したもの' })
const note3 = fs.readFileSync(newPath, 'utf-8')
check('サブタスク: 新しい中身が反映', note3.includes('## サブタスク\n\n### 小見出し\n- [x] 済んだもの\n- [ ] 追加したもの\n'))
check('サブタスク: 旧サブタスクが消えている', !note3.includes('温存されるべきサブタスク'))
check('サブタスク: 概要温存', note3.includes('差し替え後の概要。'))
check('サブタスク: コメント温存', note3.includes('温存されるべきコメント。'))
check('サブタスク: 詳細の subtasks に返る', sub1?.subtasks === '### 小見出し\n- [x] 済んだもの\n- [ ] 追加したもの', String(sub1?.subtasks))
const cleared = await updateTask(vault, 1, { subtasks: '' })
const note4 = fs.readFileSync(newPath, 'utf-8')
check('サブタスク: 空にすると見出しだけ残る', note4.includes('## サブタスク\n\n## コメント') && cleared?.subtasks === '', JSON.stringify(cleared?.subtasks))
let rejectedSub = false
try {
  await updateTask(vault, 1, { subtasks: '## 見出し' })
} catch {
  rejectedSub = true
}
check('サブタスク: h2 を拒否', rejectedSub && fs.readFileSync(newPath, 'utf-8') === note4)
// 「## サブタスク」が無い旧ノートには概要の直後に作る
const legacyPath = path.join(vault, '_task', 'testproj', 'testproj-task-2-旧ノート.md')
fs.writeFileSync(
  legacyPath,
  ['---', 'task-id: 2', 'title: 旧ノート', 'project: testproj', 'status: backlog', '---', '', '# 2 旧ノート', '', '## 概要', '', '概要のみ', '', '## コメント', ''].join('\n'),
  'utf-8',
)
await updateTask(vault, 2, { subtasks: '- [ ] 新規' })
check(
  'サブタスク: セクションが無ければ概要の直後に作る',
  fs.readFileSync(legacyPath, 'utf-8').includes('概要のみ\n\n## サブタスク\n\n- [ ] 新規\n\n## コメント'),
  fs.readFileSync(legacyPath, 'utf-8'),
)
fs.rmSync(legacyPath)

// 4) 登録時の h1/h2 バリデーション
let rejectedCreate = false
try {
  await createTask(vault, { title: 'バリデーション確認', project: 'testproj', body: '# h1 見出し' })
} catch {
  rejectedCreate = true
}
check('概要バリデーション: h1 を拒否（登録時）', rejectedCreate)

// 5) 完了日（completed）: done への遷移で記録し、done から戻すと消える（bismuth-44）
const now = new Date()
const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const done1 = await updateTask(vault, 1, { status: 'done' })
check(
  'completed: done への遷移で今日の日時（分まで・bismuth-223）が入る',
  new RegExp(`^${todayStr}T\\d{2}:\\d{2}$`).test(done1?.task.completed ?? ''),
  String(done1?.task.completed),
)
const kept = await updateTask(vault, 1, { estimate: 5 })
check('completed: done のまま属性更新しても維持', kept?.task.completed === done1?.task.completed, String(kept?.task.completed))
const reopened = await updateTask(vault, 1, { status: 'backlog' })
check('completed: done から戻すと消える', reopened?.task.completed === null, String(reopened?.task.completed))

// 5b) 更新日も分まで記録する。日付だけの既存 created は書き換えない。何も変えない保存では updated を動かさない
check('updated: 今日の日時（分まで）', new RegExp(`^${todayStr}T\\d{2}:\\d{2}$`).test(reopened?.task.updated ?? ''), String(reopened?.task.updated))
check('created: 日付だけの既存値はそのまま', reopened?.task.created === '2026-07-10', String(reopened?.task.created))
const file1 = path.join(vault, reopened!.task.file)
const setUpdated = (v: string) =>
  fs.writeFileSync(file1, fs.readFileSync(file1, 'utf-8').replace(/^updated: .*$/m, `updated: ${v}`), 'utf-8')
setUpdated('2026-07-11T09:30')
const noop = await updateTask(vault, 1, { estimate: 5 })
check('updated: 何も変えない保存では動かさない', noop?.task.updated === '2026-07-11T09:30', String(noop?.task.updated))
// Obsidian 等で秒まで書かれた値は js-yaml が Date にするが、書かれた時刻のまま読む
setUpdated('2026-07-11T09:30:15')
const withSec = (await scanTasks(vault)).find((t) => t.taskId === 1)
check('updated: 秒付きの値も時刻を落とさず読む', withSec?.updated === '2026-07-11T09:30', String(withSec?.updated))

// 6) order（手動並べ替え）: 設定・解除できる。中間値の小数も書ける
const ordered = await updateTask(vault, 1, { order: 15.5 })
check('order: 数値（小数可）を設定できる', ordered?.task.order === 15.5, String(ordered?.task.order))
const clearedOrder = await updateTask(vault, 1, { order: null })
check('order: null で解除できる', clearedOrder?.task.order === null, String(clearedOrder?.task.order))

// 7) 重複 task-id の検出
fs.writeFileSync(
  path.join(vault, '_task', 'testproj', 'testproj-1 重複ノート.md'),
  ['---', 'task-id: 1', 'title: 重複ノート', 'project: testproj', 'status: backlog', '---', ''].join('\n'),
  'utf-8',
)
const dupWarnings = findDuplicateIds(await scanTasks(vault))
check('重複 ID を検出して警告', dupWarnings.length === 1 && dupWarnings[0].includes('task-id 1'))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
