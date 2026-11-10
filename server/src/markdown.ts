// Markdown のフェンスコードブロック（``` / ~~~）の扱い（bismuth-282）。
// コードブロックの中の「# 」「## 」は見出しではないので、見出しの検査とセクションの切り出しでは無視する。
// web 側の web/src/markdown.ts も同じ規則で書いている（変えるときは両方そろえる）
//
// 規則は CommonMark に合わせる:
// - 開始: 行頭の空白 0〜3 個のあとに ``` か ~~~（3 個以上）。``` の後ろの情報文字列（bash など）にバッククォートは置けない
// - 終了: 開始と同じ記号を開始と同じ数以上並べ、後ろは空白だけの行
// - 閉じていない開始行はコードブロックとみなさない。CommonMark ではノートの末尾までがコードブロックになるが、
//   そう扱うと後続のセクション見出しまで隠れて、セクションを読み書きできなくなるため

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

interface CodeBlockScan {
  blocks: { open: number; close: number }[] // 開始行・終了行の行番号（0 始まり）
  unclosed: Fence | null // 閉じていない最初の開始行のフェンス
}

function scanCodeBlocks(lines: string[]): CodeBlockScan {
  const blocks: CodeBlockScan['blocks'] = []
  let unclosed: Fence | null = null
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
      unclosed ??= fence
      i++
      continue
    }
    blocks.push({ open: i, close: j })
    i = j + 1
  }
  return { blocks, unclosed }
}

// コードブロックの中身の行を、同じ長さの空白に置き換えた文字列を返す（改行と文字の位置は変えない）。
// 見出しの正規表現はこの結果に当て、見つかった位置で元の文字列を切り貼りする
export function maskCodeBlocks(text: string): string {
  const lines = text.split('\n')
  for (const { open, close } of scanCodeBlocks(lines).blocks) {
    for (let k = open + 1; k < close; k++) lines[k] = ' '.repeat(lines[k].length)
  }
  return lines.join('\n')
}

// 閉じていないコードブロックがあれば、閉じるのに要るフェンス（``` など）を返す。無ければ null
export function unclosedCodeFence(text: string): string | null {
  const { unclosed } = scanCodeBlocks(text.split('\n'))
  return unclosed ? unclosed.char.repeat(unclosed.len) : null
}
