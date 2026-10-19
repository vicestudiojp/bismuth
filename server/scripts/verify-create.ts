// 起票（createTask）のファイル名規則とタグ既定の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-create.ts
//
// 方針（2026-07-17 オーナー指示・bismuth-33 / bismuth-34）:
// - ファイル名は `<project>-task-<id>-<title>.md`（旧 `<project>-<id> <title>.md` は既存ノートのまま残す）
// - 既定タグを付けない。web・CLI・Todoist 取込のどの経路でも自動で [project, task] を入れない
//   （どの経路も createTask を通るので、ここが唯一の入口）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

const { createTask, getTask, scanTasks } = await import('../src/vault.js')

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

// 1) ファイル名は現行規則 <project>-task-<id>-<title>.md
const t1 = await createTask(vault, { title: '一覧画面の並び順を直す', project: 'testproj' })
check(
  '命名: <project>-task-<id>-<title>.md で作られる',
  t1.task.file === path.join('_task', 'testproj', 'testproj-task-1-一覧画面の並び順を直す.md'),
  t1.task.file,
)
check('命名: 実ファイルが存在する', fs.existsSync(path.join(vault, t1.task.file)))

// 2) ファイル名に使えない文字は従来どおり落とす（規則が変わっても sanitize は効く）
const t2 = await createTask(vault, { title: 'A/B:テスト? #tag [x]', project: 'testproj' })
check(
  '命名: 禁止文字を落とす',
  t2.task.file === path.join('_task', 'testproj', 'testproj-task-2-A B テスト tag x.md'),
  t2.task.file,
)

// 3) タグ未指定なら既定タグを付けない（bismuth-33）
check('タグ: 未指定なら空（既定タグを付けない）', t1.task.tags.length === 0, JSON.stringify(t1.task.tags))
const note1 = fs.readFileSync(path.join(vault, t1.task.file), 'utf-8')
check('タグ: frontmatter も空配列', note1.includes('tags: []'), note1.split('\n').find((l) => l.startsWith('tags:')))
check(
  'タグ: プロジェクト名・task が入っていない',
  !note1.includes('tags: [testproj') && !/tags: \[.*task/.test(note1),
)

// 4) 指定したタグだけが入る
const t3 = await createTask(vault, { title: 'タグを指定する', project: 'testproj', tags: ['waiting', '調査'] })
check('タグ: 指定したものだけ入る', t3.task.tags.join(',') === 'waiting,調査', JSON.stringify(t3.task.tags))
check(
  'タグ: frontmatter に書かれる',
  fs.readFileSync(path.join(vault, t3.task.file), 'utf-8').includes('tags: [waiting, 調査]'),
)

// 5) 空配列を渡した場合もタグなし（Todoist 取込＝ラベルなしの経路）
const t4 = await createTask(vault, { title: 'ラベルのない取込タスク', project: 'testproj', tags: [] })
check('タグ: 空配列ならタグなし', t4.task.tags.length === 0, JSON.stringify(t4.task.tags))

// 6) 新しい命名でもスキャン・取得はできる（グロブは <taskFolder>/*/*.md なので命名に依存しない）
check('スキャン: 4件すべて拾える', (await scanTasks(vault)).length === 4)
check('取得: task-id で引ける', (await getTask(vault, 1))?.task.title === '一覧画面の並び順を直す')

// 7) 本文の体裁は従来どおり（H1 は「# <id> <title>」・ファイル名の規則とは独立）
check('本文: H1 は「# <id> <title>」のまま', note1.includes('# 1 一覧画面の並び順を直す'))

// 8) 作成日・更新日は分まで記録する（YYYY-MM-DDTHH:mm・bismuth-223）。完了日は done で起票したときだけ
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
check('日時: created は YYYY-MM-DDTHH:mm', stamp.test(t1.task.created ?? ''), String(t1.task.created))
check('日時: updated は created と同じ', t1.task.updated === t1.task.created, String(t1.task.updated))
check('日時: frontmatter にも同じ値', note1.includes(`created: ${t1.task.created}\nupdated: ${t1.task.created}\n`))
check('日時: 読み戻しても文字列のまま（Date 化されない）', (await getTask(vault, 1))?.task.created === t1.task.created)
const t5 = await createTask(vault, { title: '完了で起票する', project: 'testproj', status: 'done' })
check('日時: done で起票すると completed も分まで', t5.task.completed === t5.task.created, String(t5.task.completed))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
