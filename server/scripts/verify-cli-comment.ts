// CLI の `comment`（タスクノートへのコメント追記）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作り、CLI を実際に起動して検証する。
// 実行: npx tsx scripts/verify-cli-comment.ts
//
// 方針（2026-07-22 オーナー指示）:
// - 秘書・プロジェクトセッションが手書きすると書式（### <日時> — <書き手>）が仕様とずれるため、
//   コメント追記は CLI 経由に一本化する。書式は web と同じ addComment が付ける
// - 既定の書き手は「秘書」。--author で上書きできる（書き手の値は F1 設計 2.2）
// - ID の受け方・取り違え防止は done と同じ（bismuth-33 でも 33 でも可・project 不一致は拒否）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'cli.ts')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const conf = path.join(vault, 'user-config.json')

const { createTask, getTask } = await import('../src/vault.js')

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

// CLI を実際のコマンドとして起動する（秘書が叩くのと同じ経路を通す）
function runCli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('npx', ['tsx', cli, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, BISMUTH_VAULT: vault, BISMUTH_CONFIG: conf },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

function today(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const t1 = await createTask(vault, { title: 'コメントを付けるタスク', project: 'testproj' })
const t2 = await createTask(vault, { title: '別プロジェクトのタスク', project: 'otherproj' })

// 1) 素の数字の ID でコメントを追記できる（既定の書き手=秘書・仕様どおりの区切り行）
const r1 = runCli(['comment', String(t1.task.taskId), '1件目の実施メモ'])
const note1 = fs.readFileSync(path.join(vault, (await getTask(vault, t1.task.taskId))!.task.file), 'utf-8')
check('comment: 数字の ID で追記できる（終了コード 0）', r1.code === 0, r1.out.trim())
check(
  'comment: 区切り行が仕様どおり（### <YYYY-MM-DD HH:MM> — 秘書）',
  /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} — 秘書$/m.test(note1),
)
check('comment: 本文が「## コメント」セクションに入る', /## コメント[\s\S]*1件目の実施メモ/.test(note1))
check('comment: updated を当日に更新する', (await getTask(vault, t1.task.taskId))?.task.updated === today())

// 2) パーサ（extractComments）が書いたコメントを読める（＝web と往復できる）
const d2 = await getTask(vault, t1.task.taskId)
check(
  'comment: extractComments で読み戻せる',
  d2?.comments.length === 1 && d2.comments[0].author === '秘書' && d2.comments[0].body === '1件目の実施メモ',
)

// 3) project-N 形式＋ --author 上書き
const r3 = runCli(['comment', `testproj-${t1.task.taskId}`, '2件目', '--author', 'bismuthセッション'])
const d3 = await getTask(vault, t1.task.taskId)
check('comment: project-N の ID でも追記できる', r3.code === 0, r3.out.trim())
check(
  'comment: --author で書き手を上書きできる',
  d3?.comments.length === 2 && d3.comments[1].author === 'bismuthセッション',
)
check('comment: 追記は末尾（1件目の後ろ）', d3?.comments[0].body === '1件目の実施メモ')

// 4) プロジェクト名が食い違う ID は止める（取り違えの防止）
const r4 = runCli(['comment', `alpha-${t2.task.taskId}`, '誤爆コメント'])
check(
  'comment: project が食い違う ID は拒否して実データの所属を教える',
  r4.code === 1 && r4.out.includes('otherproj のタスクです'),
  r4.out.trim(),
)
check('comment: 拒否時は書き込まない', (await getTask(vault, t2.task.taskId))?.comments.length === 0)

// 5) 存在しない ID はエラー（終了コード 1）
const r5 = runCli(['comment', '999', 'コメント'])
check('comment: 存在しない ID はエラー', r5.code === 1 && r5.out.includes('見つかりません'), r5.out.trim())

// 6) ID や本文が無ければ使い方を出す
const r6 = runCli(['comment', String(t1.task.taskId)])
check('comment: 本文なしはエラー', r6.code === 1 && r6.out.includes('本文が必要'), r6.out.trim())

// 7) 見出し（# / ## / ###）入りの本文はセクション構造を壊すので拒否する
const r7 = runCli(['comment', String(t1.task.taskId), '## 見出しを含む本文'])
check('comment: 見出し入り本文は拒否', r7.code === 1 && r7.out.includes('見出し'), r7.out.trim())
check('comment: 拒否時はコメント数が増えない', (await getTask(vault, t1.task.taskId))?.comments.length === 2)

// 8) 他のセクション・属性は壊さない
const note8 = fs.readFileSync(path.join(vault, (await getTask(vault, t1.task.taskId))!.task.file), 'utf-8')
check('comment: 本文の節を壊さない', note8.includes('## 作業記録') && note8.includes('## 成果物・関連リンク'))
check('comment: タイトルは変えない', note8.includes('title: コメントを付けるタスク'))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
