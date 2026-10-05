import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { THEME_LABELS } from './theme'
import type { Theme } from './theme'

export type CardFields = {
  priority: boolean
  due: boolean
  tags: boolean
  estimate: boolean
}

export type Settings = {
  root: string
  taskFolder: string
  trashFolder: string
  configFolder: string
  cardFields: CardFields
  doneHideAfterDays: number | null
  theme: Theme
}

// 全体設定。設定は2つに分かれる:
// - ユーザー設定（このダイアログで編集・同期しない）: root / taskFolder / trashFolder / configFolder。
//   保存先はマシンごとのローカル設定ファイル（環境変数 BISMUTH_CONFIG／既定 ~/.config/bismuth/config.json）。
// - システム設定（アプリが管理・同期する）: projects / 採番カウンター。vault 内 <root>/<configFolder>/config.json。
export default function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [loading, setLoading] = useState(true)
  const [defaults, setDefaults] = useState<Settings | null>(null)
  const [userConfigFile, setUserConfigFile] = useState('')
  const [root, setRoot] = useState('')
  const [taskFolder, setTaskFolder] = useState('')
  const [trashFolder, setTrashFolder] = useState('')
  const [configFolder, setConfigFolder] = useState('')
  const [cardFields, setCardFields] = useState<CardFields>({ priority: true, due: true, tags: false, estimate: false })
  const [doneHideAfterDays, setDoneHideAfterDays] = useState('') // 完了タスクの非表示日数（空欄 = 非表示にしない・bismuth-45）
  const [theme, setTheme] = useState<Theme>('dark') // 画面テーマ（bismuth-174）
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        const s: Settings = d.settings ?? {}
        setDefaults(d.defaults ?? null)
        setUserConfigFile(d.userConfigFile ?? '')
        setRoot(s.root ?? '')
        setTaskFolder(s.taskFolder ?? '')
        setTrashFolder(s.trashFolder ?? '')
        setConfigFolder(s.configFolder ?? '')
        if (s.cardFields) setCardFields(s.cardFields)
        setDoneHideAfterDays(s.doneHideAfterDays != null ? String(s.doneHideAfterDays) : '')
        if (s.theme) setTheme(s.theme)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root,
          taskFolder,
          trashFolder,
          configFolder,
          cardFields,
          // 空欄は null（非表示にしない）。数値はサーバ側で 1 以上の整数に正規化される
          doneHideAfterDays: doneHideAfterDays.trim() === '' ? null : Number(doneHideAfterDays),
          theme,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const s: Settings = data.settings
      setRoot(s.root)
      setTaskFolder(s.taskFolder)
      setTrashFolder(s.trashFolder)
      setConfigFolder(s.configFolder)
      setDoneHideAfterDays(s.doneHideAfterDays != null ? String(s.doneHideAfterDays) : '')
      setTheme(s.theme)
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <h2 className="modal-title">設定</h2>
        {loading ? (
          <p className="modal-loading">…</p>
        ) : (
          <form className="task-form" onSubmit={save}>
            <label>
              ルートフォルダ
              <input
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder={defaults?.root}
                spellCheck={false}
              />
              <span className="form-hint">
                vault のルート（現在の Obsidian vault の場所）。この配下をタスクの正本とする。マシンごとに異なる。
              </span>
            </label>
            <label>
              タスクフォルダ
              <input
                value={taskFolder}
                onChange={(e) => setTaskFolder(e.target.value)}
                placeholder={defaults?.taskFolder}
                spellCheck={false}
              />
              <span className="form-hint">
                ルートからの相対パス。タスクノートの置き場（<span className="mono">&lt;タスクフォルダ&gt;/&lt;project&gt;/</span>
                ）。
              </span>
            </label>
            <label>
              ゴミ箱フォルダ
              <input
                value={trashFolder}
                onChange={(e) => setTrashFolder(e.target.value)}
                placeholder={defaults?.trashFolder}
                spellCheck={false}
              />
              <span className="form-hint">ルートからの相対パス。タスクを削除したときのファイル移動先。</span>
            </label>
            <label>
              システム設定フォルダ
              <input
                value={configFolder}
                onChange={(e) => setConfigFolder(e.target.value)}
                placeholder={defaults?.configFolder}
                spellCheck={false}
              />
              <span className="form-hint">
                ルートからの相対パス（vault 内）。プロジェクト定義・採番カウンターなど、アプリが管理し
                <strong>マシン間で同期される</strong>システム設定 <span className="mono">config.json</span> の置き場。
              </span>
            </label>

            <div className="settings-section">
              <div className="settings-section-title">一覧カードに表示する項目</div>
              <div className="settings-checks">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cardFields.priority}
                    onChange={(e) => setCardFields((c) => ({ ...c, priority: e.target.checked }))}
                  />
                  優先度
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cardFields.due}
                    onChange={(e) => setCardFields((c) => ({ ...c, due: e.target.checked }))}
                  />
                  期限
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cardFields.tags}
                    onChange={(e) => setCardFields((c) => ({ ...c, tags: e.target.checked }))}
                  />
                  タグ
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cardFields.estimate}
                    onChange={(e) => setCardFields((c) => ({ ...c, estimate: e.target.checked }))}
                  />
                  見積時間
                </label>
              </div>
              <span className="form-hint">タイトルの下に 優先度 → 期限 → タグ → 見積 の順で表示します。</span>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">完了タスクの非表示</div>
              <label>
                完了からの日数（日）
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={doneHideAfterDays}
                  onChange={(e) => setDoneHideAfterDays(e.target.value)}
                  placeholder="例: 7"
                />
                <span className="form-hint">
                  完了日からこの日数が経過した done タスクをボードに表示しません（ノートの実体は消さず、番号でタスクを開く検索にはこれまで通りヒットします）。空欄なら常に表示します。
                </span>
              </label>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">テーマ</div>
              <div className="settings-checks">
                {(Object.keys(THEME_LABELS) as Theme[]).map((t) => (
                  <label key={t} className="check">
                    <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
                    {THEME_LABELS[t]}
                  </label>
                ))}
              </div>
              <span className="form-hint">「OS に合わせる」は OS のライト／ダーク設定に追従します。</span>
            </div>

            <div className="settings-info">
              <div className="settings-info-row">
                <span className="settings-info-key">ユーザー設定ファイル</span>
                <span className="mono settings-info-val">{userConfigFile || '—'}</span>
              </div>
              <p className="form-hint">
                上の4項目（ユーザー設定）はここに保存されます。<strong>同期しない</strong>マシンごとの設定なので vault
                の外に置きます。場所は環境変数 <span className="mono">BISMUTH_CONFIG</span>
                で変更できます（未設定なら <span className="mono">~/.config/bismuth/config.json</span>）。
              </p>
            </div>

            {saved && !error && <p className="modal-notice">保存しました</p>}
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
