// CLI の `tag`（タグの付け外し）の実地検証。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作り、CLI を実際に起動して検証する。
// 実行: npx tsx scripts/verify-cli-tag.ts
//
// 方針（2026-09-25 オーナー指示）:
// - 無人実行（外部の自動化スクリプトなど）が処理済みのタスクを ai → ai-done に付け替えるために使う
// - ID の受け方・取り違え防止は done / comment と同じ
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

const t1 = await createTask(vault, { title: 'タグを付け替えるタスク', project: 'testproj', tags: ['ai', 'keep'] })
const t2 = await createTask(vault, { title: '別プロジェクトのタスク', project: 'otherproj', tags: ['ai'] })

// 1) 付け替え（remove と add を同時に）。他のタグは残す
const r1 = runCli(['tag', `testproj-${t1.task.taskId}`, '--add', 'ai-done', '--remove', 'ai'])
const d1 = await getTask(vault, t1.task.taskId)
check('tag: 付け替えできる（終了コード 0）', r1.code === 0, r1.out.trim())
check('tag: ai が外れ ai-done が付き、他のタグは残る', JSON.stringify(d1?.task.tags) === '["keep","ai-done"]', JSON.stringify(d1?.task.tags))

// 2) 既に付いているタグは重複させない
runCli(['tag', String(t1.task.taskId), '--add', 'ai-done,keep'])
check('tag: 既存タグは重複しない', JSON.stringify((await getTask(vault, t1.task.taskId))?.task.tags) === '["keep","ai-done"]')

// 3) CLI の --tag 絞り込みで ai-done が拾え、ai では拾えない
const r3 = runCli(['--json', '--tag', 'ai'])
const ids = (JSON.parse(r3.out) as { taskId: number }[]).map((t) => t.taskId)
check('tag: 付け替え後は --tag ai に出ない', !ids.includes(t1.task.taskId) && ids.includes(t2.task.taskId))

// 4) project が食い違う ID は拒否して書き込まない
const r4 = runCli(['tag', `alpha-${t2.task.taskId}`, '--remove', 'ai'])
check('tag: project が食い違う ID は拒否', r4.code === 1 && r4.out.includes('otherproj のタスクです'), r4.out.trim())
check('tag: 拒否時は書き込まない', JSON.stringify((await getTask(vault, t2.task.taskId))?.task.tags) === '["ai"]')

// 5) --add / --remove が無ければ使い方を出す
const r5 = runCli(['tag', String(t1.task.taskId)])
check('tag: --add/--remove なしはエラー', r5.code === 1 && r5.out.includes('--add / --remove'), r5.out.trim())

// 6) 存在しない ID はエラー
const r6 = runCli(['tag', '999', '--add', 'x'])
check('tag: 存在しない ID はエラー', r6.code === 1 && r6.out.includes('見つかりません'), r6.out.trim())

// 7) 本文は壊さない
const note = fs.readFileSync(path.join(vault, (await getTask(vault, t1.task.taskId))!.task.file), 'utf-8')
check('tag: 本文の節を壊さない', note.includes('## コメント') && note.includes('## 成果物・関連リンク'))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
