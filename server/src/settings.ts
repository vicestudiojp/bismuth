// 全体設定（ルートフォルダ・タスク/ゴミ箱/設定フォルダ）。マシン固有なのでローカル設定ファイル
// （既定 ~/.config/bismuth/config.json）に持つ。共有設定（vault 内 <configFolder>/config.json）には
// 置かない — ルートと設定フォルダは共有設定を読む前に必要（ブートストラップ）なため、必ずローカル側に置く。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 一覧カードに表示する項目（タイトル下に 優先度 → 期限 → タグ → 見積 の順で並ぶ）
export interface CardFields {
  priority: boolean
  due: boolean
  tags: boolean
  estimate: boolean
}

// カラムごとの並べ替え（bismuth-44。タスク番号・更新日は bismuth-122 で追加）。「手動」は order フィールドの昇順
export const SORT_MODES = [
  'priority',
  'due',
  'project-asc',
  'project-desc',
  'manual',
  'completed-asc',
  'completed-desc',
  'id-asc',
  'id-desc',
  'updated-asc',
  'updated-desc',
] as const
export type SortMode = (typeof SORT_MODES)[number]

// ボードのカラム（dropped はボードに出さないので含めない）
export const BOARD_COLUMNS = ['icebox', 'backlog', 'ready', 'inprogress', 'done'] as const

export type ColumnSort = Record<string, SortMode>

// 画面テーマ（bismuth-174）。system は OS の設定（prefers-color-scheme）に合わせる
export const THEMES = ['dark', 'light', 'system'] as const
export type Theme = (typeof THEMES)[number]

export interface Settings {
  root: string // ルートフォルダ（vault のルート・絶対パス）
  taskFolder: string // タスクフォルダ（root からの相対）
  trashFolder: string // ゴミ箱フォルダ（root からの相対。削除タスクの移動先）
  configFolder: string // 設定フォルダ（root からの相対。共有 config.json の置き場）
  cardFields: CardFields // 一覧カードに表示する項目
  columnSort: ColumnSort // カラムごとの並べ替え（キー = カラムの status）
  doneHideAfterDays: number | null // 完了から N 日経過した done タスクをボードで非表示にする（null = 非表示にしない・bismuth-45）
  theme: Theme // 画面テーマ（bismuth-174）
}

export const DEFAULTS: Settings = {
  root: path.join(os.homedir(), 'bismuth'),
  taskFolder: '_task',
  trashFolder: '_task/.trash',
  configFolder: '.bismuth',
  cardFields: { priority: true, due: true, tags: false, estimate: false },
  columnSort: Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 'priority'])) as ColumnSort,
  doneHideAfterDays: null,
  theme: 'dark',
}

// ユーザー設定ファイル（マシンごと・同期しない）の場所。環境変数 BISMUTH_CONFIG で指定し、
// 未設定なら既定 ~/.config/bismuth/config.json。場所を中身に書くと自己参照になるので、必ず外（環境変数）から与える。
// 検証スクリプトも BISMUTH_CONFIG で一時ファイルに向ける（本番設定を汚さない）。呼び出し時に評価する。
function userConfigPath(): string {
  return process.env.BISMUTH_CONFIG ?? path.join(os.homedir(), '.config', 'bismuth', 'config.json')
}

// ユーザー設定ファイルの現在の絶対パス（設定ダイアログの表示用）
export function userConfigFile(): string {
  return userConfigPath()
}

// パス組み立てに使うフォルダ構成。既定値で初期化し、サーバ起動時に applyLayout で上書きする。
// 検証スクリプトは applyLayout を呼ばないので常に既定（_task / _task/.trash / .bismuth）で動く。
let layout = {
  taskFolder: DEFAULTS.taskFolder,
  trashFolder: DEFAULTS.trashFolder,
  configFolder: DEFAULTS.configFolder,
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function str(v: unknown, d: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : d
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : d
}

// カラムごとの並べ替えを正規化（欠けたカラム・不正な値は既定の「優先度」で埋める）
function normalizeColumnSort(v: unknown): ColumnSort {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return Object.fromEntries(
    BOARD_COLUMNS.map((c) => [c, (SORT_MODES as readonly string[]).includes(String(o[c])) ? (o[c] as SortMode) : 'priority']),
  ) as ColumnSort
}

// 一覧カードの表示項目を正規化（欠けたキー・不正な値は既定で埋める）
function normalizeCardFields(v: unknown): CardFields {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    priority: bool(o.priority, DEFAULTS.cardFields.priority),
    due: bool(o.due, DEFAULTS.cardFields.due),
    tags: bool(o.tags, DEFAULTS.cardFields.tags),
    estimate: bool(o.estimate, DEFAULTS.cardFields.estimate),
  }
}

// 完了タスクの非表示日数を正規化（1 以上の整数のみ有効。それ以外・未設定は null = 非表示にしない）
function normalizeDoneHideAfterDays(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 ? n : null
}

// 画面テーマを正規化（不正な値・未設定は既定のダーク）
function normalizeTheme(v: unknown): Theme {
  return (THEMES as readonly string[]).includes(String(v)) ? (v as Theme) : DEFAULTS.theme
}

// ローカル設定ファイルの生の中身（未知キーは温存する）
function readLocal(): Record<string, unknown> {
  try {
    const conf = JSON.parse(fs.readFileSync(userConfigPath(), 'utf-8')) as Record<string, unknown>
    return conf && typeof conf === 'object' ? conf : {}
  } catch {
    return {}
  }
}

// vault の場所が明示されているか（環境変数 BISMUTH_VAULT か、ローカル設定の root）。
// 起動コマンドが初回起動を見分け、既定の ~/bismuth を黙って作らずに場所を尋ねるために使う
export function hasConfiguredRoot(): boolean {
  if (process.env.BISMUTH_VAULT?.trim()) return true
  const conf = readLocal()
  return [conf.root, conf.vaultPath].some((v) => typeof v === 'string' && v.trim() !== '')
}

// ローカル設定から全体設定を解決する。root は 環境変数 BISMUTH_VAULT → root/vaultPath → 既定 の順。
export function resolveSettings(): Settings {
  const conf = readLocal()
  const rootRaw = process.env.BISMUTH_VAULT ?? (conf.root as string) ?? (conf.vaultPath as string)
  return {
    root: path.resolve(expandHome(str(rootRaw, DEFAULTS.root))),
    taskFolder: str(conf.taskFolder, DEFAULTS.taskFolder),
    trashFolder: str(conf.trashFolder, DEFAULTS.trashFolder),
    configFolder: str(conf.configFolder, DEFAULTS.configFolder),
    cardFields: normalizeCardFields(conf.cardFields),
    columnSort: normalizeColumnSort(conf.columnSort),
    doneHideAfterDays: normalizeDoneHideAfterDays(conf.doneHideAfterDays),
    theme: normalizeTheme(conf.theme),
  }
}

// 起動時・設定変更時に、以後のパス組み立てへ設定を反映する
export function applyLayout(s: Settings): void {
  layout = { taskFolder: s.taskFolder, trashFolder: s.trashFolder, configFolder: s.configFolder }
}

// 全体設定を保存する（ローカル設定ファイル・未知キーは温存）。保存後の設定を返し、layout にも反映する。
export function saveSettings(input: Partial<Settings>): Settings {
  const conf = readLocal()
  if (input.root !== undefined) {
    conf.root = input.root.trim()
    delete conf.vaultPath // 旧キーは root に一本化
  }
  if (input.taskFolder !== undefined) conf.taskFolder = input.taskFolder.trim()
  if (input.trashFolder !== undefined) conf.trashFolder = input.trashFolder.trim()
  if (input.configFolder !== undefined) conf.configFolder = input.configFolder.trim()
  if (input.cardFields !== undefined) conf.cardFields = normalizeCardFields(input.cardFields)
  if (input.columnSort !== undefined) conf.columnSort = normalizeColumnSort(input.columnSort)
  if (input.doneHideAfterDays !== undefined) conf.doneHideAfterDays = normalizeDoneHideAfterDays(input.doneHideAfterDays)
  if (input.theme !== undefined) conf.theme = normalizeTheme(input.theme)
  const file = userConfigPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(conf, null, 2)}\n`, 'utf-8')
  const resolved = resolveSettings()
  applyLayout(resolved)
  return resolved
}

// 派生パス。root は呼び出し側が渡す（検証スクリプトが一時 vault に差し替えられるように）。
export function taskDir(vault: string, project?: string): string {
  return project ? path.join(vault, layout.taskFolder, project) : path.join(vault, layout.taskFolder)
}

export function trashDir(vault: string): string {
  return path.join(vault, layout.trashFolder)
}

export function configPath(vault: string): string {
  return path.join(vault, layout.configFolder, 'config.json')
}

// スキャン用グロブ（cwd = vault からの相対）
export function taskGlobPattern(): string {
  return `${layout.taskFolder}/*/*.md`
}

// 指定 task-id のノートを探すグロブ（タスクフォルダ・ゴミ箱の両方）。
// 現行規則 `<project>-task-<id>-<title>.md` と、旧規則 `<project>-<id> <title>.md` の両方を拾う
// （旧ノートはリネームしない方針なので、両方を探し続ける必要がある）
export function taskIdGlobs(taskId: number): string[] {
  return [
    `${layout.taskFolder}/*/*-task-${taskId}-*.md`,
    `${layout.trashFolder}/*-task-${taskId}-*.md`,
    `${layout.taskFolder}/*/*-${taskId} *.md`,
    `${layout.trashFolder}/*-${taskId} *.md`,
  ]
}
