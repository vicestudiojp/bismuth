// 全体設定（settings.ts）の実地検証。
// 本番のユーザー設定 ~/.config/bismuth/config.json には触れず、BISMUTH_CONFIG で一時ファイルに向ける。
// 実行: npx tsx scripts/verify-settings.ts
//
// 方針（2026-07-16 オーナー指示）:
// - 設定は ルートフォルダ / タスクフォルダ / ゴミ箱フォルダ / 設定フォルダ の4項目
// - マシン固有なのでローカル設定に保存（共有設定には置かない＝ルートと設定フォルダはブートストラップに必要）
// - タスク/ゴミ箱/設定フォルダはルートからの相対。保存すると以後のパス組み立て（createTask 等）に反映される
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-settings-'))
const localConfig = path.join(tmp, 'user-config.json')
process.env.BISMUTH_CONFIG = localConfig
delete process.env.BISMUTH_VAULT // 環境変数でルートが上書きされないようにする

const { DEFAULTS, resolveSettings, saveSettings, taskDir, trashDir, configPath, taskGlobPattern, taskIdGlobs } =
  await import('../src/settings.js')
const { createTask } = await import('../src/vault.js')
const { readNextTaskId } = await import('../src/projects.js')

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

// 1) ローカル設定が無ければ既定値
fs.rmSync(localConfig, { force: true })
const def = resolveSettings()
check(
  '既定: 未設定なら DEFAULTS（root=~/bismuth・_task・_task/.trash・.bismuth）',
  def.root === DEFAULTS.root &&
    def.taskFolder === '_task' &&
    def.trashFolder === '_task/.trash' &&
    def.configFolder === '.bismuth',
  JSON.stringify(def),
)

// 2) 保存すると resolveSettings に反映される
saveSettings({ root: '/tmp/root-a', taskFolder: 'ta', trashFolder: 'tra', configFolder: 'ca' })
const s = resolveSettings()
check(
  '保存: resolveSettings に反映される',
  s.root === path.resolve('/tmp/root-a') && s.taskFolder === 'ta' && s.trashFolder === 'tra' && s.configFolder === 'ca',
  JSON.stringify(s),
)

// 3) 保存はパス組み立て（layout）にも反映される
check('反映: taskDir', taskDir('/r', 'p') === path.join('/r', 'ta', 'p'))
check('反映: trashDir', trashDir('/r') === path.join('/r', 'tra'))
check('反映: configPath', configPath('/r') === path.join('/r', 'ca', 'config.json'))
check('反映: taskGlobPattern', taskGlobPattern() === 'ta/*/*.md')
check(
  '反映: taskIdGlobs（現行規則＋旧規則の両方を拾う）',
  JSON.stringify(taskIdGlobs(7)) ===
    JSON.stringify(['ta/*/*-task-7-*.md', 'tra/*-task-7-*.md', 'ta/*/*-7 *.md', 'tra/*-7 *.md']),
  JSON.stringify(taskIdGlobs(7)),
)

// 4) 未知キー（人が手で足した設定）は温存する
fs.writeFileSync(localConfig, `${JSON.stringify({ foo: 'bar', root: '/r', taskFolder: 'x' }, null, 2)}\n`, 'utf-8')
saveSettings({ taskFolder: 'y' })
const raw = JSON.parse(fs.readFileSync(localConfig, 'utf-8')) as Record<string, unknown>
check('温存: 未知キー foo が残る', raw.foo === 'bar')
check('温存: taskFolder が更新される', raw.taskFolder === 'y')
check('温存: root は変えていない', raw.root === '/r')

// 5) ~ はホームに展開される
saveSettings({ root: '~/foo' })
check('展開: ~/foo → ホーム配下', resolveSettings().root === path.join(os.homedir(), 'foo'))

// 6) 旧 vaultPath を読み、保存時に root へ一本化する
fs.writeFileSync(localConfig, `${JSON.stringify({ vaultPath: '/legacy' }, null, 2)}\n`, 'utf-8')
check('後方互換: 旧 vaultPath をルートとして読む', resolveSettings().root === path.resolve('/legacy'))
saveSettings({ root: '/new' })
const raw2 = JSON.parse(fs.readFileSync(localConfig, 'utf-8')) as Record<string, unknown>
check('移行: root へ一本化し vaultPath を落とす', raw2.root === '/new' && raw2.vaultPath === undefined)

// 7) 統合: createTask が設定のフォルダ構成に従う
const vroot = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-vroot-'))
saveSettings({ root: vroot, taskFolder: 'mytasks', trashFolder: 'mytasks/.trash', configFolder: 'myconf' })
const t = await createTask(vroot, { title: '統合テスト', project: 'proj' })
check(
  '統合: タスクノートが設定のタスクフォルダに置かれる',
  fs.existsSync(path.join(vroot, 'mytasks', 'proj', `proj-task-${t.task.taskId}-統合テスト.md`)),
  `taskId=${t.task.taskId}`,
)
check('統合: 共有設定（採番）が設定の設定フォルダに置かれる', fs.existsSync(path.join(vroot, 'myconf', 'config.json')))
check('統合: 採番カウンターが進む（1件作成 → 次は 2）', readNextTaskId(vroot) === 2, `next=${readNextTaskId(vroot)}`)

// 8) 一覧カードの表示項目（cardFields）
fs.rmSync(localConfig, { force: true })
const cf0 = resolveSettings().cardFields
check(
  'cardFields: 既定は 優先度=on / 期限=on / タグ=off / 見積=off',
  cf0.priority === true && cf0.due === true && cf0.tags === false && cf0.estimate === false,
  JSON.stringify(cf0),
)
saveSettings({ cardFields: { priority: false, due: true, tags: true, estimate: true } })
const cf1 = resolveSettings().cardFields
check(
  'cardFields: 保存が反映される',
  cf1.priority === false && cf1.due === true && cf1.tags === true && cf1.estimate === true,
  JSON.stringify(cf1),
)
// 欠けたキー・不正な値（boolean 以外）は既定で埋める
fs.writeFileSync(localConfig, `${JSON.stringify({ cardFields: { tags: true, priority: 'yes' } }, null, 2)}\n`, 'utf-8')
const cf2 = resolveSettings().cardFields
check(
  'cardFields: 欠けたキー・不正値は既定で埋める',
  cf2.tags === true && cf2.priority === true && cf2.due === true && cf2.estimate === false,
  JSON.stringify(cf2),
)

// 9) カラムごとの並べ替え（columnSort・bismuth-44）
fs.rmSync(localConfig, { force: true })
const so0 = resolveSettings().columnSort
check(
  'columnSort: 既定は全カラム priority',
  Object.keys(so0).length === 5 && Object.values(so0).every((v) => v === 'priority'),
  JSON.stringify(so0),
)
saveSettings({ columnSort: { ...so0, ready: 'manual', done: 'completed-desc' } })
const so1 = resolveSettings().columnSort
check(
  'columnSort: 保存が反映される',
  so1.ready === 'manual' && so1.done === 'completed-desc' && so1.icebox === 'priority',
  JSON.stringify(so1),
)
fs.writeFileSync(localConfig, `${JSON.stringify({ columnSort: { backlog: 'ふぞろい', ready: 'due' } }, null, 2)}\n`, 'utf-8')
const so2 = resolveSettings().columnSort
check(
  'columnSort: 不正値・欠けたカラムは priority で埋める',
  so2.backlog === 'priority' && so2.ready === 'due' && so2.done === 'priority',
  JSON.stringify(so2),
)

// bismuth-122: タスク番号・更新日の並べ替えが有効値として保存・復元できる
saveSettings({ columnSort: { ...so0, backlog: 'id-asc', ready: 'id-desc', inprogress: 'updated-asc', done: 'updated-desc' } })
const so3 = resolveSettings().columnSort
check(
  'columnSort: タスク番号・更新日の昇順/降順を保存できる（bismuth-122）',
  so3.backlog === 'id-asc' && so3.ready === 'id-desc' && so3.inprogress === 'updated-asc' && so3.done === 'updated-desc' && so3.icebox === 'priority',
  JSON.stringify(so3),
)

// 10) 完了タスクの非表示日数（doneHideAfterDays・bismuth-45）
fs.rmSync(localConfig, { force: true })
const dh0 = resolveSettings().doneHideAfterDays
check('doneHideAfterDays: 既定は null（非表示にしない）', dh0 === null, JSON.stringify(dh0))
saveSettings({ doneHideAfterDays: 7 })
const dh1 = resolveSettings().doneHideAfterDays
check('doneHideAfterDays: 保存が反映される', dh1 === 7, JSON.stringify(dh1))
saveSettings({ doneHideAfterDays: null })
const dh2 = resolveSettings().doneHideAfterDays
check('doneHideAfterDays: null で無効化（空欄＝非表示にしない）', dh2 === null, JSON.stringify(dh2))
fs.writeFileSync(localConfig, `${JSON.stringify({ doneHideAfterDays: 'abc' }, null, 2)}\n`, 'utf-8')
const dh3 = resolveSettings().doneHideAfterDays
check('doneHideAfterDays: 不正値は null に正規化', dh3 === null, JSON.stringify(dh3))
saveSettings({ doneHideAfterDays: 0 })
const dh4 = resolveSettings().doneHideAfterDays
check('doneHideAfterDays: 0 以下は null（1 以上の整数のみ有効）', dh4 === null, JSON.stringify(dh4))

// 11) 画面テーマ（theme・bismuth-174）
fs.rmSync(localConfig, { force: true })
const th0 = resolveSettings().theme
check('theme: 既定は dark', th0 === 'dark', JSON.stringify(th0))
saveSettings({ theme: 'light' })
const th1 = resolveSettings().theme
check('theme: 保存が反映される（light）', th1 === 'light', JSON.stringify(th1))
saveSettings({ theme: 'system' })
const th2 = resolveSettings().theme
check('theme: system も保存できる', th2 === 'system', JSON.stringify(th2))
fs.writeFileSync(localConfig, `${JSON.stringify({ theme: 'sepia' }, null, 2)}\n`, 'utf-8')
const th3 = resolveSettings().theme
check('theme: 不正値は dark に正規化', th3 === 'dark', JSON.stringify(th3))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(vroot, { recursive: true, force: true })
  console.log('（一時ファイルは削除済み）')
} else {
  console.log(`FAIL あり。一時ファイルを残しています: ${tmp} / ${vroot}`)
  process.exit(1)
}
