import { useEffect, useState } from 'react'

type ImportItem = {
  key: string // 行の識別子。1つの Todoist タスクが複数のプロジェクトに入るので todoistId だけでは足りない
  todoistId: string
  project: string
  title: string
  due: string | null
  priority: string | null
  tags: string[]
}

type CleanupItem = { todoistId: string; taskId: number; title: string; project: string }

type AfterSync = 'none' | 'complete' | 'delete'

type Preview = {
  afterSync: AfterSync // 実行時に Todoist 側をどうするか（設定の値）
  imports: ImportItem[]
  skipped: number
  cleanup: CleanupItem[]
  projects: { project: string; todoistProject: string; found: boolean; todoistTag: string; tagFound: boolean }[]
}

type Result = {
  imported: { taskId: number; title: string; project: string }[]
  skipped: number
  failed: { project: string; title: string; error: string }[]
  cleanup: CleanupItem[]
  afterSync: {
    action: AfterSync
    done: { todoistId: string; title: string }[]
    held: { todoistId: string; title: string; reason: string }[]
    failed: { todoistId: string; title: string; error: string }[]
  }
}

// 実行ボタンの表記。Todoist 側で何が起きるかを押す前に示す
function runLabel(afterSync: AfterSync, selected: number, hasCleanup: boolean): string {
  if (afterSync === 'none') return `選択した ${selected} 件を取り込む`
  const action = afterSync === 'delete' ? 'Todoist から削除する' : 'Todoist で完了にする'
  if (selected === 0) return `掃除リストのタスクを ${action}`
  return `選択した ${selected} 件を取り込み、${hasCleanup ? '掃除リストと合わせて ' : ''}${action}`
}

// 誤って大量のノートを作らないよう、プレビュー → 選択 → 実行の3段階にする。
// Todoist への書き込みは設定で「完了にする」「削除する」を選んだときだけで、実行前に画面とボタンで明示する
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
        setSelected(new Set((data as Preview).imports.map((i) => i.key)))
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll() {
    if (!preview) return
    setSelected((prev) => (prev.size === preview.imports.length ? new Set() : new Set(preview.imports.map((i) => i.key))))
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
        body: JSON.stringify({ keys: [...selected] }),
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
          プロジェクト設定で Todoist
          プロジェクト名かタグを指定したプロジェクトが対象です。複数のプロジェクトにマッチしたタスクは、プロジェクトごとに別のタスクとして取り込みます。
          {preview?.afterSync === 'none' && 'Todoist 側は変更しません（設定で変更できます）。'}
          {preview?.afterSync === 'complete' && '取り込んだタスクと掃除リストのタスクは Todoist 側で完了にします（設定で変更できます）。'}
        </p>
        {preview?.afterSync === 'delete' && !result && (
          <p className="form-warning">
            ⚠ 取り込んだタスクと掃除リストのタスクを Todoist から削除します。元に戻せません（設定で変更できます）。
          </p>
        )}

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
            {preview.projects.some((p) => !p.tagFound) && (
              <p className="form-warning">
                ⚠ Todoist に見つからないタグ:{' '}
                {preview.projects
                  .filter((p) => !p.tagFound)
                  .map((p) => `${p.project} → ${p.todoistTag}`)
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
                  </tr>
                </thead>
                <tbody>
                  {preview.imports.map((i) => (
                    <tr key={i.key}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(i.key)}
                          onChange={() => toggle(i.key)}
                          aria-label={`${i.project} に ${i.title} を取り込む`}
                        />
                      </td>
                      <td className="mono">{i.project}</td>
                      <td>{i.title}</td>
                      <td>{i.priority ?? <span className="muted">—</span>}</td>
                      <td className="mono">{i.due ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="form-actions">
              <span className="form-hint">取り込むと Backlog 列に入ります（Ready への配置は手動）</span>
              <button
                className={`btn ${preview.afterSync === 'delete' ? 'btn-danger' : 'btn-primary'}`}
                onClick={run}
                disabled={running || (selected.size === 0 && (preview.afterSync === 'none' || preview.cleanup.length === 0))}
              >
                {running ? '実行中…' : runLabel(preview.afterSync, selected.size, preview.cleanup.length > 0)}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            {result.imported.length > 0 && (
              <>
                <h3 className="section-head">取り込みました（{result.imported.length}）</h3>
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
              </>
            )}
            {result.failed.length > 0 && (
              <>
                <h3 className="section-head">失敗（{result.failed.length}）</h3>
                <ul className="sync-list">
                  {result.failed.map((f) => (
                    <li key={`${f.project}:${f.title}`}>
                      <span className="mono">{f.project}</span> {f.title} — <span className="form-error">{f.error}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.afterSync.done.length > 0 && (
              <>
                <h3 className="section-head">
                  {result.afterSync.action === 'delete' ? 'Todoist から削除しました' : 'Todoist で完了にしました'}（
                  {result.afterSync.done.length}）
                </h3>
                <ul className="sync-list">
                  {result.afterSync.done.map((d) => (
                    <li key={d.todoistId}>{d.title}</li>
                  ))}
                </ul>
              </>
            )}
            {result.afterSync.held.length > 0 && (
              <>
                <h3 className="section-head">Todoist 側はそのままにしました（{result.afterSync.held.length}）</h3>
                <ul className="sync-list">
                  {result.afterSync.held.map((h) => (
                    <li key={h.todoistId}>
                      {h.title} — <span className="muted">{h.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.afterSync.failed.length > 0 && (
              <>
                <h3 className="section-head">Todoist 側の処理に失敗しました（{result.afterSync.failed.length}）</h3>
                <p className="form-hint">Bismuth への取込は済んでいます。次回の実行で改めて処理します。</p>
                <ul className="sync-list">
                  {result.afterSync.failed.map((f) => (
                    <li key={f.todoistId}>
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
            <p className="form-hint">
              {preview?.afterSync === 'none'
                ? 'Todoist 側で手で完了・削除してください。'
                : result
                  ? '処理できなかったタスクです。処理できる状態になれば、次回以降の実行で処理します。'
                  : `実行すると Todoist 側で${preview?.afterSync === 'delete' ? '削除' : '完了に'}します。処理できないタスクは結果に理由を表示します。`}
            </p>
            <ul className="sync-list">
              {(result?.cleanup ?? preview?.cleanup ?? []).map((c) => (
                <li key={c.taskId}>
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
