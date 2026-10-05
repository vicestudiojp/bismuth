// 作業記録（「## 作業記録」テーブルへの行追記・パース・バリデーション）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-work-sessions.ts
//
// 方針（F1 設計 2.1 / 2.2）:
// - 行は「| Start | End | Memo |」。追記はテーブルの最終行の直後（表を分断しない）
// - 既存行は書き換えない。他セクションは温存する
// - 実施時間は frontmatter に保存しない（この行の合算から導出する）
// - 終了時刻は未記入を許す（作業中・あとで手で追記する運用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addWorkSession, extractWorkSessions, getTask } from '../src/vault.js'

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const dir = path.join(vault, '_task', 'testproj')
fs.mkdirSync(dir, { recursive: true })

const notePath = path.join(dir, 'testproj-1 作業記録検証.md')
const emptyTable = path.join(dir, 'testproj-2 表が空.md')
const noSection = path.join(dir, 'testproj-3 作業記録節なし.md')

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

// 既存行あり（手書きの行を含む）
fs.writeFileSync(
  notePath,
  [
    ...fm(1, '作業記録検証'),
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
    '| 2026-07-10 14:37 | 2026-07-10 14:45 | 手書きの既存行 |',
    '',
    '## コメント',
    '',
    '### 2026-07-10 — 秘書',
    '温存されるべきコメント。',
    '',
    '## 成果物・関連リンク',
    '',
    '- [[温存されるべきリンク]]',
    '',
  ].join('\n'),
  'utf-8',
)

// 表はあるが行が無い（アプリ起票直後の状態）
fs.writeFileSync(
  emptyTable,
  [
    ...fm(2, '表が空'),
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
  ].join('\n'),
  'utf-8',
)

// 「## 作業記録」節そのものが無い（手動起票・Todoist 取込を想定）
fs.writeFileSync(
  noSection,
  [...fm(3, '作業記録節なし'), '## 概要', '', '概要のみ。', '', '## 成果物・関連リンク', '', '- [[既存リンク]]', ''].join(
    '\n',
  ),
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

const today = new Date()
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
  today.getDate(),
).padStart(2, '0')}`

// 1) 既存行のパース（ヘッダー行・区切り行を拾わない）
const before = extractWorkSessions(fs.readFileSync(notePath, 'utf-8'))
check('パース: 既存行1件（ヘッダー・区切りは除外）', before.length === 1, JSON.stringify(before))
check(
  'パース: start/end/memo',
  before[0]?.start === '2026-07-10 14:37' &&
    before[0]?.end === '2026-07-10 14:45' &&
    before[0]?.memo === '手書きの既存行',
)

// 2) 追記（テーブル末尾＝最終行の直後・他セクション温存）
const added = await addWorkSession(vault, 1, {
  start: '2026-07-13 09:00',
  end: '2026-07-13 10:30',
  memo: '追記された行',
})
const note1 = fs.readFileSync(notePath, 'utf-8')

check('追記: detail が返る', added !== null)
check('追記: 2件になる', added?.workSessions.length === 2)
check('追記: 値が正しい', added?.workSessions.at(-1)?.start === '2026-07-13 09:00')
check('追記: 行が表の最終行の直後に入る', note1.includes('| 手書きの既存行 |\n| 2026-07-13 09:00 |'), note1)
check('追記: 表が分断されていない（空行を挟まない）', !/\|\n\n\| 2026-07-13/.test(note1))
check('追記: 既存行を温存', note1.includes('| 2026-07-10 14:37 | 2026-07-10 14:45 | 手書きの既存行 |'))
check(
  '追記: 他セクションを温存',
  note1.includes('温存されるべき概要。') &&
    note1.includes('- [ ] 温存されるべきサブタスク') &&
    note1.includes('温存されるべきコメント。') &&
    note1.includes('- [[温存されるべきリンク]]'),
)
check('追記: updated を当日に更新', note1.includes(`updated: ${todayStr}`))
check('追記: frontmatter の他キーは不変', note1.includes('created: 2026-07-10') && note1.includes('status: backlog'))
check('追記: 実施時間は frontmatter に保存しない', !/^actual:/m.test(note1) && !/^spent:/m.test(note1))

// 3) 終了時刻なし（作業中）
await addWorkSession(vault, 1, { start: '2026-07-13 11:00' })
const detail1 = await getTask(vault, 1)
check('追記: 終了時刻なしを許す', detail1?.workSessions.at(-1)?.end === null)
check('追記: 空セルで書かれる', fs.readFileSync(notePath, 'utf-8').includes('| 2026-07-13 11:00 |  |  |'))

// 4) メモのサニタイズ（テーブルを壊す文字）
await addWorkSession(vault, 1, { start: '2026-07-13 13:00', end: '2026-07-13 13:30', memo: 'a|b\nc' })
const detail2 = await getTask(vault, 1)
check('メモ: パイプはエスケープして温存', detail2?.workSessions.at(-1)?.memo === 'a|b c')
check('メモ: 改行を潰して1行にする', extractWorkSessions(fs.readFileSync(notePath, 'utf-8')).length === 4)

// 5) バリデーション
for (const [name, input] of [
  ['開始時刻が空', { start: '' }],
  ['開始時刻の形式違反', { start: '2026/07/13 09:00' }],
  ['日付だけ（時刻なし）', { start: '2026-07-13' }],
  ['終了時刻の形式違反', { start: '2026-07-13 09:00', end: '9:00' }],
  ['終了が開始より前', { start: '2026-07-13 10:00', end: '2026-07-13 09:00' }],
] as const) {
  let rejected = false
  try {
    await addWorkSession(vault, 1, input)
  } catch {
    rejected = true
  }
  check(`バリデーション: ${name}を拒否`, rejected)
}
check('バリデーション: 拒否時はファイル不変', extractWorkSessions(fs.readFileSync(notePath, 'utf-8')).length === 4)

// 6) 表はあるが行が無いノート
await addWorkSession(vault, 2, { start: '2026-07-13 08:00', end: '2026-07-13 08:15', memo: '初回' })
const note2 = fs.readFileSync(emptyTable, 'utf-8')
check('空の表: 区切り行の直後に入る', /\|---\|---\|---\|\n\| 2026-07-13 08:00 /.test(note2), note2)
check('空の表: パースできる', extractWorkSessions(note2).length === 1)
check('空の表: コメント節を温存', note2.includes('Bismuth から起票。'))

// 7) 「## 作業記録」節が無いノート → 節ごと新設（成果物節の手前）
await addWorkSession(vault, 3, { start: '2026-07-13 07:00', end: '2026-07-13 07:30' })
const note3 = fs.readFileSync(noSection, 'utf-8')
check('新設: 作業記録節が作られる', note3.includes('## 作業記録') && note3.includes('| Start | End | Memo |'))
check(
  '新設: 成果物節の手前に置かれる',
  note3.indexOf('## 作業記録') < note3.indexOf('## 成果物・関連リンク') && note3.includes('- [[既存リンク]]'),
)
check('新設: パースできる', extractWorkSessions(note3).length === 1)
check('新設: 概要を温存', note3.includes('概要のみ。'))

// 8) 存在しない task-id
check('存在しない task-id は null', (await addWorkSession(vault, 999, { start: '2026-07-13 09:00' })) === null)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
