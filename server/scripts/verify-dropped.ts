// dropped（やらない）ステータスの実地検証（bismuth-179）。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作り、vault 関数と CLI を実際に起動して検証する。
// 実行: npx tsx scripts/verify-dropped.ts
//
// 方針（2026-09-26 オーナー指示）:
// - 削除ではなく「起票した事実は残してやらなくなった」タスクに使う。ノートは残り、完了日も付かない
// - 一覧には出さない。web のボードは dropped のカラムを持たない。CLI のボード・--list も既定では出さず、
//   --status dropped で明示したときだけ出す。--json は機械処理用なので全件を返す
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'cli.ts')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const conf = path.join(vault, 'user-config.json')

const { createTask, getTask, updateTask } = await import('../src/vault.js')

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

const keep = await createTask(vault, { title: '続けるタスク', project: 'testproj', status: 'ready' })
const drop = await createTask(vault, { title: 'やめたタスク', project: 'testproj', status: 'ready' })
const doneThenDrop = await createTask(vault, { title: '完了後にやめたタスク', project: 'testproj', status: 'done' })

// 1) web の詳細画面と同じ経路（updateTask）で dropped にできる。ノートは残り、完了日は付かない
const d1 = await updateTask(vault, drop.task.taskId, { status: 'dropped' })
check('dropped: status を dropped に更新できる', d1?.task.status === 'dropped')
check('dropped: ノートは消えずに残る', fs.existsSync(path.join(vault, drop.task.file)))
check('dropped: 完了日は付かない', d1?.task.completed == null)
const note = fs.readFileSync(path.join(vault, drop.task.file), 'utf-8')
check('dropped: 本文の節を壊さない', note.includes('## 概要') && note.includes('## 成果物・関連リンク'))

// 2) done から dropped にしたら完了日は消える（done 以外へ戻したときと同じ扱い）
const d2 = await updateTask(vault, doneThenDrop.task.taskId, { status: 'dropped' })
check('dropped: done から移すと完了日が消える', d2?.task.status === 'dropped' && d2.task.completed == null)

// 3) 番号で引ける（web の No 検索・CLI の done / comment と同じ経路）
check('dropped: task-id で引ける', (await getTask(vault, drop.task.taskId))?.task.status === 'dropped')

// 4) CLI のボード・--list は既定で dropped を出さない
const board = runCli([])
check('CLI ボード: dropped を出さない', board.code === 0 && !board.out.includes('やめたタスク') && board.out.includes('続けるタスク'), board.out)
check('CLI ボード: 件数に dropped を数えない', board.out.includes('(1 / 全3件)'), board.out.split('\n')[0])
const list = runCli(['--list'])
check('CLI --list: dropped を出さない', list.code === 0 && !list.out.includes('やめたタスク') && list.out.includes('続けるタスク'), list.out)

// 5) --status dropped で明示すれば出す
const listDropped = runCli(['--list', '--status', 'dropped'])
check(
  'CLI --list --status dropped: dropped だけ出す',
  listDropped.out.includes('やめたタスク') && listDropped.out.includes('完了後にやめたタスク') && !listDropped.out.includes('続けるタスク'),
  listDropped.out,
)
const boardDropped = runCli(['--status', 'dropped'])
check('CLI ボード --status dropped: Dropped の節に出す', boardDropped.out.includes('## Dropped (2)') && boardDropped.out.includes('やめたタスク'), boardDropped.out)

// 6) --json は機械処理用なので dropped も含めて全件返す
const json = runCli(['--json'])
const arr = JSON.parse(json.out) as { taskId: number; status: string }[]
check('CLI --json: dropped も含む', arr.length === 3 && arr.some((t) => t.taskId === drop.task.taskId && t.status === 'dropped'))

// 7) dropped から戻せる
const back = await updateTask(vault, drop.task.taskId, { status: 'backlog' })
check('dropped: 別ステータスへ戻せる', back?.task.status === 'backlog')
check('dropped: 戻したら CLI ボードに再び出る', runCli([]).out.includes('やめたタスク'))

void keep
console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
