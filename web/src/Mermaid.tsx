import { useEffect, useId, useState } from 'react'

// ```mermaid のコードブロックを図にする（bismuth-35）。
// mermaid は大きいので図を表示するときだけ読み込む（Vite が別ファイルに分ける）。描けるまではソースを出しておく
export default function Mermaid({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true, // 構文エラーの図を本文に差し込ませない（下でソースとエラーを出す）
          theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
        })
        const result = await mermaid.render(id, code)
        if (!cancelled) setSvg(result.svg)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [id, code])

  if (svg) return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  return (
    <>
      <pre>
        <code>{code}</code>
      </pre>
      {error && <p className="form-error">Mermaid の図を描けませんでした: {error}</p>}
    </>
  )
}
