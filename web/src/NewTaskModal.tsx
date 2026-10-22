import { useState } from 'react'
import type { FormEvent } from 'react'
import RepeatInput from './RepeatInput'

const STATUSES = ['icebox', 'backlog', 'ready', 'inprogress', 'done', 'dropped']
const PRIORITIES = ['P1', 'P2', 'P3', 'P4']

type Props = {
  projects: string[]
  onCreated: (taskId: number) => void
  onClose: () => void
}

export default function NewTaskModal({ projects, onCreated, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(projects[0] ?? '')
  const [status, setStatus] = useState('backlog')
  const [priority, setPriority] = useState('') // 既定は優先度なし
  const [due, setDue] = useState('')
  const [repeat, setRepeat] = useState('') // 空＝繰り返さない
  const [tags, setTags] = useState('')
  const [estimate, setEstimate] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          project,
          status,
          priority: priority || null,
          body,
          due: due || null,
          repeat: repeat || null,
          // 空欄ならタグなし（既定タグは付けない）
          tags: tagList,
          estimate: estimate === '' ? null : Number(estimate),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onCreated(data.task.taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">新規タスク</h2>
        <form className="task-form" onSubmit={submit}>
          <label>
            タイトル *
            <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </label>
          <div className="form-row">
            <label>
              プロジェクト *
              <select value={project} onChange={(e) => setProject(e.target.value)} required>
                {projects.length === 0 && <option value="">（プロジェクトがありません）</option>}
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ステータス
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              優先度
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">優先度なし</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              期限
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label>
              見積（時間）
              <input type="number" min="0" step="0.5" value={estimate} onChange={(e) => setEstimate(e.target.value)} />
            </label>
          </div>
          <RepeatInput value={repeat} onChange={setRepeat} />
          <label>
            タグ（カンマ区切り・空ならタグなし）
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="waiting, 調査" />
          </label>
          <label>
            本文（概要・見出し # / ## は使用不可）
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          </label>
          {projects.length === 0 && (
            <p className="form-hint">
              先にヘッダーの「プロジェクト」からプロジェクトを追加してください。
            </p>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !project}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
