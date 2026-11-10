// Markdown のフェンスコードブロック（``` / ~~~）の扱い（bismuth-282）。
// server/src/markdown.ts の maskCodeBlocks と同じ規則（変えるときは両方そろえる。web と server は別々にビルドするので共有しない）。
// コードブロックの中の「## 」はセクション見出しではないので、本文からセクションを除く（stripSection）ときに無視する
//
// 規則は CommonMark に合わせる:
// - 開始: 行頭の空白 0〜3 個のあとに ``` か ~~~（3 個以上）。``` の後ろの情報文字列（bash など）にバッククォートは置けない
// - 終了: 開始と同じ記号を開始と同じ数以上並べ、後ろは空白だけの行
// - 閉じていない開始行はコードブロックとみなさない（server と同じ）

interface Fence {
  char: string
  len: number
}

function openFence(line: string): Fence | null {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
  if (!m) return null
  if (m[1][0] === '`' && m[2].includes('`')) return null // ```code``` のような1行はインラインコード
  return { char: m[1][0], len: m[1].length }
}

function closesFence(line: string, fence: Fence): boolean {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t\r]*$/)
  return !!m && m[1][0] === fence.char && m[1].length >= fence.len
}

function scanCodeBlocks(lines: string[]): { open: number; close: number }[] {
  const blocks: { open: number; close: number }[] = []
  let i = 0
  while (i < lines.length) {
    const fence = openFence(lines[i])
    if (!fence) {
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && !closesFence(lines[j], fence)) j++
    if (j >= lines.length) {
      i++
      continue
    }
    blocks.push({ open: i, close: j })
    i = j + 1
  }
  return blocks
}

// コードブロックの中身の行を、同じ長さの空白に置き換えた文字列を返す（改行と文字の位置は変えない）。
// 見出しの正規表現はこの結果に当て、見つかった位置で元の文字列を切り貼りする
export function maskCodeBlocks(text: string): string {
  const lines = text.split('\n')
  for (const { open, close } of scanCodeBlocks(lines)) {
    for (let k = open + 1; k < close; k++) lines[k] = ' '.repeat(lines[k].length)
  }
  return lines.join('\n')
}

// 「## <heading>」セクションを本文から除く（TaskModal で専用 UI を持つセクションの二重表示を避ける）。
// コードブロックの中の「## 」はセクションの区切りとみなさない
export function stripSection(body: string, heading: string): string {
  const masked = maskCodeBlocks(body)
  const m = new RegExp(`(?:^|\\n)## ${heading}\\n`).exec(masked)
  if (!m) return body
  const next = masked.indexOf('\n## ', m.index + m[0].length)
  return body.slice(0, m.index) + (next >= 0 ? body.slice(next) : '')
}
