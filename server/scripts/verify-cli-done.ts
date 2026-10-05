// CLI の `done`（タスクを完了にする）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作り、CLI を実際に起動して検証する。
// 実行: npx tsx scripts/verify-cli-done.ts
//
// 方針（2026-07-17 オーナー指示）:
// - タスク ID を渡すだけで完了にできる。ID は会話・一覧に出る `bismuth-33` でも素の `33` でも受ける
// - task-id はグローバル通し番号なので、`<project>-<id>` で渡されたらプロジェクトの一致も確かめる
//   （別プロジェクトの同番号を掴む取り違えを防ぐ）
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

const t1 = await createTask(vault, { title: '数字だけで完了にする', project: 'testproj', status: 'dotoday' })
const t2 = await createTask(vault, { title: 'project-N で完了にする', project: 'testproj' })
const t3 = await createTask(vault, { title: 'まとめて完了 その1', project: 'testproj' })
const t4 = await createTask(vault, { title: 'まとめて完了 その2', project: 'otherproj' })

// 1) 素の数字で完了にできる
const r1 = runCli(['done', String(t1.task.taskId)])
check('done: 数字の ID で完了にできる', (await getTask(vault, t1.task.taskId))?.task.status === 'done')
check('done: 変更前のステータスも出す', r1.out.includes('dotoday → done'), r1.out.trim())
check('done: 終了コード 0', r1.code === 0)
check('done: 完了日（completed）を記録する', (await getTask(vault, t1.task.taskId))?.task.completed != null)

// 2) 会話で使う project-N 形式でも完了にできる
runCli(['done', `testproj-${t2.task.taskId}`])
check('done: project-N の ID で完了にできる', (await getTask(vault, t2.task.taskId))?.task.status === 'done')

// 3) 複数まとめて完了にできる（プロジェクトが混ざっていてもよい）
const r3 = runCli(['done', `testproj-${t3.task.taskId}`, String(t4.task.taskId)])
check(
  'done: 複数の ID をまとめて完了にできる',
  (await getTask(vault, t3.task.taskId))?.task.status === 'done' &&
    (await getTask(vault, t4.task.taskId))?.task.status === 'done',
  r3.out.trim(),
)

// 4) 既に done なら何もしない（エラーにもしない）
const r4 = runCli(['done', String(t1.task.taskId)])
check('done: 既に done なら知らせるだけ', r4.code === 0 && r4.out.includes('既に done'), r4.out.trim())

// 5) 存在しない ID はエラー（終了コード 1）
const r5 = runCli(['done', '999'])
check('done: 存在しない ID はエラー', r5.code === 1 && r5.out.includes('見つかりません'), r5.out.trim())

// 6) プロジェクト名が食い違う ID は止める（取り違えの防止）
const r6 = runCli(['done', `alpha-${t4.task.taskId}`])
check(
  'done: project が食い違う ID は拒否して実データの所属を教える',
  r6.code === 1 && r6.out.includes('otherproj のタスクです'),
  r6.out.trim(),
)

// 7) ID なしで呼んだら使い方を出す
const r7 = runCli(['done'])
check('done: ID を渡さないとエラー', r7.code === 1 && r7.out.includes('ID が必要です'), r7.out.trim())

// 8) 完了しても本文・他の属性は壊さない
const note = fs.readFileSync(path.join(vault, (await getTask(vault, t1.task.taskId))!.task.file), 'utf-8')
check('done: 本文の節を壊さない', note.includes('## 作業記録') && note.includes('## 成果物・関連リンク'))
check('done: タイトルは変えない', note.includes('title: 数字だけで完了にする'))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
