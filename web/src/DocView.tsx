import { useEffect, useState } from 'react'
import VaultMarkdown, { docRawUrl, type DocLink } from './VaultMarkdown'

type Doc = {
  path: string
  name: string
  kind: 'markdown' | 'image' | 'text' | 'other'
  content: string | null
}

function obsidianUrl(vaultName: string, file: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`
}

// タスクにリンクされたドキュメントの表示（読み取り専用・bismuth-35）。タスク詳細モーダルの中身を切り替えて使う
export default function DocView({
  link,
  vaultName,
  backLabel,
  onBack,
  onBackToTask,
  onOpenDoc,
}: {
  link: DocLink
  vaultName: string
  backLabel: string
  onBack: () => void
  onBackToTask?: () => void
  onOpenDoc: (link: DocLink) => void
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setError(null)
    fetch(`/api/docs?${new URLSearchParams(link)}`)
      .then(async (r) => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
        return data as Doc
      })
      .then((d) => {
        if (!cancelled) setDoc(d)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [link])

  // 解決できなかったリンクも Obsidian にはファイル名で渡す（Obsidian 側で探すか新規作成できる）
  const file = doc?.path ?? link.target.split('#')[0]

  return (
    <>
      <div className="doc-toolbar">
        <button className="btn btn-small" onClick={onBack}>
          ← {backLabel}
        </button>
        {onBackToTask && (
          <button className="btn btn-small" onClick={onBackToTask}>
            タスクに戻る
          </button>
        )}
        <a className="btn btn-small doc-obsidian" href={obsidianUrl(vaultName, file)}>
          Obsidian で開く
        </a>
      </div>
      <p className="doc-path mono">{file}</p>
      {error && <p className="modal-error">{error}</p>}
      {!error && !doc && <p className="modal-loading">…</p>}
      {doc?.kind === 'markdown' && (
        <div className="markdown doc-body">
          <VaultMarkdown text={doc.content ?? ''} from={doc.path} onOpenDoc={onOpenDoc} />
        </div>
      )}
      {doc?.kind === 'image' && <img className="doc-image" src={docRawUrl({ target: doc.path, from: '' })} alt={doc.name} />}
      {doc?.kind === 'text' && <pre className="doc-text">{doc.content}</pre>}
      {doc?.kind === 'other' && (
        <p className="section-empty">このファイルは web では表示できません。Obsidian で開いてください</p>
      )}
    </>
  )
}
