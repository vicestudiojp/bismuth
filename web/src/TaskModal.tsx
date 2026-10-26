import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import DocView from './DocView'
import RepeatInput, { repeatLabel } from './RepeatInput'
import VaultMarkdown, { type DocLink } from './VaultMarkdown'

const STATUSES = ['icebox', 'backlog', 'ready', 'inprogress', 'done', 'dropped']
const PRIORITIES = ['P1', 'P2', 'P3', 'P4']

type TaskAttrs = {
  taskId: number
  title: string
  project: string
  status: string
  priority: string | null
  due: string | null
  repeat: string | null
  tags: string[]
  estimate: number | null
  created: string | null
  updated: string | null
  file: string
}

type Comment = {
  at: string
  author: string
  body: string
}

type WorkSession = {
  start: string
  end: string | null
  memo: string
}

type Detail = {
  task: TaskAttrs
  body: string
  overview: string
  subtasks: string
  comments: Comment[]
  workSessions: WorkSession[]
  vaultName: string
  renamed?: { from: string; to: string } | null
  recurred?: { from: string | null; to: string } | null
}

// 本文先頭の「# <id> <タイトル>」はモーダルタイトルと重複するため表示から除く
function stripLeadingH1(body: string): string {
  return body.replace(/^\s*# [^\n]*\n/, '')
}

// 専用 UI を持つセクションは本文レンダリングから除く（二重表示の回避）
function stripSection(body: string, heading: string): string {
  return body.replace(new RegExp(`(?:^|\\n)## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`), '')
}

// フォームの datetime-local（2026-07-13T15:20）とノートの表記（2026-07-13 15:20）を相互変換する
function toStamp(v: string): string {
  return v.replace('T', ' ').slice(0, 16)
}

// 作成・更新は分まで記録する（2026-07-13T15:20・bismuth-223）が、画面には日付だけ出す
function dateOnly(v: string | null): string {
  return v ? v.slice(0, 10) : '-'
}

function nowLocalInput(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 実施時間は保存しない導出値（F1 設計 2.1）。終了時刻が未記入の行は合算しない
function totalMinutes(sessions: WorkSession[]): number {
  return sessions.reduce((sum, s) => {
    if (!s.end) return sum
    const min = (new Date(s.end.replace(' ', 'T')).getTime() - new Date(s.start.replace(' ', 'T')).getTime()) / 60000
    return Number.isFinite(min) && min > 0 ? sum + min : sum
  }, 0)
}

function formatHours(min: number): string {
  return `${(min / 60).toFixed(2).replace(/\.?0+$/, '')}h`
}

export default function TaskModal({
  taskId,
  onClose,
  onUpdated,
}: {
  taskId: number
  onClose: () => void
  onUpdated?: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState(false)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [notice, setNotice] = useState<string | null>(null)

  // 編集フォームの状態
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState('backlog')
  const [priority, setPriority] = useState('')
  const [due, setDue] = useState('')
  const [repeat, setRepeat] = useState('')
  const [tags, setTags] = useState('')
  const [estimate, setEstimate] = useState('')
  const [overview, setOverview] = useState('')
  const [subtasks, setSubtasks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // コメント投稿の状態
  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)

  // 作業記録の入力状態
  const [wsOpen, setWsOpen] = useState(false)
  const [wsStart, setWsStart] = useState('')
  const [wsEnd, setWsEnd] = useState('')
  const [wsMemo, setWsMemo] = useState('')
  const [wsSaving, setWsSaving] = useState(false)
  const [wsError, setWsError] = useState<string | null>(null)

  // リンクから開いたドキュメントの履歴（空ならタスクを表示する）。戻ったときはタスクのスクロール位置を復元する
  const [docStack, setDocStack] = useState<DocLink[]>([])
  const modalRef = useRef<HTMLDivElement>(null)
  const taskScrollTop = useRef(0)

  useEffect(() => {
    setDetail(null)
    setError(false)
    setMode('view')
    setDocStack([])
    taskScrollTop.current = 0
    setNotice(null)
    setComment('')
    setCommentError(null)
    setWsOpen(false)
    setWsError(null)
    setConfirmDelete(false)
    setDeleteError(null)
    fetch(`/api/tasks/${taskId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setDetail)
      .catch(() => setError(true))
  }, [taskId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useLayoutEffect(() => {
    if (modalRef.current) modalRef.current.scrollTop = docStack.length === 0 ? taskScrollTop.current : 0
  }, [docStack])

  function openDoc(link: DocLink) {
    if (docStack.length === 0) taskScrollTop.current = modalRef.current?.scrollTop ?? 0
    setDocStack((s) => [...s, link])
  }

  function startEdit() {
    if (!detail) return
    setTitle(detail.task.title)
    setStatus(detail.task.status)
    setPriority(detail.task.priority ?? '')
    setDue(detail.task.due ?? '')
    setRepeat(detail.task.repeat ?? '')
    setTags(detail.task.tags.join(', '))
    setEstimate(detail.task.estimate == null ? '' : String(detail.task.estimate))
    setOverview(detail.overview)
    setSubtasks(detail.subtasks)
    setSaveError(null)
    setNotice(null)
    setMode('edit')
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault()
    if (!detail) return
    // 変更のあったフィールドだけ送る（本文未編集ならタイトル変更時の H1 同期はサーバーに任せる）
    const payload: Record<string, unknown> = {}
    if (title.trim() !== detail.task.title) payload.title = title.trim()
    if (status !== detail.task.status) payload.status = status
    if ((priority || null) !== detail.task.priority) payload.priority = priority || null
    if ((due || null) !== detail.task.due) payload.due = due || null
    if ((repeat || null) !== detail.task.repeat) payload.repeat = repeat || null
    const tagsArr = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (tagsArr.join('\u0000') !== detail.task.tags.join('\u0000')) payload.tags = tagsArr
    const est = estimate === '' ? null : Number(estimate)
    if (est !== detail.task.estimate) payload.estimate = est
    if (overview !== detail.overview) payload.overview = overview
    if (subtasks.trim() !== detail.subtasks) payload.subtasks = subtasks

    if (Object.keys(payload).length === 0) {
      setMode('view')
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setDetail(data)
      const notices: string[] = []
      if (data.recurred) {
        notices.push(`繰り返しタスクのため、次回期限 ${data.recurred.to} で backlog に戻しました`)
      }
      if (data.renamed) {
        notices.push(
          `ファイル名を「${data.renamed.to}」に変更しました。このノートへの [[リンク]] は自動では追従しないため、参照元がある場合は Obsidian 側で更新してください`,
        )
      }
      if (notices.length > 0) setNotice(notices.join('。'))
      setMode('view')
      onUpdated?.()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // submit と ⌘+Enter の両方から呼ぶ（KeyboardEvent も受けられるよう最小の型で受ける）
  async function postComment(e: { preventDefault: () => void }) {
    e.preventDefault()
    const body = comment.trim()
    if (!body || posting) return
    setPosting(true)
    setCommentError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setDetail(data)
      setComment('')
      onUpdated?.()
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : String(err))
    } finally {
      setPosting(false)
    }
  }

  async function runDelete() {
    if (deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onUpdated?.() // ボードを読み直す（削除したタスクはスキャン対象外になるので消える）
      onClose()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
      setDeleting(false)
    }
  }

  function openWorkSessionForm() {
    setWsStart(nowLocalInput())
    setWsEnd('')
    setWsMemo('')
    setWsError(null)
    setWsOpen(true)
  }

  async function submitWorkSession(e: FormEvent) {
    e.preventDefault()
    if (!wsStart || wsSaving) return
    setWsSaving(true)
    setWsError(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/work-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: toStamp(wsStart),
          end: wsEnd ? toStamp(wsEnd) : null,
          memo: wsMemo.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setDetail(data)
      setWsOpen(false)
      onUpdated?.()
    } catch (err) {
      setWsError(err instanceof Error ? err.message : String(err))
    } finally {
      setWsSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={modalRef} className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        {error && <p className="modal-error">読み込みに失敗しました</p>}
        {!error && !detail && <p className="modal-loading">…</p>}
        {detail && mode === 'view' && docStack.length > 0 && (
          <>
            <div className="modal-head">
              <span className="card-id">
                {detail.task.project}-{detail.task.taskId}
              </span>
              <span className="status-chip">ドキュメント</span>
            </div>
            <DocView
              link={docStack[docStack.length - 1]}
              vaultName={detail.vaultName}
              backLabel={docStack.length > 1 ? '戻る' : 'タスクに戻る'}
              onBack={() => setDocStack((s) => s.slice(0, -1))}
              onBackToTask={docStack.length > 1 ? () => setDocStack([]) : undefined}
              onOpenDoc={openDoc}
            />
          </>
        )}
        {detail && mode === 'view' && docStack.length === 0 && (
          <>
            <div className="modal-head">
              <span className="card-id">
                {detail.task.project}-{detail.task.taskId}
              </span>
              <span className={`status-chip status-${detail.task.status}`}>{detail.task.status}</span>
              {/* 優先度なしは何も出さない（Todoist 準拠） */}
              {detail.task.priority && (
                <span className={`prio prio-${detail.task.priority}`}>{detail.task.priority}</span>
              )}
              {/* 右上の × と誤爆しないよう、× の隣は無害な「編集」にし、削除を遠ざける（bismuth-47） */}
              <span className="modal-actions">
                <button className="btn btn-small" onClick={() => setConfirmDelete(true)}>
                  削除
                </button>
                <button className="btn btn-edit" onClick={startEdit}>
                  編集
                </button>
              </span>
            </div>
            <h2 className="modal-title">{detail.task.title}</h2>
            {notice && <p className="modal-notice">{notice}</p>}
            {confirmDelete && (
              <div className="confirm-delete">
                <p>
                  このタスクを削除しますか？ ノートは <span className="mono">_task/.trash/</span>{' '}
                  に移動します（実体は消えません。Obsidian で元のフォルダに戻せば復元できます）。
                </p>
                {deleteError && <p className="form-error">{deleteError}</p>}
                <div className="form-buttons">
                  <button className="btn" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                    キャンセル
                  </button>
                  <button className="btn btn-danger" onClick={runDelete} disabled={deleting}>
                    {deleting ? '削除中…' : '削除する'}
                  </button>
                </div>
              </div>
            )}
            <dl className="modal-meta">
              {detail.task.due && (
                <div>
                  <dt>期限</dt>
                  <dd>{detail.task.due}</dd>
                </div>
              )}
              {detail.task.repeat && (
                <div>
                  <dt>繰り返し</dt>
                  <dd>↻ {repeatLabel(detail.task.repeat)}</dd>
                </div>
              )}
              {detail.task.estimate != null && (
                <div>
                  <dt>見積</dt>
                  <dd>{detail.task.estimate}h</dd>
                </div>
              )}
              {detail.task.tags.length > 0 && (
                <div>
                  <dt>タグ</dt>
                  <dd>{detail.task.tags.join(', ')}</dd>
                </div>
              )}
              <div>
                <dt>作成</dt>
                <dd>{dateOnly(detail.task.created)}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>{dateOnly(detail.task.updated)}</dd>
              </div>
              <div className="meta-file">
                <dt>ファイル</dt>
                <dd className="mono">{detail.task.file}</dd>
              </div>
            </dl>
            <div className="modal-body markdown">
              <VaultMarkdown
                text={stripSection(stripSection(stripLeadingH1(detail.body), 'コメント'), '作業記録')}
                from={detail.task.file}
                onOpenDoc={openDoc}
              />
            </div>
            <section className="work-sessions">
              <h3 className="section-head">
                作業記録（{detail.workSessions.length}）
                {detail.workSessions.length > 0 && (
                  <span className="ws-total">
                    合計 {formatHours(totalMinutes(detail.workSessions))}
                    {detail.task.estimate != null && ` / 見積 ${detail.task.estimate}h`}
                  </span>
                )}
                {!wsOpen && (
                  <button className="btn btn-small" onClick={openWorkSessionForm}>
                    ＋ 記録を追加
                  </button>
                )}
              </h3>
              {detail.workSessions.length > 0 && (
                <table className="ws-table">
                  <thead>
                    <tr>
                      <th>開始</th>
                      <th>終了</th>
                      <th>時間</th>
                      <th>メモ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.workSessions.map((s, i) => (
                      <tr key={`${s.start}-${i}`}>
                        <td className="mono">{s.start}</td>
                        <td className="mono">{s.end ?? '—'}</td>
                        <td className="mono">{s.end ? formatHours(totalMinutes([s])) : '作業中'}</td>
                        <td>{s.memo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {detail.workSessions.length === 0 && !wsOpen && <p className="section-empty">まだ記録はありません</p>}
              {wsOpen && (
                <form className="task-form ws-form" onSubmit={submitWorkSession}>
                  <div className="form-row">
                    <label>
                      開始 *
                      <input
                        type="datetime-local"
                        value={wsStart}
                        onChange={(e) => setWsStart(e.target.value)}
                        required
                      />
                    </label>
                    <label>
                      終了（空欄なら「作業中」）
                      <input type="datetime-local" value={wsEnd} onChange={(e) => setWsEnd(e.target.value)} />
                    </label>
                  </div>
                  <label>
                    メモ
                    <input value={wsMemo} onChange={(e) => setWsMemo(e.target.value)} />
                  </label>
                  {wsError && <p className="form-error">{wsError}</p>}
                  <div className="form-actions">
                    <span className="form-hint">ノートの「## 作業記録」表に1行追記されます</span>
                    <span className="form-buttons">
                      <button type="button" className="btn" onClick={() => setWsOpen(false)}>
                        キャンセル
                      </button>
                      <button type="submit" className="btn btn-primary" disabled={wsSaving || !wsStart}>
                        {wsSaving ? '追記中…' : '追加'}
                      </button>
                    </span>
                  </div>
                </form>
              )}
            </section>
            <section className="comments">
              <h3 className="section-head">コメント（{detail.comments.length}）</h3>
              {detail.comments.length === 0 && <p className="section-empty">まだコメントはありません</p>}
              {detail.comments.map((c, i) => (
                <article className="comment" key={`${c.at}-${i}`}>
                  <header className="comment-head">
                    <span className="comment-author">{c.author}</span>
                    <span className="comment-at">{c.at}</span>
                  </header>
                  <div className="comment-body markdown">
                    <VaultMarkdown text={c.body} from={detail.task.file} onOpenDoc={openDoc} />
                  </div>
                </article>
              ))}
              <form className="comment-form" onSubmit={postComment}>
                <textarea
                  value={comment}
                  onChange={(e) => {
                    setComment(e.target.value)
                    if (commentError) setCommentError(null)
                  }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment(e)
                  }}
                  rows={3}
                  placeholder="コメントを追記（Markdown 可・見出し # ## ### は不可）"
                />
                {commentError && <p className="form-error">{commentError}</p>}
                <div className="form-actions">
                  <span className="form-hint">オーナー名義でノートの「## コメント」に追記されます（⌘+Enter）</span>
                  <button type="submit" className="btn btn-primary" disabled={posting || !comment.trim()}>
                    {posting ? '追記中…' : 'コメントする'}
                  </button>
                </div>
              </form>
            </section>
          </>
        )}
        {detail && mode === 'edit' && (
          <>
            <div className="modal-head">
              <span className="card-id">
                {detail.task.project}-{detail.task.taskId}
              </span>
              <span className="status-chip">編集中</span>
            </div>
            <form className="task-form task-form-edit" onSubmit={submitEdit}>
              <label>
                タイトル *
                <input value={title} onChange={(e) => setTitle(e.target.value)} required />
              </label>
              {title.trim() !== detail.task.title && (
                <p className="form-warning">
                  ⚠ タイトルを変更するとファイル名も変更されます。このノートへの [[リンク]]
                  は自動では追従しません（必要なら Obsidian 側で手動更新してください）
                </p>
              )}
              <div className="form-row">
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
                タグ（カンマ区切り）
                <input value={tags} onChange={(e) => setTags(e.target.value)} />
              </label>
              <label>
                概要（Markdown・見出し # / ## は使用不可）
                <textarea value={overview} onChange={(e) => setOverview(e.target.value)} rows={8} />
              </label>
              <label>
                サブタスク（Markdown・「- [ ] 項目」で1行1件。小見出し ### は可）
                <textarea
                  value={subtasks}
                  onChange={(e) => setSubtasks(e.target.value)}
                  rows={6}
                  placeholder="- [ ] サブタスク"
                />
              </label>
              <p className="form-hint">
                編集できる本文は「## 概要」「## サブタスク」セクションのみです。作業記録・コメントは各機能から、それ以外は
                Obsidian で編集してください。プロジェクトは変更できません。
              </p>
              {saveError && <p className="form-error">{saveError}</p>}
              <div className="form-actions">
                <button type="button" className="btn" onClick={() => setMode('view')}>
                  キャンセル
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
