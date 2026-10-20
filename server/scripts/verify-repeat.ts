// 繰り返しタスク（frontmatter の repeat）の実地検証（bismuth-191）。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx scripts/verify-repeat.ts
//
// 方針（2026-10-20 オーナー決定）:
// - ノートを使い回す。done にしたら期限を次回へ進め、ステータスは常に backlog に戻す
// - 次回期限は期限基準（期限が無ければ完了日）。今日以前なら今日を越えるまで進める（溜めた回は消化させない）
// - 完了の履歴はコメントに 1 行（書き手「アプリ」）。チェック済みのサブタスクは未完了に戻す
// - monthly は期限の日を使い、その日が無い月は月末（ずれは許容）
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'cli.ts')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const conf = path.join(vault, 'user-config.json')

const { nextDue, normalizeRepeat, parseRepeat, repeatLabel } = await import('../src/recurrence.js')
const { createTask, findInvalidRepeats, getTask, scanTasks, updateTask } = await import('../src/vault.js')

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

// ローカル日付で today ± n 日（アプリの「今日」と同じ基準）
function dayOffset(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 1) ルールの解析・正規化・表示名
check('parse: daily', parseRepeat('daily')?.kind === 'daily')
check('parse: 大文字・前後空白も受ける', parseRepeat('  Weekly ')?.kind === 'weekly')
check('parse: 曜日指定は日曜始まりに並べ直す', normalizeRepeat('weekly:thu,mon') === 'weekly:mon,thu')
check('parse: every:3d', normalizeRepeat('every:3d') === 'every:3d')
check('parse: 空は繰り返さない（null）', normalizeRepeat('') === null && normalizeRepeat(null) === null)
for (const bad of ['yearly', 'weekly:', 'weekly:xyz', 'every:0d', 'every:3w', 'every:d']) {
  let threw = false
  try {
    normalizeRepeat(bad)
  } catch {
    threw = true
  }
  check(`parse: 不正な書式「${bad}」は保存時にエラー`, threw)
}
check('label: 毎週 月・木', repeatLabel(parseRepeat('weekly:mon,thu')!) === '毎週 月・木')
check('label: 3 日ごと', repeatLabel(parseRepeat('every:3d')!) === '3 日ごと')

// 2) 次回期限の計算（設計書 3.2 の表）
const cases: [string, string | null, string, string][] = [
  ['daily', '2026-10-20', '2026-10-20', '2026-10-21'], // 当日に完了
  ['daily', '2026-10-17', '2026-10-20', '2026-10-21'], // 3 日溜めた → 明日 1 回だけ
  ['weekly', '2026-10-23', '2026-10-20', '2026-10-30'], // 前倒しで完了
  ['weekly', '2026-10-06', '2026-10-20', '2026-10-27'], // 2 週溜めた → 曜日を保って今日の先へ
  ['biweekly', '2026-10-20', '2026-10-20', '2026-11-03'],
  ['weekly:mon,thu', null, '2026-10-20', '2026-10-22'], // 期限なし（火曜に完了）→ 木曜
  ['weekly:mon,thu', '2026-10-22', '2026-10-22', '2026-10-26'], // 木曜 → 翌週月曜
  ['every:3d', '2026-10-20', '2026-10-20', '2026-10-23'],
  ['every:3d', '2026-10-10', '2026-10-20', '2026-10-22'], // 10,13,16,19,22
  ['monthly', '2026-01-31', '2026-01-31', '2026-02-28'], // 月末に丸める
  ['monthly', '2026-02-28', '2026-02-28', '2026-03-28'], // 以後は 28 日（ずれは許容）
  ['monthly', '2026-12-15', '2026-12-15', '2027-01-15'], // 年をまたぐ
  ['monthly', '2028-01-31', '2028-01-31', '2028-02-29'], // うるう年
  ['daily', null, '2026-12-31', '2027-01-01'],
]
for (const [rule, due, today, want] of cases) {
  const got = nextDue(parseRepeat(rule)!, due, today)
  check(`nextDue: ${rule} 期限 ${due ?? 'なし'} 完了 ${today} → ${want}`, got === want, `got ${got}`)
}

// 3) 起票: repeat を frontmatter に書く（due の直後）。繰り返さないタスクも空の repeat: を書く
const daily = await createTask(vault, {
  title: '日次レビュー',
  project: 'testproj',
  status: 'dotoday',
  due: dayOffset(0),
  repeat: 'daily',
})
const note0 = fs.readFileSync(path.join(vault, daily.task.file), 'utf-8')
check('create: repeat を due の直後に書く', /\ndue: \d{4}-\d{2}-\d{2}\nrepeat: daily\n/.test(note0), note0.slice(0, 300))
check('create: TaskCard に repeat が載る', daily.task.repeat === 'daily')
const plain = await createTask(vault, { title: '普通のタスク', project: 'testproj' })
const notePlain = fs.readFileSync(path.join(vault, plain.task.file), 'utf-8')
check('create: 繰り返さないタスクは空の repeat:', /\nrepeat:\n/.test(notePlain) && plain.task.repeat === null)
let threw = false
try {
  await createTask(vault, { title: '不正', project: 'testproj', repeat: 'yearly' })
} catch {
  threw = true
}
check('create: 不正な書式はエラー', threw)

// 4) done → 期限を進めて backlog に戻す。コメント・サブタスク・作業記録
await updateTask(vault, daily.task.taskId, { subtasks: '- [x] 今日の振り返り\n- [ ] 明日の予定\n  - [X] 入れ子' })
const r = await updateTask(vault, daily.task.taskId, { status: 'done' })
check('done: recurred に旧期限と次回期限を返す', r?.recurred?.from === dayOffset(0) && r?.recurred?.to === dayOffset(1), JSON.stringify(r?.recurred))
check('done: ステータスは backlog に戻る', r?.task.status === 'backlog')
check('done: 期限は次回（明日）', r?.task.due === dayOffset(1))
check('done: completed は記録しない', r?.task.completed === null)
const last = r?.comments[r.comments.length - 1]
check(
  'done: コメントに履歴を 1 行（書き手 アプリ）',
  last?.author === 'アプリ' && last.body === `繰り返し: 完了（期限 ${dayOffset(0)}）→ 次回期限 ${dayOffset(1)}`,
  JSON.stringify(last),
)
check(
  'done: チェック済みのサブタスクを未完了に戻す（入れ子・大文字 X も）',
  r?.subtasks === '- [ ] 今日の振り返り\n- [ ] 明日の予定\n  - [ ] 入れ子',
  r?.subtasks,
)
check('done: repeat は残る', r?.task.repeat === 'daily')

// 5) 期限なし・溜めた期限
const weekly = await createTask(vault, { title: '週次', project: 'testproj', repeat: 'weekly' })
const rw = await updateTask(vault, weekly.task.taskId, { status: 'done' })
check('done: 期限なしは今日から 1 回進める', rw?.task.due === dayOffset(7), rw?.task.due ?? 'null')
check('done: 期限なしの履歴は「期限 なし」', rw?.comments.at(-1)?.body.includes('期限 なし') === true)
const late = await createTask(vault, { title: '溜めた日次', project: 'testproj', due: dayOffset(-3), repeat: 'daily' })
const rl = await updateTask(vault, late.task.taskId, { status: 'done' })
check('done: 溜めた日次は明日 1 回だけ', rl?.task.due === dayOffset(1), rl?.task.due ?? 'null')

// 6) 繰り返さない場合
const rp = await updateTask(vault, plain.task.taskId, { status: 'done' })
check('done: 繰り返しなしは普通に done', rp?.task.status === 'done' && rp.recurred === null && rp.task.completed != null)
const dropped = await createTask(vault, { title: 'やめる繰り返し', project: 'testproj', repeat: 'daily', due: dayOffset(0) })
const rd = await updateTask(vault, dropped.task.taskId, { status: 'dropped' })
check('dropped: 繰り返さない', rd?.task.status === 'dropped' && rd.task.due === dayOffset(0))
// 同じ保存で repeat を空にして done → 本当に完了する
const stop = await createTask(vault, { title: '最後の回', project: 'testproj', repeat: 'daily', due: dayOffset(0) })
const rs = await updateTask(vault, stop.task.taskId, { status: 'done', repeat: null })
check('done: repeat を同時に解除すれば done になる', rs?.task.status === 'done' && rs.task.repeat === null)

// 7) 既存ノート（repeat キーなし）に後から設定する・不正な値を弾く
const old = await createTask(vault, { title: '旧ノート', project: 'testproj' })
const oldFile = path.join(vault, old.task.file)
fs.writeFileSync(oldFile, fs.readFileSync(oldFile, 'utf-8').replace('repeat:\n', ''), 'utf-8')
const ro = await updateTask(vault, old.task.taskId, { repeat: 'weekly:fri,mon' })
check('update: キーの無い既存ノートにも書ける（正規形で）', ro?.task.repeat === 'weekly:mon,fri')
threw = false
try {
  await updateTask(vault, old.task.taskId, { repeat: 'every:0d' })
} catch {
  threw = true
}
check('update: 不正な書式はエラー', threw)
const ru = await updateTask(vault, old.task.taskId, { repeat: '' })
check('update: 空文字で解除', ru?.task.repeat === null)

// 8) 手書きの不正値は繰り返さず、警告に載せる
const hand = await createTask(vault, { title: '手書き', project: 'testproj', due: dayOffset(0) })
const handFile = path.join(vault, hand.task.file)
fs.writeFileSync(handFile, fs.readFileSync(handFile, 'utf-8').replace('repeat:\n', 'repeat: every other day\n'), 'utf-8')
const warnings = findInvalidRepeats(await scanTasks(vault))
check('warnings: 不正な手書き値を警告', warnings.some((w) => w.includes(`task-id ${hand.task.taskId}`)), warnings.join('\n'))
const rh = await updateTask(vault, hand.task.taskId, { status: 'done' })
check('done: 不正な手書き値なら繰り返さない', rh?.task.status === 'done' && rh.recurred === null)

// 9) CLI: create --repeat、done の出力、一覧の ↻
const c1 = runCli(['create', '--project', 'testproj', '--title', 'CLI 繰り返し', '--due', dayOffset(0), '--repeat', 'every:2d'])
const created = (await scanTasks(vault)).find((t) => t.title === 'CLI 繰り返し')
check('cli create: --repeat を書く', c1.code === 0 && created?.repeat === 'every:2d', c1.out.trim())
const c2 = runCli(['done', `testproj-${created!.taskId}`])
check(
  'cli done: 繰り返しを知らせる',
  c2.code === 0 && c2.out.includes(`次回期限 ${dayOffset(2)} で backlog に戻しました`),
  c2.out.trim(),
)
check('cli done: backlog に戻っている', (await getTask(vault, created!.taskId))?.task.status === 'backlog')
const c3 = runCli(['--list'])
check('cli list: 繰り返しタスクに ↻', c3.out.split('\n').some((l) => l.includes('CLI 繰り返し ↻')), c3.out)
const c4 = runCli(['create', '--project', 'testproj', '--title', '不正', '--repeat', 'yearly'])
check('cli create: 不正な書式はエラー', c4.code === 1 && c4.out.includes('繰り返しは'), c4.out.trim())

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
