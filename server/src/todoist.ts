// Todoist 取込。F1 設計5章。
//
// 原則:
// - 既定では Todoist に書き込まない。取込済みで Todoist 側が未完のものは「掃除リスト」として見せ、手で消す。
//   設定（todoistAfterSync）で「完了にする」「削除する」を選ぶと、取り込んだタスクと掃除リストのタスクを
//   実行時に Todoist 側で処理する（bismuth-206）
// - 対象は projects の todoistProject か todoistTag が設定されているプロジェクトだけ（アーカイブ済みは除く・bismuth-226）
// - Todoist のタスク1件につき、マッチしたプロジェクトごとに別の Bismuth タスクにする（bismuth-206）。
//   タグで B、プロジェクト名で C にマッチすれば B と C に1件ずつ。同じプロジェクトに両方でマッチしても1件
// - Todoist のサブタスクは Bismuth のサブタスクにしない（bismuth-206）。取込の判定では親子関係を見ず、
//   サブタスクも普通のタスクと同じく、それ自身のプロジェクト・タグで判定する
// - 重複防止は frontmatter の todoist-id と project の組。既に取り込んだタスクはスキップする
// - 誤操作を防ぐため、プレビュー（取込予定の一覧）と実行を分ける
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './projects.js'
import type { TodoistAfterSync } from './settings.js'
import { createTask, scanTasks } from './vault.js'

const BASE = 'https://api.todoist.com/api/v1'

// Todoist 取込は既定でオフ。環境変数 BISMUTH_TODOIST=1 のときだけ API・CLI・web の入口を開ける（bismuth-175。
// 公開版の利用者には見せず、オーナーは自分の環境でだけ有効にして使い続ける）
export function todoistEnabled(): boolean {
  return process.env.BISMUTH_TODOIST === '1'
}

export const TODOIST_DISABLED_MESSAGE = 'Todoist 取込は無効です（環境変数 BISMUTH_TODOIST=1 で有効になります）'

export interface TodoistTask {
  id: string
  content: string
  description: string
  projectId: string
  parentId: string | null // 同期後の処理でだけ使う（親を完了・削除するとサブタスクも一緒に処理されるため）
  recurring: boolean // 繰り返しタスク。同期後の処理でだけ使う（完了にしても未完のまま次回へ繰り越されるため）
  due: string | null
  labels: string[]
  priority: number // Todoist API の 1〜4（4 が最優先＝画面の p1）
}

export interface ImportItem {
  key: string // 行の識別子。1つの Todoist タスクが複数のプロジェクトに入るので todoistId だけでは足りない
  todoistId: string
  project: string // Bismuth のプロジェクト id
  title: string
  description: string // → 「## 概要」
  due: string | null
  priority: string | null // P1〜P4（未設定は null）
  tags: string[]
}

// 概要に h1/h2 は置けない（ノートのセクション構造を壊すため）。
// Todoist の description に見出しがあればレベルを下げて取り込む
function toOverview(description: string): string {
  return description.replace(/^(#{1,2})\s/gm, '#### ')
}

export interface CleanupItem {
  todoistId: string
  taskId: number
  title: string
  project: string
}

export interface SyncPreview {
  imports: ImportItem[]
  skipped: number // 既に取り込み済み（todoist-id と project が一致）
  cleanup: CleanupItem[] // 取込済みなのに Todoist 側で未完 → 手で消す候補
  // found / tagFound は対応づけの誤りの報告用。未設定の項目は問題がないので true
  projects: { project: string; todoistProject: string; found: boolean; todoistTag: string; tagFound: boolean }[]
}

// トークンはマシン固有。vault にも共有設定にも置かない（task-sync スキルと同じ場所を使う）
export function resolveToken(): string | null {
  const env = process.env.TODOIST_API_TOKEN?.trim()
  if (env) return env
  const file = path.join(os.homedir(), '.config', 'todoist', 'token')
  try {
    const token = fs.readFileSync(file, 'utf-8').trim()
    return token || null
  } catch {
    return null
  }
}

async function apiGet(pathname: string, token: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `${BASE}${pathname}?${new URLSearchParams(params)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Todoist API エラー（${res.status}）: ${pathname}`)
  return (await res.json()) as Record<string, unknown>
}

async function apiWrite(method: 'POST' | 'DELETE', pathname: string, token: string): Promise<void> {
  const res = await fetch(`${BASE}${pathname}`, { method, headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Todoist API エラー（${res.status}）: ${method} ${pathname}`)
}

async function paginate(pathname: string, token: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let cursor: string | undefined
  for (let i = 0; i < 30; i++) {
    const params: Record<string, string> = { limit: '200' }
    if (cursor) params.cursor = cursor
    const data = await apiGet(pathname, token, params)
    const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : []
    out.push(...results)
    cursor = typeof data.next_cursor === 'string' ? data.next_cursor : undefined
    if (!cursor) break
  }
  return out
}

// Todoist の priority（1〜4・4 が最優先）→ Bismuth の P1〜P4。
// Todoist 既定の p4（API 値 1）は「優先度なし」に対応させる（画面に何も出さない）
function toPriority(p: number): string | null {
  return { 4: 'P1', 3: 'P2', 2: 'P3' }[p] ?? null
}

function toTask(raw: Record<string, unknown>): TodoistTask {
  const due = raw.due as { date?: string; is_recurring?: boolean } | null | undefined
  return {
    id: String(raw.id ?? ''),
    content: String(raw.content ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    projectId: String(raw.project_id ?? ''),
    parentId: raw.parent_id == null ? null : String(raw.parent_id),
    recurring: due?.is_recurring === true,
    due: due?.date ? String(due.date).slice(0, 10) : null,
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    priority: Number(raw.priority ?? 1),
  }
}

// Todoist のプロジェクト名・ラベル名の突き合わせは大文字小文字を区別しない
function normalize(name: string): string {
  return name.trim().toLowerCase()
}

function importKey(project: string, todoistId: string): string {
  return `${project}:${todoistId}`
}

// runSync が同期後の処理に使う材料も含めた読み込み結果
interface LoadedSync {
  token: string
  preview: SyncPreview
  openTasks: TodoistTask[] // Todoist の未完タスク全件
  knownIds: string[] // ノートのある Todoist タスクの id
}

// 取込対象を組み立てる（API を叩くだけで、ノートは書かない）
async function loadSync(vault: string): Promise<LoadedSync> {
  const token = resolveToken()
  if (!token) {
    throw new Error(
      'Todoist のトークンがありません。~/.config/todoist/token に保存するか、環境変数 TODOIST_API_TOKEN を設定してください',
    )
  }

  // アーカイブ済みのプロジェクトには取り込まない（取り込んでもボードに出ないため）
  const mapped = listProjects(vault).filter((p) => (p.todoistProject || p.todoistTag) && !p.archived)
  if (mapped.length === 0) {
    throw new Error(
      'Todoist プロジェクト名かタグが設定されたプロジェクトがありません（プロジェクト画面で設定してください。アーカイブ済みは対象外）',
    )
  }

  const todoistProjects = await paginate('/projects', token)
  const byName = new Map<string, string>() // Todoist プロジェクト名（小文字）→ id
  for (const p of todoistProjects) byName.set(normalize(String(p.name ?? '')), String(p.id ?? ''))

  const targets = mapped.map((p) => ({
    project: p.id,
    todoistProject: p.todoistProject,
    todoistProjectId: byName.get(normalize(p.todoistProject)) ?? null,
    todoistTag: p.todoistTag,
  }))

  // Todoist が返すのは未完了タスクのみ（完了タスクは取り込まない）
  const all = (await paginate('/tasks', token)).map(toTask)

  // /labels は個人ラベルだけを返すので、未完タスクに付いているラベル（共有ラベルを含む）も合わせて判定する
  const knownLabels = new Set(all.flatMap((t) => t.labels).map(normalize))
  for (const label of await paginate('/labels', token)) knownLabels.add(normalize(String(label.name ?? '')))

  const known = await scanTasks(vault)
  const imported = new Set(known.filter((t) => t.todoistId).map((t) => importKey(t.project, t.todoistId!)))

  const imports: ImportItem[] = []
  let skipped = 0
  for (const t of all) {
    const labels = t.labels.map(normalize)
    for (const target of targets) {
      if (t.projectId !== target.todoistProjectId && !labels.includes(normalize(target.todoistTag))) continue
      const key = importKey(target.project, t.id)
      if (imported.has(key)) {
        skipped++
        continue
      }
      imports.push({
        key,
        todoistId: t.id,
        project: target.project,
        title: t.content,
        description: toOverview(t.description),
        due: t.due,
        priority: toPriority(t.priority),
        tags: t.labels,
      })
    }
  }

  // 取込済みなのに Todoist 側でまだ未完 = 手で消す候補（アプリからは消さない）
  const openIds = new Set(all.map((t) => t.id))
  const cleanup: CleanupItem[] = known
    .filter((t) => t.todoistId && openIds.has(t.todoistId))
    .map((t) => ({ todoistId: t.todoistId!, taskId: t.taskId, title: t.title, project: t.project }))

  return {
    token,
    openTasks: all,
    knownIds: known.flatMap((t) => (t.todoistId ? [t.todoistId] : [])),
    preview: {
      imports,
      skipped,
      cleanup,
      projects: targets.map((t) => ({
        project: t.project,
        todoistProject: t.todoistProject,
        found: !t.todoistProject || t.todoistProjectId != null,
        todoistTag: t.todoistTag,
        tagFound: !t.todoistTag || knownLabels.has(normalize(t.todoistTag)),
      })),
    },
  }
}

export async function previewSync(vault: string): Promise<SyncPreview> {
  return (await loadSync(vault)).preview
}

export interface AfterSyncResult {
  action: TodoistAfterSync
  done: { todoistId: string; title: string }[] // Todoist 側で完了・削除した
  held: { todoistId: string; title: string; reason: string }[] // 取りこぼしを防ぐため処理しなかった
  failed: { todoistId: string; title: string; error: string }[]
}

export interface SyncResult {
  imported: { taskId: number; title: string; project: string }[]
  skipped: number
  failed: { project: string; title: string; error: string }[]
  cleanup: CleanupItem[]
  afterSync: AfterSyncResult
}

function descendantIds(tasks: TodoistTask[], id: string): string[] {
  return tasks.filter((t) => t.parentId === id).flatMap((t) => [t.id, ...descendantIds(tasks, t.id)])
}

function depthOf(byId: Map<string, TodoistTask>, task: TodoistTask): number {
  let depth = 0
  for (let p = task.parentId; p && byId.has(p); p = byId.get(p)!.parentId) depth++
  return depth
}

// ノートのある未完の Todoist タスク（今回取り込んだタスクと掃除リストのタスク）を、設定に応じて完了・削除する。
// 親を完了・削除するとサブタスクも一緒に処理されるので（Todoist の仕様）、Bismuth に取り込まれていない
// タスクを巻き込む場合は処理しない。取りこぼしを避けるためで、そのタスクは held として報告し、掃除リストに残す
async function applyAfterSync(
  action: TodoistAfterSync,
  loaded: LoadedSync,
  importedIds: Set<string>,
  remainingIds: Set<string>, // まだ取り込んでいない行が残っている（未選択・作成失敗）
): Promise<AfterSyncResult> {
  const result: AfterSyncResult = { action, done: [], held: [], failed: [] }
  if (action === 'none') return result

  const { openTasks, token } = loaded
  const inBismuth = new Set([...loaded.knownIds, ...importedIds])
  const targets: TodoistTask[] = []
  for (const t of openTasks.filter((task) => inBismuth.has(task.id))) {
    const lost = descendantIds(openTasks, t.id).some((id) => !inBismuth.has(id) || remainingIds.has(id))
    if (remainingIds.has(t.id)) {
      result.held.push({ todoistId: t.id, title: t.content, reason: 'まだ取り込んでいないプロジェクトがあります' })
    } else if (lost) {
      result.held.push({ todoistId: t.id, title: t.content, reason: '取り込んでいないサブタスクがあります' })
    } else if (action === 'complete' && t.recurring && !importedIds.has(t.id)) {
      // 完了にしても次回へ繰り越されて未完のまま残るので、掃除リストから完了にすると同期のたびに予定が飛ぶ
      result.held.push({ todoistId: t.id, title: t.content, reason: '繰り返しタスクは取り込んだ実行でだけ完了にします' })
    } else {
      targets.push(t)
    }
  }

  // 親を先に処理するとサブタスクへの操作が 404 になるので、深いものから処理する
  const byId = new Map(openTasks.map((t) => [t.id, t]))
  targets.sort((a, b) => depthOf(byId, b) - depthOf(byId, a))
  for (const t of targets) {
    const id = encodeURIComponent(t.id)
    try {
      if (action === 'complete') await apiWrite('POST', `/tasks/${id}/close`, token)
      else await apiWrite('DELETE', `/tasks/${id}`, token)
      result.done.push({ todoistId: t.id, title: t.content })
    } catch (err) {
      result.failed.push({ todoistId: t.id, title: t.content, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

// プレビューのうち選択された分だけ取り込む（status は backlog 固定。Ready への配置は手動）。
// selectedKeys（ImportItem.key）を省略した場合はプレビュー全件（CLI 用）。
// afterSync は呼び出し側が設定から渡す（既定は Todoist に書き込まない）
export async function runSync(vault: string, selectedKeys?: string[], afterSync: TodoistAfterSync = 'none'): Promise<SyncResult> {
  const loaded = await loadSync(vault)
  const { preview } = loaded
  const targets = selectedKeys ? preview.imports.filter((item) => selectedKeys.includes(item.key)) : preview.imports
  const imported: SyncResult['imported'] = []
  const failed: SyncResult['failed'] = []
  const importedKeys = new Set<string>()

  for (const item of targets) {
    try {
      const detail = await createTask(vault, {
        title: item.title,
        project: item.project,
        status: 'backlog',
        priority: item.priority,
        due: item.due,
        tags: item.tags, // Todoist のラベルだけを付ける（空なら空）
        body: item.description,
        todoistId: item.todoistId,
      })
      imported.push({ taskId: detail.task.taskId, title: detail.task.title, project: detail.task.project })
      importedKeys.add(item.key)
    } catch (err) {
      failed.push({ project: item.project, title: item.title, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const rowIds = (done: boolean) => new Set(preview.imports.filter((i) => importedKeys.has(i.key) === done).map((i) => i.todoistId))
  const after = await applyAfterSync(afterSync, loaded, rowIds(true), rowIds(false))

  // 今の処理でなくなったタスク（一緒に処理されたサブタスクを含む）は、もう掃除の対象ではない
  const gone = new Set(after.done.flatMap((d) => [d.todoistId, ...descendantIds(loaded.openTasks, d.todoistId)]))
  const cleanup = preview.cleanup.filter((c) => !gone.has(c.todoistId))

  return { imported, skipped: preview.skipped, failed, cleanup, afterSync: after }
}
