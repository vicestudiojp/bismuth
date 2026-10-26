// リンクされたドキュメントの閲覧（[[リンク]] の解決・ドキュメントの読み出し）の実地検証（bismuth-35）。
// 本番 vault には触れず、一時ディレクトリにミニ vault を作って検証する。
// 実行: npx tsx server/scripts/verify-docs.ts
//
// 方針:
// - [[リンク]] は Obsidian と同じくファイル名で vault 全体から解決する（拡張子なしは .md を補う）
// - 同名が複数あればリンク元と同じフォルダ → 浅い → 短い → 名前順
// - Obsidian の設定・ゴミ箱、Bismuth のゴミ箱（削除したタスク）は対象外。他のドット始まりのフォルダは対象
// - 読み取り専用。vault の外は開けない
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { imageType, listVaultFiles, locateDoc, readDoc, resolveLink } from '../src/docs.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`PASS: ${name}`)
  } else {
    fail++
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- 解決規則（ファイル一覧だけで決まる純粋関数） ----

const files = [
  'notes/設計メモ.md',
  'alpha/設計メモ.md',
  'alpha/deep/nested/設計メモ.md',
  'beta/README.md',
  'readme.md',
  'beta/sub/仕様.md',
  'assets/構成図.png',
  'alpha/data.csv',
  'ドキュメント.md',
]

check('ファイル名だけで .md を補って解決', resolveLink(files, '仕様') === 'beta/sub/仕様.md')
check('拡張子付きのリンクはそのまま解決', resolveLink(files, '構成図.png') === 'assets/構成図.png')
check('.md 付きのリンクも解決', resolveLink(files, '仕様.md') === 'beta/sub/仕様.md')
check(
  '同名が複数ならリンク元と同じフォルダを優先',
  resolveLink(files, '設計メモ', 'alpha/タスク.md') === 'alpha/設計メモ.md',
  String(resolveLink(files, '設計メモ', 'alpha/タスク.md')),
)
check(
  '同じフォルダに無ければ浅い→短い→名前順',
  resolveLink(files, '設計メモ', '_task/beta/task.md') === 'alpha/設計メモ.md',
  String(resolveLink(files, '設計メモ', '_task/beta/task.md')),
)
check('フォルダ付きのリンクはパスの末尾で一致', resolveLink(files, 'nested/設計メモ') === 'alpha/deep/nested/設計メモ.md')
check('vault ルートからのパスで完全一致', resolveLink(files, 'notes/設計メモ', 'alpha/x.md') === 'notes/設計メモ.md')
check('#見出し は無視してノートを開く', resolveLink(files, '仕様#背景') === 'beta/sub/仕様.md')
check('#^ブロック も無視してノートを開く', resolveLink(files, '仕様#^abc123') === 'beta/sub/仕様.md')
check('大文字小文字の違いは無視', resolveLink(files, 'README', 'x/y.md') === 'readme.md')
check(
  '大文字小文字だけ違う同名はリンク元と同じフォルダを優先',
  resolveLink(files, 'README', 'beta/task.md') === 'beta/README.md',
)
check('Unicode 正規化の違い（NFD の濁点）は無視', resolveLink(files, 'ドキュメント'.normalize('NFD')) === 'ドキュメント.md')
check('リンク元からの相対パス（../）', resolveLink(files, '../sub/仕様.md', 'beta/other/doc.md') === 'beta/sub/仕様.md')
check('リンク元からの相対パス（./）', resolveLink(files, './data.csv', 'alpha/doc.md') === 'alpha/data.csv')
check('先頭の / は vault ルートとみなす', resolveLink(files, '/notes/設計メモ.md', 'alpha/x.md') === 'notes/設計メモ.md')
check('見つからなければ null', resolveLink(files, '存在しないノート') === null)
check('#見出し だけのリンクは null', resolveLink(files, '#見出し') === null)
check('vault の外を指すパスは解決しない', resolveLink(files, '../../../etc/passwd', 'alpha/x.md') === null)
check('画像の Content-Type', imageType('a/b.PNG') === 'image/png' && imageType('x.svg') === 'image/svg+xml')
check('画像以外は Content-Type を返さない', imageType('x.md') === null && imageType('x.csv') === null)

// ---- ミニ vault での読み出し ----

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
function put(rel: string, content: string | Buffer) {
  const abs = path.join(vault, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

put('_task/alpha/alpha-task-1-起票.md', '---\ntask-id: 1\n---\n\n# 1 起票\n\n## 成果物・関連リンク\n\n- [[成果物ノート]]\n')
put('__inbox/成果物ノート.md', '---\ntitle: 成果物\ntags: [a, b]\n---\n\n# 成果物ノート\n\n本文。[[別ノート]]\n')
put('__inbox/壊れた frontmatter.md', '---\ntitle: "閉じていない\n---\n\n本文は読める。\n')
put('__inbox/frontmatter なし.md', '# 見出し\n\n---\n\n区切り線は本文として残る。\n')
put('.company/秘書メモ.md', '秘書のメモ。\n')
put('.obsidian/設定ノート.md', 'Obsidian の設定。\n')
put('.trash/捨てたノート.md', 'Obsidian のゴミ箱。\n')
put('_task/.trash/alpha-task-9-削除済み.md', '---\ntask-id: 9\n---\n')
put('_assets/構成図.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
put('_assets/表.csv', 'a,b\n1,2\n')
put('_assets/資料.pdf', '%PDF-1.4')
put('_assets/巨大ログ.txt', 'x'.repeat(2 * 1024 * 1024 + 1))

const listed = await listVaultFiles(vault)
check('一覧: ドット始まりのフォルダ（.company）は含める', listed.includes('.company/秘書メモ.md'))
check('一覧: .obsidian は含めない', !listed.some((f) => f.startsWith('.obsidian/')))
check('一覧: Obsidian のゴミ箱（.trash）は含めない', !listed.some((f) => f.startsWith('.trash/')))
check('一覧: Bismuth のゴミ箱（削除したタスク）は含めない', !listed.some((f) => f.startsWith('_task/.trash/')))

const doc = await readDoc(vault, { target: '成果物ノート', from: '_task/alpha/alpha-task-1-起票.md' })
check('読み出し: タスクノートからのリンクを解決', doc?.path === '__inbox/成果物ノート.md', JSON.stringify(doc))
check('読み出し: 種類は markdown', doc?.kind === 'markdown')
check('読み出し: 表示名は拡張子なし', doc?.name === '成果物ノート')
check(
  '読み出し: frontmatter を除き本文を返す',
  doc?.content?.startsWith('\n# 成果物ノート') === true && !doc.content.includes('title: 成果物'),
  JSON.stringify(doc?.content),
)
check('読み出し: 本文中の [[リンク]] はそのまま返す（web が変換する）', doc?.content?.includes('[[別ノート]]') === true)

const broken = await readDoc(vault, { target: '壊れた frontmatter' })
check('読み出し: 壊れた frontmatter でも本文を返す', broken?.content?.trim() === '本文は読める。', JSON.stringify(broken?.content))
const plain = await readDoc(vault, { target: 'frontmatter なし' })
check('読み出し: frontmatter の無いノートの区切り線は残す', plain?.content?.includes('---\n\n区切り線') === true)

check('読み出し: .company のノートを開ける', (await readDoc(vault, { target: '秘書メモ' }))?.path === '.company/秘書メモ.md')
check('読み出し: .obsidian のノートは開けない', (await readDoc(vault, { target: '設定ノート' })) === null)
check('読み出し: Obsidian のゴミ箱は開けない', (await readDoc(vault, { target: '捨てたノート' })) === null)
check('読み出し: 削除したタスクは開けない', (await readDoc(vault, { target: 'alpha-task-9-削除済み' })) === null)

const image = await readDoc(vault, { target: '構成図.png' })
check('読み出し: 画像は kind=image・中身は返さない', image?.kind === 'image' && image.content === null && image.name === '構成図.png')
const csv = await readDoc(vault, { target: '表.csv' })
check('読み出し: CSV は kind=text で中身を返す', csv?.kind === 'text' && csv.content === 'a,b\n1,2\n')
const pdf = await readDoc(vault, { target: '資料.pdf' })
check('読み出し: 表示できない形式は kind=other', pdf?.kind === 'other' && pdf.content === null)
const huge = await readDoc(vault, { target: '巨大ログ.txt' })
check('読み出し: 2MB を超えるテキストは kind=other', huge?.kind === 'other' && huge.content === null)
check('読み出し: 見つからなければ null', (await readDoc(vault, { target: '存在しない' })) === null)
check(
  'locateDoc: 解決結果は vault 相対パス',
  (await locateDoc(vault, { target: '構成図.png', from: '__inbox/成果物ノート.md' })) === '_assets/構成図.png',
)

let rejected = false
try {
  await readDoc(vault, { target: '  ' })
} catch {
  rejected = true
}
check('target が空ならエラー', rejected)

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
