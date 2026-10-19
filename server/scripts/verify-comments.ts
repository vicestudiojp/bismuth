// コメント追記（「## コメント」セクションへの追記・パース・バリデーション）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-comments.ts
//
// 方針（F1 設計 2.2）:
// - 追記は常にセクション末尾へ。既存行は書き換えない
// - 1 コメント = 「### <日時> — <書き手>」。手書きコメント（秘書・セッション）も同形式で読める
// - コメント本文はセクション構造を壊してはならない（# / ## / ### を禁止・#### 以下は可）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addComment, createTask, extractComments, getTask } from '../src/vault.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const dir = path.join(vault, '_task', 'testproj')
fs.mkdirSync(dir, { recursive: true })

const notePath = path.join(dir, 'testproj-1 コメント検証.md')
const bare = path.join(dir, 'testproj-2 コメント節なし.md')
const minimal = path.join(dir, 'testproj-3 節が何もない.md')

function fm(id: number, title: string): string[] {
  return [
    '---',
    `task-id: ${id}`,
    `title: ${title}`,
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
    `# ${id} ${title}`,
    '',
  ]
}

fs.writeFileSync(
  notePath,
  [
    ...fm(1, 'コメント検証'),
    '## 概要',
    '',
    '温存されるべき概要。',
    '',
    '## サブタスク',
    '',
    '- [ ] 温存されるべきサブタスク',
    '',
    '## 作業記録',
    '',
    '| Start | End | Memo |',
    '|---|---|---|',
    '',
    '## コメント',
    '',
    '### 2026-07-10 — アプリ',
    'Bismuth から起票。',
    '',
    '### 2026-07-10 14:35 — 秘書',
    '既存コメント（複数行）。',
    '2行目も本文に含まれること。',
    '',
    '## 成果物・関連リンク',
    '',
    '- [[温存されるべきリンク]]',
    '',
  ].join('\n'),
  'utf-8',
)

// コメント節が無いノート（手動起票・Todoist 取込などで起こりうる）
fs.writeFileSync(
  bare,
  [...fm(2, 'コメント節なし'), '## 概要', '', '概要のみ。', '', '## 成果物・関連リンク', '', '- [[既存リンク]]', ''].join(
    '\n',
  ),
  'utf-8',
)

// 概要しか無いノート（アンカーになる節すら無い）
fs.writeFileSync(minimal, [...fm(3, '節が何もない'), '## 概要', '', '概要のみ。', ''].join('\n'), 'utf-8')

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

// 1) 既存コメントのパース（時刻あり・なし／複数行本文）
const before = extractComments(fs.readFileSync(notePath, 'utf-8'))
check('パース: 既存コメント2件', before.length === 2, JSON.stringify(before))
check('パース: 時刻なし（アプリ起票）', before[0]?.at === '2026-07-10' && before[0]?.author === 'アプリ')
check('パース: 時刻あり（手書き・秘書）', before[1]?.at === '2026-07-10 14:35' && before[1]?.author === '秘書')
check('パース: 複数行の本文を保持', before[1]?.body.includes('2行目も本文に含まれること。') === true)

// 2) 追記（セクション末尾へ・他セクション温存）
const added = await addComment(vault, 1, { body: '追記されたコメント。\n\n#### h4 は使ってよい' })
const note1 = fs.readFileSync(notePath, 'utf-8')

check('追記: detail が返る', added !== null)
check('追記: 書き手はデフォルトでオーナー', added?.comments.at(-1)?.author === 'オーナー')
check('追記: 日時スタンプ（YYYY-MM-DD HH:MM）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(added?.comments.at(-1)?.at ?? ''))
check('追記: コメント3件になる', added?.comments.length === 3)
check('追記: h4 は許可', note1.includes('#### h4 は使ってよい'))
check(
  '追記: コメントセクションの末尾に入る（成果物節の前）',
  note1.indexOf('追記されたコメント。') > note1.indexOf('### 2026-07-10 14:35 — 秘書') &&
    note1.indexOf('追記されたコメント。') < note1.indexOf('## 成果物・関連リンク'),
)
check('追記: 既存コメントを温存', note1.includes('既存コメント（複数行）。') && note1.includes('Bismuth から起票。'))
check(
  '追記: 他セクションを温存',
  note1.includes('温存されるべき概要。') &&
    note1.includes('- [ ] 温存されるべきサブタスク') &&
    note1.includes('| Start | End | Memo |') &&
    note1.includes('- [[温存されるべきリンク]]'),
)
check('追記: updated を当日の日時（分まで）に更新', new RegExp(`^updated: ${todayStr}T\\d{2}:\\d{2}$`, 'm').test(note1))
check('追記: frontmatter の他キーは不変', note1.includes('created: 2026-07-10') && note1.includes('status: backlog'))
check('追記: 見出しの直後に本文が続く（空行を挟まない）', /### .+ — オーナー\n追記されたコメント。/.test(note1))

// 3) 書き手の指定（秘書・プロジェクトセッションからの追記）
await addComment(vault, 1, { body: '秘書からのコメント。', author: '秘書' })
const detail1 = await getTask(vault, 1)
check('追記: 書き手を指定できる', detail1?.comments.at(-1)?.author === '秘書')
check('追記: 4件が順に並ぶ', detail1?.comments.length === 4)

// 4) バリデーション（セクション構造を壊す見出し・空コメント）
for (const [name, body] of [
  ['h2 を拒否', '## 見出し'],
  ['h3 を拒否（コメント区切りと衝突）', '### 2026-07-13 12:00 — 偽装'],
  ['h1 を拒否', '# 見出し'],
  ['空コメントを拒否', '   \n  '],
] as const) {
  let rejected = false
  try {
    await addComment(vault, 1, { body })
  } catch {
    rejected = true
  }
  check(`バリデーション: ${name}`, rejected)
}
const note2 = fs.readFileSync(notePath, 'utf-8')
check('バリデーション: 拒否時はファイル不変', extractComments(note2).length === 4, note2)

// 5) コメント節が無いノート → 成果物節の手前に新設
await addComment(vault, 2, { body: 'セクションを新設して追記。' })
const note3 = fs.readFileSync(bare, 'utf-8')
check('新設: コメント節が作られる', note3.includes('## コメント'))
check(
  '新設: 成果物節の手前に置かれる',
  note3.indexOf('## コメント') < note3.indexOf('## 成果物・関連リンク') && note3.includes('- [[既存リンク]]'),
)
check('新設: パースできる', extractComments(note3).length === 1)

// 6) アンカー節も無いノート → 末尾に新設
await addComment(vault, 3, { body: '末尾に新設。' })
const note4 = fs.readFileSync(minimal, 'utf-8')
check('新設: 末尾に作られる', note4.includes('## コメント') && extractComments(note4).length === 1)
check('新設: 概要を温存', note4.includes('概要のみ。'))

// 7) 存在しない task-id
check('存在しない task-id は null', (await addComment(vault, 999, { body: 'x' })) === null)

// 8) 起票時に既定コメントを付けない（2026-07-16 オーナー指示で廃止）
const fresh = await createTask(vault, { title: '起票直後のタスク', project: 'testproj' })
const freshDetail = await getTask(vault, fresh.task.taskId)
const freshNote = fs.readFileSync(path.join(vault, fresh.task.file), 'utf-8')
check('起票: 既定コメントを付けない（コメント0件）', freshDetail?.comments.length === 0, `count=${freshDetail?.comments.length}`)
check('起票: 「Bismuth から起票」を書かない', !freshNote.includes('Bismuth から起票'))
check('起票: 空の ## コメント 節と ## 成果物 節は残す', /##\s*コメント/.test(freshNote) && /##\s*成果物・関連リンク/.test(freshNote))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
