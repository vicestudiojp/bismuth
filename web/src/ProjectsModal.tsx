import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

export type Project = {
  id: string
  description: string
  todoistProject: string
  archived: boolean // アーカイブ済み＝ボード・新規タスクのプロジェクト欄から隠す（bismuth-226）
}

// プロジェクトの追加・編集。id は不変（ファイル名と置き場に使うため）で、概要と Todoist 名だけ後から直せる。
// アーカイブは一覧から隠すだけで、ノートは動かさない（解除すれば元どおり出る）。アーカイブ済みは表の末尾に並べる
// Todoist 取込が無効（サーバの BISMUTH_TODOIST 未設定）なら Todoist 名の欄は出さない（保存済みの値は温存される）
export default function ProjectsModal({
  todoist,
  onClose,
  onChanged,
}: {
  todoist: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  const [id, setId] = useState('')
  const [description, setDescription] = useState('')
  const [todoistProject, setTodoistProject] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [editDesc, setEditDesc] = useState('')
  const [editTodoist, setEditTodoist] = useState('')
  const [editError, setEditError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const [archiveError, setArchiveError] = useState<string | null>(null)

  function load() {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function addProject(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), description, todoistProject }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setId('')
      setDescription('')
      setTodoistProject('')
      load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  function startEdit(p: Project) {
    setEditing(p.id)
    setEditDesc(p.description)
    setEditTodoist(p.todoistProject)
    setEditError(null)
  }

  async function saveEdit(projectId: string) {
    setEditError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: editDesc, todoistProject: editTodoist }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setEditing(null)
      load()
      onChanged()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
    }
  }

  // アーカイブ／解除。戻せる操作なので確認は挟まない
  async function setArchived(projectId: string, archived: boolean) {
    setArchiveError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      load()
      onChanged()
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : String(err))
    }
  }

  // 削除＝タスクフォルダ（_task/<id>/）を丸ごとゴミ箱（_task/.trash/）へ移動する。実体は消さない
  async function doDelete(projectId: string) {
    setDeleteError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setDeleting(null)
      load()
      onChanged()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    }
  }

  // アーカイブ済みは末尾へ（それぞれの中はサーバが返す id 順のまま）
  const rows = [...projects.filter((p) => !p.archived), ...projects.filter((p) => p.archived)]

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">プロジェクト</h2>

        {loading && <p className="modal-loading">…</p>}
        {!loading && projects.length === 0 && <p className="section-empty">プロジェクトがありません</p>}
        {projects.length > 0 && (
          <table className="proj-table">
            <thead>
              <tr>
                <th>id</th>
                <th>概要</th>
                {todoist && <th>Todoist プロジェクト名</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) =>
                editing === p.id ? (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>
                      <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
                    </td>
                    {todoist && (
                      <td>
                        <input value={editTodoist} onChange={(e) => setEditTodoist(e.target.value)} />
                      </td>
                    )}
                    <td className="proj-actions">
                      <button className="btn btn-small" onClick={() => setEditing(null)}>
                        取消
                      </button>
                      <button className="btn btn-small btn-primary" onClick={() => saveEdit(p.id)}>
                        保存
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id} className={p.archived ? 'proj-archived' : undefined}>
                    <td className="mono">
                      {p.id}
                      {p.archived && <span className="proj-badge">アーカイブ済み</span>}
                    </td>
                    <td>{p.description || <span className="muted">—</span>}</td>
                    {todoist && <td>{p.todoistProject || <span className="muted">—</span>}</td>}
                    <td className="proj-actions">
                      {deleting === p.id ? (
                        <>
                          <span className="proj-confirm">.trash へ移動</span>
                          <button className="btn btn-small" onClick={() => setDeleting(null)}>
                            取消
                          </button>
                          <button className="btn btn-small btn-danger" onClick={() => doDelete(p.id)}>
                            削除する
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-small" onClick={() => startEdit(p)}>
                            編集
                          </button>
                          <button className="btn btn-small" onClick={() => setArchived(p.id, !p.archived)}>
                            {p.archived ? 'アーカイブ解除' : 'アーカイブ'}
                          </button>
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => {
                              setDeleting(p.id)
                              setDeleteError(null)
                            }}
                          >
                            削除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        {projects.length > 0 && (
          <p className="form-hint">
            アーカイブすると、そのプロジェクトのタスクをボードと新規タスクのプロジェクト欄から隠します。ノートはタスクフォルダ（
            <span className="mono">_task/&lt;id&gt;/</span>）に置いたままで、「番号でタスクを開く」からは開けます。解除すれば元どおり表示します。
          </p>
        )}
        {projects.length > 0 && (
          <p className="form-hint">
            削除すると、タスクフォルダ（<span className="mono">_task/&lt;id&gt;/</span>）を丸ごとゴミ箱（
            <span className="mono">_task/.trash/</span>）へ移動します。実体は消さず、同名が既にあれば「
            <span className="mono">&lt;id&gt; (2)</span>」のように連番で退避します。
          </p>
        )}
        {editError && <p className="form-error">{editError}</p>}
        {archiveError && <p className="form-error">{archiveError}</p>}
        {deleteError && <p className="form-error">{deleteError}</p>}

        <h3 className="section-head">プロジェクトを追加</h3>
        <form className="task-form" onSubmit={addProject}>
          <div className="form-row">
            <label>
              プロジェクト id *
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                required
                pattern="[A-Za-z0-9_][A-Za-z0-9_\-]*"
                title="半角英数・ハイフン・アンダースコアのみ（先頭は英数かアンダースコア）"
              />
            </label>
            {todoist && (
              <label>
                Todoist プロジェクト名
                <input value={todoistProject} onChange={(e) => setTodoistProject(e.target.value)} />
              </label>
            )}
          </div>
          <label>
            概要
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <p className="form-hint">
            id はタスクのファイル名（<span className="mono">&lt;id&gt;-task-&lt;task-id&gt;-&lt;タイトル&gt;.md</span>）と置き場（
            <span className="mono">_task/&lt;id&gt;/</span>）に使うため、あとから変更できません。
            {todoist ? '概要と Todoist プロジェクト名' : '概要'}は任意で、あとから編集できます。
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || !id.trim()}>
              {saving ? '追加中…' : '追加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
