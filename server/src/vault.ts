import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import matter from 'gray-matter'
import { claimTaskId, ensureProjects, readNextTaskId, setNextTaskId, validateProjectId } from './projects.js'
import { configPath, taskDir, taskGlobPattern, taskIdGlobs, trashDir } from './settings.js'

export interface TaskCard {
  taskId: number
  title: string
  project: string
  status: string
  priority: string | null // P1〜P4（P1 が最優先）。未設定（既存ノート・取込ノート）は null
  due: string | null
  tags: string[]
  estimate: number | null
  parent: number | null
  order: number | null
  created: string | null
  updated: string | null
  completed: string | null // status が done になった日。done 以外へ戻すと消える（「完了日」ソートのデータ源）
  todoistId: string | null // Todoist から取り込んだタスクの元 ID（重複取込の防止・掃除リスト）
  file: string
}

export interface TaskComment {
  at: string // 「2026-07-13 16:05」。アプリ起票時の自動コメントなど時刻なし（「2026-07-13」）もある
  author: string // オーナー／秘書／<プロジェクト>セッション／アプリ（F1 設計 2.2）
  body: string
}

export interface WorkSession {
  start: string // 「2026-07-13 15:20」
  end: string | null // 終了未記入（作業中・あとで追記）を許す
  memo: string
}

export interface TaskDetail {
  task: TaskCard
  body: string
  overview: string
  subtasks: string // 「## サブタスク」セクションの中身（Markdown のまま。bismuth-175）
  comments: TaskComment[]
  workSessions: WorkSession[]
  vaultName: string
}

// vault ルートの解決（resolveSettings().root）と全体設定の保存は settings.ts に移した

// スキャン対象はマシン間で共有すべき設定なので vault 内 <configFolder>/config.json から読む。
// taskGlobs が無ければタスクフォルダ設定から既定グロブ（<taskFolder>/*/*.md）を作る
function taskGlobs(vault: string): string[] {
  try {
    const raw = fs.readFileSync(configPath(vault), 'utf-8')
    const shared = JSON.parse(raw) as { taskGlobs?: string[] }
    if (Array.isArray(shared.taskGlobs) && shared.taskGlobs.length > 0) return shared.taskGlobs
  } catch {
    // 共有設定が無い vault ではデフォルトで動く
  }
  return [taskGlobPattern()]
}

function toDateString(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) {
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v)
}

function toNumberOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toPriority(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase()
  return (PRIORITIES as readonly string[]).includes(s) ? s : null
}

function toCard(vault: string, file: string, data: Record<string, unknown>): TaskCard {
  return {
    taskId: Number(data['task-id']),
    title: String(data.title ?? path.basename(file, '.md')),
    project: String(data.project ?? ''),
    status: String(data.status ?? 'backlog'),
    priority: toPriority(data.priority),
    due: toDateString(data.due),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    estimate: toNumberOrNull(data.estimate),
    parent: toNumberOrNull(data.parent),
    order: toNumberOrNull(data.order),
    created: toDateString(data.created),
    updated: toDateString(data.updated),
    completed: toDateString(data.completed),
    todoistId: data['todoist-id'] == null || data['todoist-id'] === '' ? null : String(data['todoist-id']),
    file: path.relative(vault, file),
  }
}

function isTaskNote(data: Record<string, unknown>): boolean {
  return data['task-id'] != null && data['task-id'] !== ''
}

export async function scanTasks(vault: string): Promise<TaskCard[]> {
  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  const tasks: TaskCard[] = []
  for (const file of files) {
    try {
      const { data } = matter(fs.readFileSync(file, 'utf-8'))
      if (!isTaskNote(data)) continue // タスクノート以外は無視
      tasks.push(toCard(vault, file, data))
    } catch {
      // 壊れたノートはスキップする（将来のストーリーで警告リストに載せる）
    }
  }
  return tasks
}

export interface NewTaskInput {
  title: string
  project: string
  status?: string
  priority?: string | null
  body?: string
  due?: string | null
  tags?: string[]
  estimate?: number | null
  parent?: number | null
  order?: number | null
  todoistId?: string | null // Todoist 取込元 ID（重複取込の防止。F1 設計 2.1）
  subtasks?: string[] // 「## サブタスク」に入れるチェックリスト（Todoist のサブタスク）
}

export const STATUSES = ['icebox', 'backlog', 'dotoday', 'inprogress', 'done', 'dropped'] as const

// 優先度。P1 が最優先で P4 が最低。既定は「優先度なし」（null）で、UI にも表示しない（Todoist 準拠）
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const

// 「優先度なし」＝ null。それ以外は P1〜P4 のみ
function normalizePriority(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toUpperCase()
  if (!s) return null
  if (!(PRIORITIES as readonly string[]).includes(s)) {
    throw new Error(`優先度は ${PRIORITIES.join(' / ')} または空（優先度なし）で指定してください`)
  }
  return s
}

// ファイル名に使えない文字＋Obsidian のリンク・タグ記法と衝突する文字を除く
function sanitizeFileName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// タスクノートのファイル名（拡張子なし）。2026-07-17 から `<project>-task-<id>-<title>`。
// 旧 `<project>-<id> <title>` のノートは一括リネームしない（taskIdGlobs が新旧どちらも拾う）。
// タイトル変更時のリネームはここを通るので、旧ノートもその時点で現行の規則に移る。
function taskFileBase(project: string, taskId: number, title: string): string {
  return `${project}-task-${taskId}-${sanitizeFileName(title)}`
}

function yamlValue(s: string): string {
  // コロン等 YAML の構文と衝突しうる場合だけクォートする（既存ノートの書式に合わせる）
  return /[:#"'`\[\]{}|>*&!?%@,]/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s
}

function todayString(): string {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

// 削除したノートの置き場は設定のゴミ箱フォルダ（trashDir・既定 _task/.trash）。ドット始まりなので
// スキャングロブにも Obsidian のファイルツリーにも出てこない。復元はタスクフォルダに戻すだけ。

// 採番は config.json の nextTaskId カウンターから払い出す（起票のたびに vault を走査しない）。
// カウンターは導出値なので、無い・壊れた・捨てられたときは vault から作り直す
async function maxTaskIdInVault(vault: string): Promise<number> {
  const live = await scanTasks(vault)
  let max = live.reduce((m, t) => Math.max(m, t.taskId), 0)
  // ゴミ箱の中も数える。数えないと削除後の起票で ID が再利用され、
  // ノートを復元したときに重複 ID になる
  const trashed = await fg('*.md', { cwd: trashDir(vault), absolute: true })
  for (const file of trashed) {
    try {
      const { data } = matter(fs.readFileSync(file, 'utf-8'))
      if (isTaskNote(data)) max = Math.max(max, Number(data['task-id']))
    } catch {
      // 壊れたノートは無視
    }
  }
  return max
}

export async function resyncTaskIdCounter(vault: string): Promise<number> {
  const next = (await maxTaskIdInVault(vault)) + 1
  setNextTaskId(vault, next)
  return next
}

// 起動時に呼ぶ。vault のタスクに出てくるプロジェクトのうち、未登録のものを登録する
// （アプリ導入前からあるノート・秘書やプロジェクトセッションが直接作ったノートを拾う）
export async function syncProjectsFromTasks(vault: string): Promise<string[]> {
  const tasks = await scanTasks(vault)
  const ids = [...new Set(tasks.map((t) => t.project).filter(Boolean))]
  return ensureProjects(vault, ids).map((p) => p.id)
}

// 起動時に一度だけ呼ぶ。カウンターが無ければ vault から作る（既にあれば走査しない）
export async function ensureTaskIdCounter(vault: string): Promise<{ next: number; rebuilt: boolean }> {
  const n = readNextTaskId(vault)
  if (n != null) return { next: n, rebuilt: false }
  return { next: await resyncTaskIdCounter(vault), rebuilt: true }
}

// その task-id のノートが既にあるか（ファイル名だけ見る。中身は読まない）。
// 他マシンで採番されたノートが Drive 同期で届いた場合や、手で起票された場合に効く安全網
async function taskIdFileExists(vault: string, taskId: number): Promise<boolean> {
  const hits = await fg(taskIdGlobs(taskId), { cwd: vault, dot: true })
  return hits.length > 0
}

async function nextTaskId(vault: string): Promise<number> {
  if (readNextTaskId(vault) == null) await resyncTaskIdCounter(vault) // 初回起動・カウンターを消した後
  const id = claimTaskId(vault)
  if (!(await taskIdFileExists(vault, id))) return id

  // 払い出した ID が既に使われていた＝カウンターが vault からずれている。
  // 走査し直して同期し、採り直す（ここでしか全走査しない）
  await resyncTaskIdCounter(vault)
  return claimTaskId(vault)
}

export async function createTask(vault: string, input: NewTaskInput): Promise<TaskDetail> {
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('タイトルは必須です')
  // プロジェクト id はファイル名と置き場に使う（半角英数・ハイフン・アンダースコア）。
  // 未登録なら登録する — vault のノートが正本なので、アプリ外で作られたプロジェクトも取りこぼさない
  const project = validateProjectId(input.project ?? '')
  ensureProjects(vault, [project])
  const status = input.status ?? 'backlog'
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status が不正です: ${status}`)
  const priority = normalizePriority(input.priority) // 既定は「優先度なし」
  if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) throw new Error('期限は YYYY-MM-DD 形式で指定してください')
  if (input.body) validateOverview(input.body)

  // 採番 = 最大 task-id + 1（F1 設計 2.1）。ゴミ箱の中も数える（後述 nextTaskId）
  const taskId = await nextTaskId(vault)

  const dir = taskDir(vault, project)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${taskFileBase(project, taskId, title)}.md`
  const filePath = path.join(dir, fileName)
  if (fs.existsSync(filePath)) throw new Error(`ファイルが既に存在します: ${fileName}`)

  const today = todayString()
  // タグは指定されたものだけを付ける。どの経路（web・CLI・Todoist 取込）でも
  // 既定タグ [project, 'task'] は付けない（2026-07-17 オーナー判断・bismuth-33）
  const tags = input.tags ?? []
  const note = [
    '---',
    `task-id: ${taskId}`,
    `title: ${yamlValue(title)}`,
    `project: ${project}`,
    `status: ${status}`,
    `priority:${priority ? ` ${priority}` : ''}`,
    `due:${input.due ? ` ${input.due}` : ''}`,
    `tags: [${tags.map((t) => yamlValue(t.trim())).join(', ')}]`,
    `estimate:${input.estimate != null ? ` ${input.estimate}` : ''}`,
    `parent:${input.parent != null ? ` ${input.parent}` : ''}`,
    `order:${input.order != null ? ` ${input.order}` : ''}`,
    `created: ${today}`,
    `updated: ${today}`,
    `completed:${status === 'done' ? ` ${today}` : ''}`,
    `todoist-id:${input.todoistId ? ` ${input.todoistId}` : ''}`,
    '---',
    '',
    `# ${taskId} ${title}`,
    '',
    '## 概要',
    '',
    input.body?.trim() || '（未記入）',
    '',
    '## サブタスク',
    '',
    ...(input.subtasks?.length ? [...input.subtasks.map((s) => `- [ ] ${s.replace(/\s*\n\s*/g, ' ').trim()}`), ''] : []),
    '## 作業記録',
    '',
    '| Start | End | Memo |',
    '|---|---|---|',
    '',
    '## コメント',
    '',
    '## 成果物・関連リンク',
    '',
  ].join('\n')

  fs.writeFileSync(filePath, note, 'utf-8')

  return {
    task: toCard(vault, filePath, {
      'task-id': taskId,
      title,
      project,
      status,
      priority,
      due: input.due ?? null,
      tags,
      estimate: input.estimate ?? null,
      parent: input.parent ?? null,
      order: input.order ?? null,
      created: today,
      updated: today,
      completed: status === 'done' ? today : null,
    }),
    body: note.slice(note.indexOf('---', 3) + 4),
    overview: input.body?.trim() || '（未記入）',
    subtasks: extractSubtasks(note),
    comments: extractComments(note),
    workSessions: extractWorkSessions(note),
    vaultName: path.basename(vault),
  }
}

export interface UpdateTaskInput {
  status?: string
  title?: string
  priority?: string | null
  due?: string | null
  tags?: string[]
  estimate?: number | null
  order?: number | null // 手動並べ替え（カラムのソート「手動」）の並び位置
  overview?: string
  subtasks?: string // 「## サブタスク」セクションの中身を丸ごと差し替える（空文字で空にする）
}

export interface UpdateResult extends TaskDetail {
  renamed: { from: string; to: string } | null
}

// アプリから編集できる本文領域（概要・サブタスク）には h1/h2 見出しを許可しない
// （ノートのセクション構造を壊させないため。### 以下は可）
export function validateOverview(text: string, label = '概要'): void {
  if (/^#{1,2}\s/m.test(text)) {
    throw new Error(`${label}に見出し（# / ##）は使えません（### 以下は可）`)
  }
}

function extractSection(content: string, heading: string): string {
  const m = content.match(new RegExp(`(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`))
  return m ? m[1].trim() : ''
}

export function extractOverview(content: string): string {
  return extractSection(content, '概要')
}

export function extractSubtasks(content: string): string {
  return extractSection(content, 'サブタスク')
}

// 「## <heading>」セクションの中身だけを差し替える。他のセクションは温存する。
// 中身が空なら見出しの直後に空行1つだけを残す（新規作成時のノートと同じ形）
function replaceSection(raw: string, heading: string, text: string): string | null {
  const body = text.trim()
  const section = body ? `\n## ${heading}\n\n${body}\n` : `\n## ${heading}\n`
  const mid = new RegExp(`\\n## ${heading}\\n[\\s\\S]*?(?=\\n## )`)
  if (mid.test(raw)) return raw.replace(mid, () => section)
  const tail = new RegExp(`\\n## ${heading}\\n[\\s\\S]*$`)
  if (tail.test(raw)) return raw.replace(tail, () => section)
  return null
}

// 「## 概要」セクションの中身だけを差し替える。他のセクションは温存する
function replaceOverview(raw: string, overview: string): string {
  const next = replaceSection(raw, '概要', overview)
  if (next == null) throw new Error('「## 概要」セクションが見つかりません')
  return next
}

// 「## サブタスク」セクションの中身だけを差し替える。セクションが無い旧ノートでは「## 概要」の直後に作る
function replaceSubtasks(raw: string, subtasks: string): string {
  const next = replaceSection(raw, 'サブタスク', subtasks)
  if (next != null) return next
  if (!subtasks.trim()) return raw
  const afterOverview = /(\n## 概要\n[\s\S]*?)(?=\n## |$)/
  if (!afterOverview.test(raw)) throw new Error('「## サブタスク」「## 概要」セクションが見つかりません')
  return raw.replace(afterOverview, (m) => `${m.replace(/\n*$/, '\n')}\n## サブタスク\n\n${subtasks.trim()}\n`)
}

// 「## コメント」セクションを 1 コメント = 「### <日時> — <書き手>」単位で読む（F1 設計 2.2）。
// 書き手を記録した手書きコメント（秘書・プロジェクトセッション）も同じ形式なのでそのまま読める
export function extractComments(content: string): TaskComment[] {
  const section = content.match(/(?:^|\n)## コメント\n([\s\S]*?)(?=\n## |$)/)
  if (!section) return []
  const comments: TaskComment[] = []
  const head = /^### +(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) +[—-] +(.+?) *$/gm
  const heads = [...section[1].matchAll(head)]
  heads.forEach((m, i) => {
    const start = m.index! + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1].index! : section[1].length
    comments.push({ at: m[1], author: m[2], body: section[1].slice(start, end).trim() })
  })
  return comments
}

// コメント本文はセクション構造（## 見出し）とコメント区切り（### 見出し）を壊してはならない
export function validateComment(text: string): void {
  if (!text.trim()) throw new Error('コメントが空です')
  if (/^#{1,3}\s/m.test(text)) {
    throw new Error('コメントに見出し（# / ## / ###）は使えません（#### 以下は可）')
  }
}

function nowStamp(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${todayString()} ${hh}:${mm}`
}

// 指定セクションの末尾にブロックを追記する。既存行は書き換えない（F1 設計 2.2「追記は常に該当セクションの末尾へ」）。
// セクションが無いノートには「## 成果物・関連リンク」の手前（無ければ末尾）に作る
function appendToSection(raw: string, heading: string, block: string): string {
  const re = new RegExp(`(?:^|\\n)## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`)
  const m = raw.match(re)
  if (m) {
    const section = m[0].replace(/\s*$/, '')
    return raw.slice(0, m.index!) + `${section}\n\n${block}\n` + raw.slice(m.index! + m[0].length)
  }
  const newSection = `\n## ${heading}\n\n${block}\n`
  const anchor = raw.indexOf('\n## 成果物・関連リンク')
  if (anchor >= 0) return raw.slice(0, anchor) + newSection + raw.slice(anchor)
  return `${raw.replace(/\s*$/, '')}\n${newSection}`
}

export interface NewCommentInput {
  body: string
  author?: string
}

// アプリからの投稿は「オーナー」名義（F1 設計 4.1）。秘書・プロジェクトセッションは
// ノートに直接追記してよく、その場合も同じ形式で書く（F1 設計 7章の共存規約）
export async function addComment(
  vault: string,
  taskId: number,
  input: NewCommentInput,
): Promise<TaskDetail | null> {
  const body = (input.body ?? '').trim()
  validateComment(body)
  const author = (input.author ?? 'オーナー').trim().replace(/\s+/g, ' ') || 'オーナー'

  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  for (const file of files) {
    let raw: string
    let data: Record<string, unknown>
    try {
      raw = fs.readFileSync(file, 'utf-8')
      ;({ data } = matter(raw))
    } catch {
      continue
    }
    if (!isTaskNote(data) || Number(data['task-id']) !== taskId) continue

    let next = appendToSection(raw, 'コメント', `### ${nowStamp()} — ${author}\n${body}`)
    next = setFrontmatterValue(next, 'updated', todayString())
    fs.writeFileSync(file, next, 'utf-8')

    const { data: newData, content } = matter(fs.readFileSync(file, 'utf-8'))
    return {
      task: toCard(vault, file, newData),
      body: content,
      overview: extractOverview(content),
      subtasks: extractSubtasks(content),
      comments: extractComments(content),
      workSessions: extractWorkSessions(content),
      vaultName: path.basename(vault),
    }
  }
  return null
}

// 「## 作業記録」セクションのテーブル（| Start | End | Memo |）を読む（F1 設計 2.2）。
// 実施時間は保存せず、この行の合算から導出する（設計 2.1）
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

export function extractWorkSessions(content: string): WorkSession[] {
  const section = content.match(/(?:^|\n)## 作業記録\n([\s\S]*?)(?=\n## |$)/)
  if (!section) return []
  const sessions: WorkSession[] = []
  for (const line of section[1].split('\n')) {
    if (!line.trim().startsWith('|')) continue
    // メモ内のパイプは `\|` とエスケープして書くので、区切りとして扱わない
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    if (cells.length < 2) continue
    const start = cells[0].trim()
    if (!STAMP.test(start)) continue // ヘッダー行・区切り行（---）はここで落ちる
    const end = cells[1].trim()
    sessions.push({
      start,
      end: STAMP.test(end) ? end : null,
      memo: (cells[2] ?? '').trim().replace(/\\\|/g, '|'),
    })
  }
  return sessions
}

export interface NewWorkSessionInput {
  start: string
  end?: string | null
  memo?: string
}

function validateWorkSession(input: NewWorkSessionInput): { start: string; end: string | null; memo: string } {
  const start = (input.start ?? '').trim()
  if (!STAMP.test(start)) throw new Error('開始時刻は「YYYY-MM-DD HH:MM」形式で入力してください')
  const rawEnd = (input.end ?? '').trim()
  if (rawEnd && !STAMP.test(rawEnd)) throw new Error('終了時刻は「YYYY-MM-DD HH:MM」形式で入力してください')
  const end = rawEnd || null
  if (end && end < start) throw new Error('終了時刻が開始時刻より前になっています')
  // メモの改行とパイプはテーブルを壊すので潰す（パイプはエスケープして温存する）
  const memo = (input.memo ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
  return { start, end, memo }
}

function workSessionRow(s: { start: string; end: string | null; memo: string }): string {
  return `| ${s.start} | ${s.end ?? ''} | ${s.memo} |`
}

// テーブルの最終行の直後に追記する（セクション末尾ではない。表を分断させないため）。
// 「## 作業記録」やヘッダー行が無いノートには表ごと新設する
function appendWorkSessionRow(raw: string, row: string): string {
  const re = /(?:^|\n)## 作業記録\n[\s\S]*?(?=\n## |$)/
  const m = raw.match(re)
  const header = '| Start | End | Memo |\n|---|---|---|'
  if (!m) {
    const newSection = `\n## 作業記録\n\n${header}\n${row}\n`
    const anchor = ['\n## コメント', '\n## 成果物・関連リンク']
      .map((h) => raw.indexOf(h))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0]
    if (anchor != null) return raw.slice(0, anchor) + newSection + raw.slice(anchor)
    return `${raw.replace(/\s*$/, '')}\n${newSection}`
  }

  const section = m[0]
  const lines = section.split('\n')
  let lastRow = -1
  lines.forEach((line, i) => {
    if (line.trim().startsWith('|')) lastRow = i
  })
  if (lastRow < 0) {
    // セクションはあるがテーブルが無い（手で消された等）
    const rebuilt = `${section.replace(/\s*$/, '')}\n\n${header}\n${row}\n`
    return raw.slice(0, m.index!) + rebuilt + raw.slice(m.index! + section.length)
  }
  lines.splice(lastRow + 1, 0, row)
  return raw.slice(0, m.index!) + lines.join('\n') + raw.slice(m.index! + section.length)
}

export async function addWorkSession(
  vault: string,
  taskId: number,
  input: NewWorkSessionInput,
): Promise<TaskDetail | null> {
  const session = validateWorkSession(input)

  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  for (const file of files) {
    let raw: string
    let data: Record<string, unknown>
    try {
      raw = fs.readFileSync(file, 'utf-8')
      ;({ data } = matter(raw))
    } catch {
      continue
    }
    if (!isTaskNote(data) || Number(data['task-id']) !== taskId) continue

    let next = appendWorkSessionRow(raw, workSessionRow(session))
    next = setFrontmatterValue(next, 'updated', todayString())
    fs.writeFileSync(file, next, 'utf-8')

    const { data: newData, content } = matter(fs.readFileSync(file, 'utf-8'))
    return {
      task: toCard(vault, file, newData),
      body: content,
      overview: extractOverview(content),
      subtasks: extractSubtasks(content),
      comments: extractComments(content),
      workSessions: extractWorkSessions(content),
      vaultName: path.basename(vault),
    }
  }
  return null
}

export interface DeleteResult {
  taskId: number
  title: string
  from: string
  to: string
}

// 削除＝ノートを _task/.trash/ へ移動する（中身は消さない）。
// スキャン対象から外れるのでカンバンから消える。frontmatter に deleted 日付だけ残す
export async function deleteTask(vault: string, taskId: number): Promise<DeleteResult | null> {
  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  for (const file of files) {
    let raw: string
    let data: Record<string, unknown>
    try {
      raw = fs.readFileSync(file, 'utf-8')
      ;({ data } = matter(raw))
    } catch {
      continue
    }
    if (!isTaskNote(data) || Number(data['task-id']) !== taskId) continue

    const dir = trashDir(vault)
    fs.mkdirSync(dir, { recursive: true })

    // 同名が既にゴミ箱にある場合（同じタスクを作り直して再削除した等）は上書きしない
    const base = path.basename(file, '.md')
    let dest = path.join(dir, `${base}.md`)
    for (let i = 2; fs.existsSync(dest); i++) {
      dest = path.join(dir, `${base} (${i}).md`)
    }

    fs.writeFileSync(file, setFrontmatterValue(raw, 'deleted', todayString()), 'utf-8')
    fs.renameSync(file, dest)

    return {
      taskId,
      title: String(data.title ?? base),
      from: path.relative(vault, file),
      to: path.relative(vault, dest),
    }
  }
  return null
}

// 重複 task-id の検出（手動起票などでの採番衝突を警告する）
export function findDuplicateIds(tasks: TaskCard[]): string[] {
  const seen = new Map<number, string>()
  const warnings: string[] = []
  for (const t of tasks) {
    const prev = seen.get(t.taskId)
    if (prev) warnings.push(`task-id ${t.taskId} が重複しています: 「${prev}」と「${t.file}」`)
    else seen.set(t.taskId, t.file)
  }
  return warnings
}

// frontmatter ブロック内の1キーだけを書き換える。他の行・書式・本文は温存する
// （gray-matter の stringify は frontmatter 全体を再整形してしまうため使わない）
function setFrontmatterValue(raw: string, key: string, value: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error('frontmatter が見つかりません')
  const fm = m[1]
  const line = value === '' ? `${key}:` : `${key}: ${value}`
  const lineRe = new RegExp(`^${key}:.*$`, 'm')
  const newFm = lineRe.test(fm) ? fm.replace(lineRe, line) : `${fm}\n${line}`
  return newFm === fm ? raw : raw.slice(0, m.index!) + `---\n${newFm}\n---` + raw.slice(m.index! + m[0].length)
}

export async function updateTask(
  vault: string,
  taskId: number,
  input: UpdateTaskInput,
): Promise<UpdateResult | null> {
  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  for (const file of files) {
    let raw: string
    let data: Record<string, unknown>
    try {
      raw = fs.readFileSync(file, 'utf-8')
      ;({ data } = matter(raw))
    } catch {
      continue
    }
    if (!isTaskNote(data) || Number(data['task-id']) !== taskId) continue

    let next = raw

    if (input.status != null) {
      if (!(STATUSES as readonly string[]).includes(input.status)) {
        throw new Error(`status が不正です: ${input.status}`)
      }
      next = setFrontmatterValue(next, 'status', input.status)
      // 完了日は done への遷移時に記録し、done から他ステータスへ戻したら消す。
      // web の status 変更も CLI の done もここを通るので、記録経路はこの1箇所だけ
      const wasDone = String(data.status ?? '') === 'done'
      if (input.status === 'done' && !wasDone) {
        next = setFrontmatterValue(next, 'completed', todayString())
      } else if (input.status !== 'done' && wasDone) {
        next = setFrontmatterValue(next, 'completed', '')
      }
    }
    if (input.priority !== undefined) {
      // 空文字・null で「優先度なし」に戻せる
      next = setFrontmatterValue(next, 'priority', normalizePriority(input.priority) ?? '')
    }
    if (input.due !== undefined) {
      if (input.due && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
        throw new Error('期限は YYYY-MM-DD 形式で指定してください')
      }
      next = setFrontmatterValue(next, 'due', input.due ?? '')
    }
    if (input.tags !== undefined) {
      const tags = input.tags.map((t) => yamlValue(t.trim())).filter(Boolean)
      next = setFrontmatterValue(next, 'tags', `[${tags.join(', ')}]`)
    }
    if (input.estimate !== undefined) {
      next = setFrontmatterValue(next, 'estimate', input.estimate == null ? '' : String(input.estimate))
    }
    if (input.order !== undefined) {
      if (input.order != null && !Number.isFinite(input.order)) throw new Error('order は数値で指定してください')
      next = setFrontmatterValue(next, 'order', input.order == null ? '' : String(input.order))
    }

    const newTitle = input.title?.trim()
    const titleChanged = newTitle != null && newTitle !== '' && newTitle !== String(data.title ?? '')
    if (titleChanged) {
      next = setFrontmatterValue(next, 'title', yamlValue(newTitle))
      // 先頭 H1 をタイトルに同期する
      next = next.replace(new RegExp(`^# ${taskId} .*$`, 'm'), `# ${taskId} ${newTitle}`)
    }

    if (input.overview !== undefined) {
      validateOverview(input.overview)
      next = replaceOverview(next, input.overview)
    }
    if (input.subtasks !== undefined) {
      validateOverview(input.subtasks, 'サブタスク')
      next = replaceSubtasks(next, input.subtasks)
    }

    next = setFrontmatterValue(next, 'updated', todayString())
    if (next !== raw) fs.writeFileSync(file, next, 'utf-8')

    // タイトル変更時はファイル名もリネームする。
    // 他ノートの [[リンク]] は書き換えない（vault 全体の自動置換はリスクが大きいため
    // 2026-07-10 オーナー判断で不採用。リンクが追従しないことは UI が警告する）
    let renamed: { from: string; to: string } | null = null
    let finalPath = file
    if (titleChanged) {
      const project = String(data.project ?? '')
      const oldBase = path.basename(file, '.md')
      const newBase = taskFileBase(project, taskId, newTitle)
      if (newBase !== oldBase) {
        const newPath = path.join(path.dirname(file), `${newBase}.md`)
        if (fs.existsSync(newPath)) throw new Error(`ファイルが既に存在します: ${newBase}.md`)
        fs.renameSync(file, newPath)
        finalPath = newPath
        renamed = { from: `${oldBase}.md`, to: `${newBase}.md` }
      }
    }

    const { data: newData, content } = matter(fs.readFileSync(finalPath, 'utf-8'))
    return {
      task: toCard(vault, finalPath, newData),
      body: content,
      overview: extractOverview(content),
      subtasks: extractSubtasks(content),
      comments: extractComments(content),
      workSessions: extractWorkSessions(content),
      vaultName: path.basename(vault),
      renamed,
    }
  }
  return null
}

export async function getTask(vault: string, taskId: number): Promise<TaskDetail | null> {
  const files = await fg(taskGlobs(vault), { cwd: vault, absolute: true })
  for (const file of files) {
    try {
      const { data, content } = matter(fs.readFileSync(file, 'utf-8'))
      if (!isTaskNote(data) || Number(data['task-id']) !== taskId) continue
      return {
        task: toCard(vault, file, data),
        body: content,
        overview: extractOverview(content),
        subtasks: extractSubtasks(content),
        comments: extractComments(content),
        workSessions: extractWorkSessions(content),
        vaultName: path.basename(vault),
      }
    } catch {
      // 壊れたノートはスキップ
    }
  }
  return null
}
