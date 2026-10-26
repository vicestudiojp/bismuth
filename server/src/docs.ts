import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { trashDir } from './settings.js'

// タスクノートからリンクされたドキュメントの閲覧（読み取り専用・bismuth-35）。
// [[リンク]] の中身を Obsidian と同じくファイル名で vault 全体から解決し、web のドキュメント表示に渡す。
// vault 全体の一覧はリクエストごとに取る（数千ファイルで 10ms 前後。索引は持たない）

export type DocKind = 'markdown' | 'image' | 'text' | 'other'

export interface VaultDoc {
  path: string // vault 相対（区切りは /）
  name: string // 表示名（.md は拡張子なし）
  kind: DocKind
  content: string | null // markdown（frontmatter を除く）と text のときだけ入る
}

export interface DocQuery {
  target?: string // [[リンク]] の中身（| 以降を除く。#見出しは付いたままでよい）か Markdown リンクの URL（デコード済み）
  from?: string // リンク元ノートの vault 相対パス（同じフォルダのファイルを優先するのに使う）
}

// 画像は web から <img> で直接読み込むので、配信する種類をここに限る
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

const TEXT_EXTS = new Set(['.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.html', '.css', '.js', '.ts', '.py', '.sh', '.canvas'])

// これより大きいテキストは画面に出さない（Obsidian で開いてもらう）
const MAX_TEXT_BYTES = 2 * 1024 * 1024

// 閲覧の対象外にするフォルダ。Obsidian の設定・ゴミ箱と Bismuth のゴミ箱（削除したタスク）。
// .company など他のドット始まりのフォルダはリンクされうるので対象に含める
function ignoreGlobs(vault: string): string[] {
  const globs = ['**/.obsidian/**', '**/.git/**', '**/node_modules/**', '**/.trash/**']
  const trash = path.relative(vault, trashDir(vault)).split(path.sep).join('/')
  if (trash && !trash.startsWith('..')) globs.push(`${trash}/**`)
  return globs
}

export async function listVaultFiles(vault: string): Promise<string[]> {
  return fg('**/*', { cwd: vault, dot: true, ignore: ignoreGlobs(vault) })
}

// 照合はファイル名の大文字小文字と Unicode 正規化（macOS の濁点の NFD など）の違いを無視する
function key(p: string): string {
  return p.normalize('NFC').toLowerCase()
}

// リンクの中身をファイルに解決する。見つからなければ null。
// 1. リンク元のフォルダからの相対パス、vault ルートからのパスで完全一致
// 2. ファイル名（フォルダ付きならパスの末尾）で一致。複数あればリンク元と同じフォルダ → 浅い → 短い → 名前順
// どちらも拡張子なしなら .md を補う。#見出し・#^ブロック は無視してノートを開く
export function resolveLink(files: string[], target: string, from = ''): string | null {
  const name = target.split('#')[0].trim().replace(/^\/+/, '')
  if (!name) return null
  const wanted = name.toLowerCase().endsWith('.md') ? [name] : [name, `${name}.md`]
  const byKey = new Map(files.map((f) => [key(f), f]))
  const dir = path.posix.dirname(from)

  for (const w of wanted) {
    for (const base of [dir, '']) {
      const hit = byKey.get(key(path.posix.normalize(path.posix.join(base, w))))
      if (hit) return hit
    }
  }

  const suffixes = wanted.map((w) => `/${key(path.posix.normalize(w))}`)
  const hits = files.filter((f) => suffixes.some((s) => `/${key(f)}`.endsWith(s)))
  if (hits.length === 0) return null
  const depth = (f: string) => f.split('/').length
  const sameDir = (f: string) => (path.posix.dirname(f) === dir ? 0 : 1)
  hits.sort((a, b) => sameDir(a) - sameDir(b) || depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))
  return hits[0]
}

export async function locateDoc(vault: string, query: DocQuery): Promise<string | null> {
  const target = (query.target ?? '').trim()
  if (!target) throw new Error('target を指定してください')
  return resolveLink(await listVaultFiles(vault), target, query.from ?? '')
}

function kindOf(file: string): DocKind {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.md') return 'markdown'
  if (IMAGE_TYPES[ext]) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'other'
}

export function imageType(file: string): string | null {
  return IMAGE_TYPES[path.extname(file).toLowerCase()] ?? null
}

export async function readDoc(vault: string, query: DocQuery): Promise<VaultDoc | null> {
  const rel = await locateDoc(vault, query)
  if (!rel) return null
  const abs = path.join(vault, rel)
  let kind = kindOf(rel)
  let content: string | null = null
  if (kind === 'markdown' || kind === 'text') {
    if (fs.statSync(abs).size > MAX_TEXT_BYTES) {
      kind = 'other'
    } else {
      content = fs.readFileSync(abs, 'utf-8')
      // frontmatter は表示しない（YAML として読まないので、壊れた frontmatter でも本文は出せる）
      if (kind === 'markdown') content = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    }
  }
  return { path: rel, name: kind === 'markdown' ? path.posix.basename(rel, '.md') : path.posix.basename(rel), kind, content }
}
