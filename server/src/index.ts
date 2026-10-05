import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addProject, deleteProject, listProjects, updateProject, type ProjectInput } from './projects.js'
import { previewSync, runSync, todoistEnabled, TODOIST_DISABLED_MESSAGE } from './todoist.js'
import { applyLayout, DEFAULTS, resolveSettings, saveSettings, userConfigFile, type Settings } from './settings.js'
import {
  addComment,
  addWorkSession,
  createTask,
  deleteTask,
  ensureTaskIdCounter,
  findDuplicateIds,
  getTask,
  scanTasks,
  syncProjectsFromTasks,
  updateTask,
  type NewCommentInput,
  type NewTaskInput,
  type NewWorkSessionInput,
  type UpdateTaskInput,
} from './vault.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// ポートは Bi（ビスマス）の原子番号 83 から
const PORT = Number(process.env.BISMUTH_PORT ?? 8383)

// バージョンはパッケージの package.json から読む（開発時は server/src、配布時は dist/server から見て2つ上）
const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')).version)
  } catch {
    return 'dev'
  }
})()

// ビルド済みの画面（dist/web）。配布時は dist/server から ../web、開発時は server/src から ../../dist/web
const WEB_ROOT =
  [path.resolve(__dirname, '../web'), path.resolve(__dirname, '../../dist/web')].find((d) =>
    fs.existsSync(path.join(d, 'index.html')),
  ) ?? null

// 起動後に既定のブラウザで開く（npx での起動時。BISMUTH_OPEN=1 のときだけ）
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  execFile(cmd, args, () => {
    // 開けなくても URL はコンソールに出しているので無視する
  })
}

let vault: string
try {
  const settings = resolveSettings()
  applyLayout(settings)
  vault = settings.root
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

// リクエストログは開発時だけ出す（npm run dev:server が BISMUTH_LOG=1 を付ける）。利用者の端末には要点だけを出す
const app = Fastify({ logger: process.env.BISMUTH_LOG === '1' })

app.get('/api/health', async () => ({
  status: 'ok',
  app: 'bismuth',
  version: VERSION,
  features: { todoist: todoistEnabled() }, // web はこれを見て Todoist 関連の UI を出し分ける
}))

// 全体設定（ルート・タスク/ゴミ箱/システム設定フォルダ）。ユーザー設定なのでマシンごとのローカル設定に保存する
// （場所は環境変数 BISMUTH_CONFIG／既定 ~/.config/bismuth/config.json＝userConfigFile）。
// defaults はフォームのプレースホルダ用、userConfigFile は保存先の表示用に返す。
app.get('/api/settings', async () => ({
  settings: resolveSettings(),
  defaults: DEFAULTS,
  userConfigFile: userConfigFile(),
}))

app.put('/api/settings', async (req, reply) => {
  try {
    const settings = saveSettings(req.body as Partial<Settings>)
    vault = settings.root // ルート変更を以後のリクエストへ反映（フォルダ構成は saveSettings 内で applyLayout 済み）
    return { settings }
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// タスク数が少ないうちはリクエスト毎スキャン（常に最新・索引不要）。
// SQLite 索引は集計・規模が必要になるストーリーで導入する
app.get('/api/tasks', async () => {
  const tasks = await scanTasks(vault)
  return { tasks, warnings: findDuplicateIds(tasks) }
})

app.post('/api/tasks', async (req, reply) => {
  try {
    const detail = await createTask(vault, req.body as NewTaskInput)
    return reply.code(201).send(detail)
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.patch('/api/tasks/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' })
  try {
    const detail = await updateTask(vault, id, req.body as UpdateTaskInput)
    if (!detail) return reply.code(404).send({ error: 'task not found' })
    return detail
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/tasks/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' })
  const detail = await getTask(vault, id)
  if (!detail) return reply.code(404).send({ error: 'task not found' })
  return detail
})

// コメントは「## コメント」セクションへの追記のみ（編集・削除は Obsidian 側で）
app.post('/api/tasks/:id/comments', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' })
  try {
    const detail = await addComment(vault, id, req.body as NewCommentInput)
    if (!detail) return reply.code(404).send({ error: 'task not found' })
    return reply.code(201).send(detail)
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// プロジェクト（正本は <vault>/.bismuth/config.json の projects）
app.get('/api/projects', async () => ({ projects: listProjects(vault) }))

app.post('/api/projects', async (req, reply) => {
  try {
    return reply.code(201).send({ project: addProject(vault, req.body as ProjectInput) })
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// id は不変（ファイル名と置き場に使う）。概要と Todoist 名だけ更新できる
app.patch('/api/projects/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id
  try {
    const project = updateProject(vault, id, req.body as ProjectInput)
    if (!project) return reply.code(404).send({ error: 'project not found' })
    return { project }
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// 削除＝config から外し、<taskFolder>/<id>/ を丸ごとゴミ箱へ移動する（実体は消さない）。
// ゴミ箱に同名があれば Windows 風に連番退避
app.delete('/api/projects/:id', async (req, reply) => {
  const id = (req.params as { id: string }).id
  try {
    const result = deleteProject(vault, id)
    if (!result) return reply.code(404).send({ error: 'project not found' })
    return result
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Todoist 取込（Read 専用。Todoist には一切書き込まない）。
// プレビューで取込予定を見せてから実行する2段階
app.get('/api/sync/todoist/preview', async (_req, reply) => {
  if (!todoistEnabled()) return reply.code(404).send({ error: TODOIST_DISABLED_MESSAGE })
  try {
    return await previewSync(vault)
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/sync/todoist', async (req, reply) => {
  if (!todoistEnabled()) return reply.code(404).send({ error: TODOIST_DISABLED_MESSAGE })
  try {
    const body = req.body as { todoistIds?: string[] } | undefined
    return await runSync(vault, body?.todoistIds)
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// 削除はノートを _task/.trash/ へ移動する（実体は消さない。復元は Obsidian で戻すだけ）
app.delete('/api/tasks/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' })
  try {
    const deleted = await deleteTask(vault, id)
    if (!deleted) return reply.code(404).send({ error: 'task not found' })
    return { deleted }
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// 作業記録も追記のみ（訂正・削除は Obsidian 側で）。実施時間は保存せず行の合算から導出する
app.post('/api/tasks/:id/work-sessions', async (req, reply) => {
  const id = Number((req.params as { id: string }).id)
  if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' })
  try {
    const detail = await addWorkSession(vault, id, req.body as NewWorkSessionInput)
    if (!detail) return reply.code(404).send({ error: 'task not found' })
    return reply.code(201).send(detail)
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
  }
})

// web のビルド成果物を配信する（`npm run app` は先に web をビルドする。開発時は Vite が配信するので無くてもよい）
if (WEB_ROOT) app.register(fastifyStatic, { root: WEB_ROOT })

app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(async () => {
    const url = `http://localhost:${PORT}`
    console.log(`Bismuth ${VERSION}: ${url}`)
    if (!WEB_ROOT) console.log('（画面のビルドが見つかりません。開発時は npm run dev:web を使ってください）')
    console.log(`vault: ${vault}`)
    // 採番カウンター（config.json の nextTaskId）。無ければ vault から作り直す＝いつでも捨てられる導出値
    const counter = await ensureTaskIdCounter(vault)
    console.log(`counter: 次の task-id ${counter.next}${counter.rebuilt ? '（vault から再構築）' : ''}`)
    // vault のノートが正本。未登録のプロジェクトがあれば共有設定に取り込む
    const added = await syncProjectsFromTasks(vault)
    const projects = listProjects(vault)
    console.log(
      `projects: ${projects.map((p) => p.id).join(', ') || '（なし）'}${added.length ? `（新規登録: ${added.join(', ')}）` : ''}`,
    )
  })
  .then(() => {
    if (process.env.BISMUTH_OPEN === '1' && WEB_ROOT) openBrowser(`http://localhost:${PORT}`)
  })
  .catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `ポート ${PORT} は使用中です。Bismuth がすでに起動していないか確認するか、--port で別のポートを指定してください`,
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  })
