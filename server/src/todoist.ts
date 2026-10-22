// Todoist 取込（Read 専用）。F1 設計5章。
//
// 原則:
// - Todoist には一切書き込まない。消し込みは手で行う（取込済みかつ Todoist 側で未完のものは
//   「掃除リスト」として見せる）
// - 対象は projects の todoistProject が設定されているプロジェクトだけ（アーカイブ済みは除く・bismuth-226）
// - 重複防止は frontmatter の todoist-id。既に取り込んだタスクはスキップする
// - 誤操作を防ぐため、プレビュー（取込予定の一覧）と実行を分ける
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjects } from './projects.js'
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
  parentId: string | null
  due: string | null
  labels: string[]
  priority: number // Todoist API の 1〜4（4 が最優先＝画面の p1）
}

export interface ImportItem {
  todoistId: string
  project: string // Bismuth のプロジェクト id
  title: string
  description: string // → 「## 概要」
  due: string | null
  priority: string | null // P1〜P4（未設定は null）
  tags: string[]
  subtasks: string[]
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
  skipped: number // 既に取り込み済み（todoist-id 一致）
  cleanup: CleanupItem[] // 取込済みなのに Todoist 側で未完 → 手で消す候補
  projects: { project: string; todoistProject: string; found: boolean }[]
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
  const due = raw.due as { date?: string } | null | undefined
  return {
    id: String(raw.id ?? ''),
    content: String(raw.content ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    projectId: String(raw.project_id ?? ''),
    parentId: raw.parent_id == null ? null : String(raw.parent_id),
    due: due?.date ? String(due.date).slice(0, 10) : null,
    labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
    priority: Number(raw.priority ?? 1),
  }
}

// 取込対象を組み立てる（API を叩くだけで、ノートは書かない）
export async function previewSync(vault: string): Promise<SyncPreview> {
  const token = resolveToken()
  if (!token) {
    throw new Error(
      'Todoist のトークンがありません。~/.config/todoist/token に保存するか、環境変数 TODOIST_API_TOKEN を設定してください',
    )
  }

  // アーカイブ済みのプロジェクトには取り込まない（取り込んでもボードに出ないため）
  const mapped = listProjects(vault).filter((p) => p.todoistProject && !p.archived)
  if (mapped.length === 0) {
    throw new Error(
      'Todoist プロジェクト名が設定されたプロジェクトがありません（プロジェクト画面で設定してください。アーカイブ済みは対象外）',
    )
  }

  const todoistProjects = await paginate('/projects', token)
  const byName = new Map<string, string>() // Todoist プロジェクト名（小文字）→ id
  for (const p of todoistProjects) byName.set(String(p.name ?? '').trim().toLowerCase(), String(p.id ?? ''))

  const targets = mapped.map((p) => ({
    project: p.id,
    todoistProject: p.todoistProject,
    todoistProjectId: byName.get(p.todoistProject.trim().toLowerCase()) ?? null,
  }))

  // Todoist が返すのは未完了タスクのみ（完了タスクは取り込まない）
  const all = (await paginate('/tasks', token)).map(toTask)
  const byProjectId = new Map(targets.filter((t) => t.todoistProjectId).map((t) => [t.todoistProjectId!, t.project]))

  const known = await scanTasks(vault)
  const imported = new Map(known.filter((t) => t.todoistId).map((t) => [t.todoistId!, t]))

  const inScope = all.filter((t) => byProjectId.has(t.projectId))
  const parents = inScope.filter((t) => t.parentId == null)
  const children = inScope.filter((t) => t.parentId != null)

  const imports: ImportItem[] = []
  let skipped = 0
  for (const t of parents) {
    if (imported.has(t.id)) {
      skipped++
      continue
    }
    imports.push({
      todoistId: t.id,
      project: byProjectId.get(t.projectId)!,
      title: t.content,
      description: toOverview(t.description),
      due: t.due,
      priority: toPriority(t.priority),
      tags: t.labels,
      subtasks: children.filter((c) => c.parentId === t.id).map((c) => c.content),
    })
  }

  // 取込済みなのに Todoist 側でまだ未完 = 手で消す候補（アプリからは消さない）
  const openIds = new Set(all.map((t) => t.id))
  const cleanup: CleanupItem[] = [...imported.values()]
    .filter((t) => openIds.has(t.todoistId!))
    .map((t) => ({ todoistId: t.todoistId!, taskId: t.taskId, title: t.title, project: t.project }))

  return {
    imports,
    skipped,
    cleanup,
    projects: targets.map((t) => ({
      project: t.project,
      todoistProject: t.todoistProject,
      found: t.todoistProjectId != null,
    })),
  }
}

export interface SyncResult {
  imported: { taskId: number; title: string; project: string }[]
  skipped: number
  failed: { title: string; error: string }[]
  cleanup: CleanupItem[]
}

// プレビューのうち選択された分だけ取り込む（status は backlog 固定。Ready への配置は手動）。
// selectedIds を省略した場合はプレビュー全件（CLI 用）
export async function runSync(vault: string, selectedIds?: string[]): Promise<SyncResult> {
  const preview = await previewSync(vault)
  const targets = selectedIds ? preview.imports.filter((item) => selectedIds.includes(item.todoistId)) : preview.imports
  const imported: SyncResult['imported'] = []
  const failed: SyncResult['failed'] = []

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
        subtasks: item.subtasks,
      })
      imported.push({ taskId: detail.task.taskId, title: detail.task.title, project: detail.task.project })
    } catch (err) {
      failed.push({ title: item.title, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { imported, skipped: preview.skipped, failed, cleanup: preview.cleanup }
}
