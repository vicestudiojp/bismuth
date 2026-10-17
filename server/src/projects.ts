// プロジェクト定義。正本は vault 内の共有設定 <vault>/.bismuth/config.json（F1 設計 4.3）。
// ドットフォルダなので Obsidian のツリーには出ず、Drive 同期で全マシンに行き渡る。
//
// プロジェクト id はファイル名（<project>-<task-id> <title>.md）と置き場（_task/<project>/）に
// 使う不変キー。半角英数・ハイフン・アンダースコアのみ（先頭は英数かアンダースコア）。
import fs from 'node:fs'
import path from 'node:path'
import { configPath, taskDir, trashDir } from './settings.js'

export interface Project {
  id: string
  description: string
  todoistProject: string // Todoist 側のプロジェクト名（取込の対応表。F1 設計5章）
}

export interface ProjectInput {
  id?: string
  description?: string | null
  todoistProject?: string | null
}

const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/

// configPath（共有設定 <root>/<configFolder>/config.json の場所）は settings.ts が持つ（設定フォルダは可変）

// 未知のキー（taskGlobs など、人が手で足した設定）は温存する
function readConfig(vault: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configPath(vault), 'utf-8')
    const conf = JSON.parse(raw) as Record<string, unknown>
    return conf && typeof conf === 'object' ? conf : {}
  } catch {
    return {}
  }
}

function writeConfig(vault: string, conf: Record<string, unknown>): void {
  const file = configPath(vault)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(conf, null, 2)}\n`, 'utf-8')
}

// 採番カウンター（次に払い出す task-id）。索引 DB ではなく共有設定 config.json の
// トップレベル nextTaskId に持つ。導出値なので、無い・壊れたときは vault の最大 task-id + 1 で
// 作り直せる（vault.ts の resyncTaskIdCounter）。書き込みは未知キー（projects 等）を温存する。
const NEXT_TASK_ID = 'nextTaskId'

export function readNextTaskId(vault: string): number | null {
  const n = Number(readConfig(vault)[NEXT_TASK_ID])
  return Number.isInteger(n) && n > 0 ? n : null
}

export function setNextTaskId(vault: string, n: number): void {
  const conf = readConfig(vault)
  conf[NEXT_TASK_ID] = n
  writeConfig(vault, conf)
}

// カウンターを1つ消費して返す（採番）。削除しても払い出した ID は戻さない＝再利用しない
export function claimTaskId(vault: string): number {
  const conf = readConfig(vault)
  const id = Number(conf[NEXT_TASK_ID])
  if (!Number.isInteger(id) || id <= 0) throw new Error('採番カウンターが未初期化です')
  conf[NEXT_TASK_ID] = id + 1
  writeConfig(vault, conf)
  return id
}

function toProject(v: unknown): Project | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const id = String(o.id ?? '').trim()
  if (!ID_RE.test(id)) return null
  return {
    id,
    description: String(o.description ?? '').trim(),
    todoistProject: String(o.todoistProject ?? '').trim(),
  }
}

export function listProjects(vault: string): Project[] {
  const conf = readConfig(vault)
  const raw = Array.isArray(conf.projects) ? conf.projects : []
  const projects = raw.map(toProject).filter((p): p is Project => p !== null)

  // 旧形式（todoistProjectMap: { <project>: <todoist名> }）を読み込む。書き戻しはしない
  const legacy = conf.todoistProjectMap
  if (legacy && typeof legacy === 'object') {
    for (const [id, todoist] of Object.entries(legacy as Record<string, unknown>)) {
      if (!ID_RE.test(id) || projects.some((p) => p.id.toLowerCase() === id.toLowerCase())) continue
      projects.push({ id, description: '', todoistProject: String(todoist ?? '').trim() })
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id))
}

function saveProjects(vault: string, projects: Project[]): void {
  const conf = readConfig(vault)
  conf.projects = projects.sort((a, b) => a.id.localeCompare(b.id))
  delete conf.todoistProjectMap // projects に統合したので落とす（読み込み時に取り込み済み）
  writeConfig(vault, conf)
}

export function validateProjectId(id: string): string {
  const v = (id ?? '').trim()
  if (!v) throw new Error('プロジェクト id は必須です')
  if (!ID_RE.test(v)) {
    throw new Error('プロジェクト id は半角英数・ハイフン・アンダースコアのみ使えます（先頭は英数かアンダースコア）')
  }
  return v
}

export function addProject(vault: string, input: ProjectInput): Project {
  const id = validateProjectId(input.id ?? '')
  const projects = listProjects(vault)
  // 大文字小文字だけ違う id はファイル名の衝突を招くので弾く
  if (projects.some((p) => p.id.toLowerCase() === id.toLowerCase())) {
    throw new Error(`プロジェクト「${id}」は既に存在します`)
  }
  const project: Project = {
    id,
    description: (input.description ?? '').trim(),
    todoistProject: (input.todoistProject ?? '').trim(),
  }
  saveProjects(vault, [...projects, project])
  return project
}

// id は不変（ファイル名と置き場に使うため）。概要と Todoist 名だけ更新できる
export function updateProject(vault: string, id: string, input: ProjectInput): Project | null {
  const projects = listProjects(vault)
  const target = projects.find((p) => p.id === id)
  if (!target) return null
  if (input.description !== undefined) target.description = (input.description ?? '').trim()
  if (input.todoistProject !== undefined) target.todoistProject = (input.todoistProject ?? '').trim()
  saveProjects(vault, projects)
  return target
}

export interface DeleteProjectResult {
  id: string
  from: string // 元の <taskFolder>/<id>/（フォルダが無ければ ''）
  to: string // 移動先 <trashFolder>/<id>/（移動しなければ ''）
}

// プロジェクトを削除する。config の projects から外し、<taskFolder>/<id>/ を丸ごとゴミ箱へ移動する。
// ゴミ箱に同名フォルダが既にあれば Windows 風に「<id> (2)」「<id> (3)」…と連番で退避（上書きしない）。
// フォルダの移動を先に行い、失敗したら config には手を付けない。
export function deleteProject(vault: string, id: string): DeleteProjectResult | null {
  const projects = listProjects(vault)
  const registered = projects.some((p) => p.id === id)
  const dir = taskDir(vault, id)
  const hasFolder = fs.existsSync(dir)
  // config にも無く、フォルダも無ければ対象なし
  if (!registered && !hasFolder) return null

  // 先に <taskFolder>/<id>/ を丸ごと <trashFolder>/ へ移動（IO が失敗したら config を触らない）
  let to = ''
  if (hasFolder) {
    const trash = trashDir(vault)
    fs.mkdirSync(trash, { recursive: true })
    let dest = path.join(trash, id)
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trash, `${id} (${i})`)
    fs.renameSync(dir, dest)
    to = dest
  }

  // config の projects から除外
  if (registered) saveProjects(vault, projects.filter((p) => p.id !== id))
  return { id, from: hasFolder ? dir : '', to }
}

// 未登録のプロジェクトを登録する（既にあれば何もしない）。
// vault のノートが正本なので、アプリを通さず作られたタスクのプロジェクトも取りこぼさない
export function ensureProjects(vault: string, ids: string[]): Project[] {
  const projects = listProjects(vault)
  const known = new Set(projects.map((p) => p.id.toLowerCase()))
  const added: Project[] = []
  for (const raw of ids) {
    const id = (raw ?? '').trim()
    if (!ID_RE.test(id) || known.has(id.toLowerCase())) continue
    known.add(id.toLowerCase())
    added.push({ id, description: '', todoistProject: '' })
  }
  if (added.length > 0) saveProjects(vault, [...projects, ...added])
  return added
}
