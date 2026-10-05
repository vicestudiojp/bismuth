import { useEffect, useState } from 'react'

type ImportItem = {
  todoistId: string
  project: string
  title: string
  due: string | null
  priority: string | null
  tags: string[]
  subtasks: string[]
}

type CleanupItem = { todoistId: string; taskId: number; title: string; project: string }

type Preview = {
  imports: ImportItem[]
  skipped: number
  cleanup: CleanupItem[]
  projects: { project: string; todoistProject: string; found: boolean }[]
}

type Result = {
  imported: { taskId: number; title: string; project: string }[]
  skipped: number
  failed: { title: string; error: string }[]
  cleanup: CleanupItem[]
}

// Todoist 取込は Read 専用。誤って大量のノートを作らないよう、プレビュー → 選択 → 実行の3段階にする
export default function SyncModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/sync/todoist/preview')
      .then(async (r) => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
        setPreview(data)
        setSelected(new Set((data as Preview).imports.map((i) => i.todoistId)))
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  function toggle(todoistId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(todoistId)) next.delete(todoistId)
      else next.add(todoistId)
      return next
    })
  }

  function toggleAll() {
    if (!preview) return
    setSelected((prev) => (prev.size === preview.imports.length ? new Set() : new Set(preview.imports.map((i) => i.todoistId))))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function run() {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/todoist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todoistIds: [...selected] }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setResult(data)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">Todoist 同期</h2>
        <p className="form-hint">
          Todoist は読むだけです（書き込み・消し込みは行いません）。プロジェクト設定で Todoist
          プロジェクト名を指定したプロジェクトが対象です。
        </p>

        {loading && <p className="modal-loading">…</p>}
        {error && <p className="form-error">{error}</p>}

        {preview && !result && (
          <>
            <h3 className="section-head">
              取り込むタスク（{preview.imports.length}）
              {preview.skipped > 0 && <span className="ws-total">取込済みでスキップ: {preview.skipped}</span>}
            </h3>
            {preview.projects.some((p) => !p.found) && (
              <p className="form-warning">
                ⚠ Todoist に見つからないプロジェクト名:{' '}
                {preview.projects
                  .filter((p) => !p.found)
                  .map((p) => `${p.project} → ${p.todoistProject}`)
                  .join(' / ')}
              </p>
            )}
            {preview.imports.length === 0 && <p className="section-empty">取り込む新しいタスクはありません</p>}
            {preview.imports.length > 0 && (
              <table className="proj-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={selected.size === preview.imports.length}
                        ref={(el) => {
                          if (el) el.indeterminate = selected.size > 0 && selected.size < preview.imports.length
                        }}
                        onChange={toggleAll}
                        aria-label="すべて選択"
                      />
                    </th>
                    <th>プロジェクト</th>
                    <th>タイトル</th>
                    <th>優先度</th>
                    <th>期限</th>
                    <th>サブ</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.imports.map((i) => (
                    <tr key={i.todoistId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(i.todoistId)}
                          onChange={() => toggle(i.todoistId)}
                          aria-label={`${i.title} を取り込む`}
                        />
                      </td>
                      <td className="mono">{i.project}</td>
                      <td>{i.title}</td>
                      <td>{i.priority ?? <span className="muted">—</span>}</td>
                      <td className="mono">{i.due ?? <span className="muted">—</span>}</td>
                      <td>{i.subtasks.length || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="form-actions">
              <span className="form-hint">取り込むと Backlog 列に入ります（DoToday への配置は手動）</span>
              <button className="btn btn-primary" onClick={run} disabled={running || selected.size === 0}>
                {running ? '取込中…' : `選択した ${selected.size} 件を取り込む`}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <h3 className="section-head">取り込みました（{result.imported.length}）</h3>
            {result.imported.length > 0 && (
              <ul className="sync-list">
                {result.imported.map((i) => (
                  <li key={i.taskId}>
                    <span className="mono">
                      {i.project}-{i.taskId}
                    </span>{' '}
                    {i.title}
                  </li>
                ))}
              </ul>
            )}
            {result.failed.length > 0 && (
              <>
                <h3 className="section-head">失敗（{result.failed.length}）</h3>
                <ul className="sync-list">
                  {result.failed.map((f) => (
                    <li key={f.title}>
                      {f.title} — <span className="form-error">{f.error}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {(result?.cleanup.length ?? preview?.cleanup.length ?? 0) > 0 && (
          <>
            <h3 className="section-head">
              掃除リスト（{result?.cleanup.length ?? preview?.cleanup.length}）
              <span className="ws-total">Bismuth に取り込み済み・Todoist 側でまだ未完</span>
            </h3>
            <p className="form-hint">アプリからは消しません。Todoist 側で手で完了・削除してください。</p>
            <ul className="sync-list">
              {(result?.cleanup ?? preview?.cleanup ?? []).map((c) => (
                <li key={c.todoistId}>
                  <span className="mono">
                    {c.project}-{c.taskId}
                  </span>{' '}
                  {c.title}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
