import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Mermaid from './Mermaid'

// vault のノートを描画する Markdown（タスク詳細の本文・コメントとドキュメント表示で共用・bismuth-35）。
// [[リンク]] はアプリ内のドキュメント表示で開き、![[図.png]] は vault の画像を表示する

// リンクの中身（target）と、相対パス・同じフォルダ優先の基準にするリンク元ノート（from）
export type DocLink = { target: string; from: string }

// remark で作るリンク・画像の URL。urlTransform で素通しさせ、a / img の描画で読み替える
const DOC_SCHEME = 'bismuth-doc:'
const EMBED_SCHEME = 'bismuth-embed:'

const WIKI_LINK = /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

export function docRawUrl(link: DocLink): string {
  return `/api/docs/raw?${new URLSearchParams(link)}`
}

type MdNode = {
  type: string
  value?: string
  url?: string
  alt?: string
  children?: MdNode[]
  data?: { hProperties?: Record<string, string | undefined> }
}

// テキストノード中の [[リンク]]・![[埋め込み]] をリンク・画像ノードに分ける。無ければ null。
// テキストノードだけを見るので、コード中の [[...]] はそのまま残る
function splitWikiLinks(text: string): MdNode[] | null {
  const nodes: MdNode[] = []
  let last = 0
  for (const m of text.matchAll(WIKI_LINK)) {
    const [whole, bang, rawTarget, alias] = m
    if (m.index > last) nodes.push({ type: 'text', value: text.slice(last, m.index) })
    const target = rawTarget.trim()
    if (bang && IMAGE_EXT.test(target.split('#')[0])) {
      // ![[図.png|300]]・![[図.png|300x200]] の数値は表示サイズ
      const size = alias?.trim().match(/^(\d+)(?:x(\d+))?$/)
      nodes.push({
        type: 'image',
        url: EMBED_SCHEME + encodeURIComponent(target),
        alt: size ? target : (alias ?? target),
        data: size ? { hProperties: { width: size[1], height: size[2] } } : undefined,
      })
    } else {
      // ノートの埋め込み（![[ノート]]）は展開せず、通常のリンクとして出す
      nodes.push({
        type: 'link',
        url: DOC_SCHEME + encodeURIComponent(target),
        children: [{ type: 'text', value: alias ?? target }],
      })
    }
    last = m.index + whole.length
  }
  if (nodes.length === 0) return null
  if (last < text.length) nodes.push({ type: 'text', value: text.slice(last) })
  return nodes
}

function remarkWikiLinks() {
  const walk = (node: MdNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text') return splitWikiLinks(child.value ?? '') ?? [child]
      if (child.type !== 'link' && child.type !== 'linkReference') walk(child)
      return [child]
    })
  }
  return (tree: unknown) => walk(tree as MdNode)
}

function urlTransform(url: string): string {
  if (url.startsWith(DOC_SCHEME) || url.startsWith(EMBED_SCHEME) || url.startsWith('obsidian:')) return url
  return defaultUrlTransform(url)
}

// スキームも # も無い URL は vault 内のファイルへの Markdown リンク（[図](assets/図.png) など）とみなす
function localTarget(url: string): string | null {
  if (!url || url.startsWith('#') || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

export default function VaultMarkdown({
  text,
  from,
  onOpenDoc,
}: {
  text: string
  from: string
  onOpenDoc: (link: DocLink) => void
}) {
  const components: Components = {
    a({ href = '', children }) {
      const target = href.startsWith(DOC_SCHEME) ? decodeURIComponent(href.slice(DOC_SCHEME.length)) : localTarget(href)
      if (target != null) {
        return (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              onOpenDoc({ target, from })
            }}
          >
            {children}
          </a>
        )
      }
      // 外部サイトは別タブで開く（同じタブで開くとボードから離れてしまう）
      return /^https?:/i.test(href) ? (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        <a href={href}>{children}</a>
      )
    },
    img({ src, alt, width, height }) {
      const url = typeof src === 'string' ? src : ''
      const target = url.startsWith(EMBED_SCHEME) ? decodeURIComponent(url.slice(EMBED_SCHEME.length)) : localTarget(url)
      return (
        <img
          src={target == null ? url : docRawUrl({ target, from })}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
        />
      )
    },
    pre({ node, ...props }) {
      const code = node?.children[0]
      if (code?.type === 'element' && code.tagName === 'code') {
        const className = code.properties.className
        if (Array.isArray(className) && className.includes('language-mermaid')) {
          return <Mermaid code={code.children.map((c) => (c.type === 'text' ? c.value : '')).join('')} />
        }
      }
      return <pre {...props} />
    },
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikiLinks]} urlTransform={urlTransform} components={components}>
      {text}
    </ReactMarkdown>
  )
}
