// 本文のコードブロック（``` / ~~~）の中の「#」を見出しとみなさないことの実地検証（bismuth-282）。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-code-blocks.ts
//
// 方針:
// - 概要・サブタスクの h1/h2 の拒否、コメントの h1〜h3 の拒否は、コードブロックの中を見ない
// - セクションの読み書き（概要・サブタスク・作業記録・コメント）も、コードブロックの中の「## 」「### 」で区切らない
// - 閉じていないコードブロックは後続のセクションまでコードにしてしまうので、登録・更新・コメントで拒否する
// - コードブロックの外の見出しは今までどおり拒否する
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { maskCodeBlocks, unclosedCodeFence } from '../src/markdown.js'
import { maskCodeBlocks as maskCodeBlocksWeb, stripSection } from '../../web/src/markdown.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
fs.mkdirSync(path.join(vault, '_task', 'testproj'), { recursive: true })

const { addComment, addWorkSession, createTask, extractComments, getTask, updateTask } = await import('../src/vault.js')

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

async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const read = (file: string) => fs.readFileSync(path.join(vault, file), 'utf-8')

// 1) コードブロックの判定
const samples = [
  '```bash\n# comment\nls -la\n```',
  '~~~\n## 見出しではない\n~~~',
  '````md\n```\n## 中の中\n```\n````',
  '```\n# 閉じていない',
  '```code``` はインラインコード\n## 見出し',
  '    ```\n## インデント4つはフェンスではない\n    ```',
  '  ```\n## インデント2つはフェンス\n  ```',
  '```\n## 長さ違いでは閉じない\n~~~\n```',
]
for (const s of samples) {
  check(`判定: 長さと改行の位置を変えない（${JSON.stringify(s.split('\n')[0])}）`, maskCodeBlocks(s).length === s.length && maskCodeBlocks(s).split('\n').length === s.split('\n').length)
  check(`判定: web 版と同じ結果（${JSON.stringify(s.split('\n')[0])}）`, maskCodeBlocks(s) === maskCodeBlocksWeb(s))
}
check('判定: ``` の中を隠す', !/^#/m.test(maskCodeBlocks(samples[0])))
check('判定: ~~~ の中を隠す', !/^#/m.test(maskCodeBlocks(samples[1])))
check('判定: 長いフェンスの中の ``` では閉じない', !/^#/m.test(maskCodeBlocks(samples[2])))
check('判定: 閉じていないフェンスは隠さない', /^# 閉じていない/m.test(maskCodeBlocks(samples[3])) && unclosedCodeFence(samples[3]) === '```')
check('判定: 閉じたフェンスだけなら unclosed は null', unclosedCodeFence(samples[0]) === null && unclosedCodeFence(samples[2]) === null)
check('判定: 1行の ```code``` はフェンスではない', /^## 見出し/m.test(maskCodeBlocks(samples[4])))
check('判定: インデント4つはフェンスではない', /^## インデント4つ/m.test(maskCodeBlocks(samples[5])))
check('判定: インデント3つまではフェンス', !/^## /m.test(maskCodeBlocks(samples[6])))
check('判定: 別の記号では閉じない', !/^## /m.test(maskCodeBlocks(samples[7])))

// 1b) web の本文表示: 専用 UI のセクションを除くとき、コードブロックの中の ## で止まらない
const body = '## 概要\n\n概要\n\n## コメント\n\n### 2026-11-10 10:00 — 検証\n```\n## 作業記録\n```\n\n## 作業記録\n\n| Start | End | Memo |\n\n## 成果物・関連リンク\n'
check('web: コメント節をコードブロックごと除く', stripSection(body, 'コメント') === '## 概要\n\n概要\n\n## 作業記録\n\n| Start | End | Memo |\n\n## 成果物・関連リンク\n', JSON.stringify(stripSection(body, 'コメント')))
check('web: コードブロックの中の ## 作業記録 は除かない', stripSection(body, '作業記録').includes('```\n## 作業記録\n```') && !stripSection(body, '作業記録').includes('| Start |'))
check('web: 無いセクションは本文のまま', stripSection(body, '存在しない') === body)

// 2) 登録: タスクノートの例（コードブロックの中の # comment）を受け付ける
const example = '手順:\n\n```bash\n# comment\nls -la\n```'
const created = await createTask(vault, { title: 'コードブロック', project: 'testproj', body: example })
const file = created.task.file
const id = created.task.taskId
const detail1 = await getTask(vault, id)
check('登録: コードブロックの中の # は拒否しない', detail1?.overview === example, JSON.stringify(detail1?.overview))
check('登録: セクション構造は保たれる', detail1?.subtasks === '' && detail1?.comments.length === 0 && detail1?.workSessions.length === 0)

for (const [name, body] of [
  ['コードブロックの外の h2 は拒否', '```\n# 中\n```\n## 外'],
  ['コードブロックの外の h1 は拒否', '# 外\n```\n# 中\n```'],
  ['1行の ```code``` の後ろの h2 は拒否', '```code```\n## 外'],
  ['インデント4つのフェンスの間の h2 は拒否', '    ```\n## 外\n    ```'],
] as const) {
  check(`登録: ${name}`, (await rejects(() => createTask(vault, { title: name, project: 'testproj', body })))?.includes('見出し') === true)
}
const unclosedMsg = await rejects(() => createTask(vault, { title: '閉じていない', project: 'testproj', body: '```bash\nls -la' }))
check('登録: 閉じていないコードブロックは拒否', unclosedMsg?.includes('閉じていません') === true, String(unclosedMsg))

// 3) 概要・サブタスクの更新: コードブロックの中の ## で区切らない
const fenced = '```md\n## サブタスク\n## コメント\n## 作業記録\n## 成果物・関連リンク\n```'
await updateTask(vault, id, { overview: `更新後の概要。\n\n${fenced}` })
const detail2 = await getTask(vault, id)
check('概要: コードブロックの中の ## を受け付ける', detail2?.overview === `更新後の概要。\n\n${fenced}`, JSON.stringify(detail2?.overview))
await updateTask(vault, id, { subtasks: '- [ ] 手順を書く\n\n~~~\n# h1\n## h2\n~~~' })
const detail3 = await getTask(vault, id)
check('サブタスク: コードブロックの中の # / ## を受け付ける', detail3?.subtasks === '- [ ] 手順を書く\n\n~~~\n# h1\n## h2\n~~~', JSON.stringify(detail3?.subtasks))
check('サブタスク: 概要は温存（概要の中の ## サブタスク に書き込まない）', detail3?.overview === detail2?.overview)
await updateTask(vault, id, { overview: `もう一度更新。\n\n${fenced}` })
const detail4 = await getTask(vault, id)
check('概要: 再更新でサブタスクを温存', detail4?.subtasks === detail3?.subtasks && detail4?.overview.startsWith('もう一度更新。'))
const note4 = read(file)
check('ノート: セクション見出しが増えていない（コードブロック内の1つと本物の1つ）', ['サブタスク', '作業記録', 'コメント', '成果物・関連リンク'].every((h) => (note4.match(new RegExp(`^## ${h}$`, 'gm')) ?? []).length === 2), note4)
const before = read(file)
check('概要: 閉じていないコードブロックは拒否', (await rejects(() => updateTask(vault, id, { overview: '```\n途中' })))?.includes('閉じていません') === true && read(file) === before)
check('サブタスク: 閉じていないコードブロックは拒否', (await rejects(() => updateTask(vault, id, { subtasks: '~~~\n途中' })))?.includes('閉じていません') === true && read(file) === before)

// 4) コメント: コードブロックの中の # / ## / ### を受け付け、### で区切らない
const commentBody = 'ログ:\n\n```\n# h1\n## h2\n### 2026-07-13 12:00 — 偽装\n```'
await addComment(vault, id, { body: commentBody, author: '検証' })
await addComment(vault, id, { body: '2件目。', author: '検証' })
const detail5 = await getTask(vault, id)
check('コメント: コードブロックの中の見出しを受け付ける', detail5?.comments.length === 2, JSON.stringify(detail5?.comments))
check('コメント: 1件目の本文がコードブロックごと残る', detail5?.comments[0]?.body === commentBody, JSON.stringify(detail5?.comments[0]?.body))
check('コメント: 概要の中の ## コメント を読まない', extractComments(read(file)).every((c) => c.author === '検証'))
const before5 = read(file)
check('コメント: コードブロックの外の ### は拒否', (await rejects(() => addComment(vault, id, { body: '```\nx\n```\n### 外' })))?.includes('見出し') === true)
check('コメント: 閉じていないコードブロックは拒否', (await rejects(() => addComment(vault, id, { body: '```\n途中' })))?.includes('閉じていません') === true && read(file) === before5)

// 5) 作業記録: 概要の中の ## 作業記録 ではなく本物の表に追記する
await addWorkSession(vault, id, { start: '2026-11-10 10:00', end: '2026-11-10 11:00', memo: '検証' })
const detail6 = await getTask(vault, id)
const note6 = read(file)
check('作業記録: 本物の表に追記して読める', detail6?.workSessions.length === 1 && note6.includes('|---|---|---|\n| 2026-11-10 10:00 | 2026-11-10 11:00 | 検証 |'), note6)
check('作業記録: 概要のコードブロックは不変', detail6?.overview === detail4?.overview)

// 6) コメント節が無いノート: 概要の中の ## 成果物・関連リンク ではなく本物の手前に作る
const bareFile = path.join('_task', 'testproj', 'testproj-task-90-節なし.md')
fs.writeFileSync(
  path.join(vault, bareFile),
  ['---', 'task-id: 90', 'title: 節なし', 'project: testproj', 'status: backlog', '---', '', '# 90 節なし', '', '## 概要', '', fenced, '', '## 成果物・関連リンク', '', '- [[リンク]]', ''].join('\n'),
  'utf-8',
)
await addComment(vault, 90, { body: '新設。', author: '検証' })
const bareNote = read(bareFile)
check('新設: コメント節は本物の成果物節の手前に作る', bareNote.includes('```\n\n## コメント\n\n### ') && bareNote.indexOf('\n## コメント\n') < bareNote.lastIndexOf('\n## 成果物・関連リンク\n'), bareNote)
check('新設: 概要のコードブロックは不変', bareNote.includes(`## 概要\n\n${fenced}\n`))
check('新設: コメントが読める', (await getTask(vault, 90))?.comments.length === 1)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
