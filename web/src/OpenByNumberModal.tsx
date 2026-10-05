import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Props = {
  taskIds: number[]
  onOpen: (taskId: number) => void
  onClose: () => void
}

// タスク番号を入力して該当タスクを開くダイアログ（bismuth-121）。
// Enter（フォーム送信）または OK で開く。存在しない番号はダイアログ内にエラー表示
export default function OpenByNumberModal({ taskIds, onOpen, onClose }: Props) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(value.trim())
    if (value.trim() === '' || !Number.isInteger(n) || n <= 0) {
      setError('タスク番号（正の整数）を入力してください')
      return
    }
    if (!taskIds.includes(n)) {
      setError(`タスク No.${n} は見つかりません`)
      return
    }
    onOpen(n)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">番号でタスクを開く</h2>
        <form className="task-form" onSubmit={submit}>
          <label>
            タスク番号
            <input
              value={value}
              inputMode="numeric"
              placeholder="例: 122"
              autoFocus
              onChange={(e) => {
                setValue(e.target.value)
                setError(null) // 入力し直したら前回のエラーを消す
              }}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary">
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
