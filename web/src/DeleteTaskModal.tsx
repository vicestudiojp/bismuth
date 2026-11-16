import { useEffect, useState } from 'react'

// ボードのカードから削除するときの確認（bismuth-302）。タスク詳細の削除と同じく、ノートをゴミ箱へ移すだけ
export default function DeleteTaskModal({
  task,
  onClose,
  onDeleted,
}: {
  task: { taskId: number; project: string; title: string }
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, deleting])

  async function runDelete() {
    if (deleting) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/tasks/${task.taskId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setDeleting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !deleting && onClose()}>
      <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} disabled={deleting} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">タスクを削除</h2>
        <div className="confirm-delete">
          <p>
            <span className="mono">
              {task.project}-{task.taskId}
            </span>{' '}
            {task.title}
          </p>
          <p>
            このタスクを削除しますか？ ノートは <span className="mono">_task/.trash/</span>{' '}
            に移動します（実体は消えません。Obsidian で元のフォルダに戻せば復元できます）。
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="form-buttons">
            {/* Enter で誤って消さないよう、最初のフォーカスはキャンセルに置く */}
            <button className="btn" onClick={onClose} disabled={deleting} autoFocus>
              キャンセル
            </button>
            <button className="btn btn-danger" onClick={runDelete} disabled={deleting}>
              {deleting ? '削除中…' : '削除する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
