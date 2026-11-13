// web の一覧フィルタの判定ロジック（web/src/filter.ts）の検証。タスク名の部分一致（bismuth-275）と
// タグの記述式（bismuth-291）を中心に見る。
// vault には触れない（純粋関数だけを呼ぶ）。
// 実行: npx tsx scripts/verify-filter.ts
//
// 方針:
// - タスク名は空白（全角も含む）で区切った語をすべて含めば一致する（AND）
// - 英字の大文字小文字、全角半角（NFKC）は区別しない
// - 空・空白だけの入力は条件なし（全件一致・フィルタ未使用の扱い）
// - タスク名と他の項目（プロジェクト・優先度・タグ・期限）は AND
// - タグはカンマ（全角も含む）で区切ったタグのどれかと同じタグを持てば一致する（完全一致・OR）
// - タグも英字の大文字小文字、全角半角（NFKC）は区別しない。空・空白とカンマだけの入力は条件なし
// - タグ欄の候補は、入力中の語（最後のカンマより後ろ）を各タグに差し替えた値。入力済みのタグは外す
import {
  EMPTY_FILTER,
  isFilterActive,
  matchesFilter,
  matchesTags,
  matchesTitle,
  tagSuggestions,
  tagTerms,
  titleWords,
} from '../../web/src/filter.js'
import type { Filter, FilterableTask } from '../../web/src/filter.js'

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

// --- 検索語の分割 ---
check('分割: 半角空白で区切る', JSON.stringify(titleWords('alpha beta')) === '["alpha","beta"]', JSON.stringify(titleWords('alpha beta')))
check('分割: 全角空白でも区切る', JSON.stringify(titleWords('同期　設定')) === '["同期","設定"]', JSON.stringify(titleWords('同期　設定')))
check('分割: 前後と連続の空白は捨てる', JSON.stringify(titleWords('  alpha   beta  ')) === '["alpha","beta"]')
check('分割: 空白だけなら語なし', titleWords(' 　 ').length === 0)

// --- タスク名の部分一致 ---
const title = 'Todoist同期の設定画面を作る'
check('一致: 空の入力は常に一致', matchesTitle(title, ''))
check('一致: 空白だけの入力は常に一致', matchesTitle(title, '  '))
check('一致: 部分一致', matchesTitle(title, '設定画面'))
check('一致: 含まない語は不一致', !matchesTitle(title, 'アーカイブ'))
check('一致: 複数語はすべて含めば一致', matchesTitle(title, '同期 画面'))
check('一致: 複数語の1つでも欠ければ不一致（AND）', !matchesTitle(title, '同期 アーカイブ'))
check('一致: 語の順序は問わない', matchesTitle(title, '画面 todoist'))
check('一致: 英字の大文字小文字を区別しない', matchesTitle(title, 'TODOIST') && matchesTitle('ALPHA release', 'alpha'))
check('一致: 全角英数は半角とみなす', matchesTitle(title, 'Ｔｏｄｏｉｓｔ') && matchesTitle('v2 対応', 'ｖ２'))
check('一致: 半角カナは全角とみなす', matchesTitle('カードの表示', 'ｶｰﾄﾞ'))
check('一致: タイトル側の全角も正規化する', matchesTitle('ＡＰＩの整理', 'api'))

// --- matchesFilter への組み込み ---
const task: FilterableTask = { title, project: 'alpha', priority: 'P2', tags: ['web'], due: null }
const f = (over: Partial<Filter>): Filter => ({ ...EMPTY_FILTER, ...over })
const now = new Date(2026, 10, 12)
check('組込: 空のフィルタは一致', matchesFilter(task, EMPTY_FILTER, now))
check('組込: タスク名だけで絞れる', matchesFilter(task, f({ title: '設定' }), now) && !matchesFilter(task, f({ title: '削除' }), now))
check('組込: タスク名とプロジェクトは AND（両方一致）', matchesFilter(task, f({ title: '設定', projects: ['alpha'] }), now))
check('組込: タスク名一致でもプロジェクト不一致なら不一致', !matchesFilter(task, f({ title: '設定', projects: ['beta'] }), now))
check('組込: プロジェクト一致でもタスク名不一致なら不一致', !matchesFilter(task, f({ title: '削除', projects: ['alpha'] }), now))
check('組込: タグ・優先度と組み合わせる', matchesFilter(task, f({ title: 'todoist', tags: 'web', priorities: ['P2'] }), now))

// --- タグの検索語の分割 ---
const j = (v: unknown) => JSON.stringify(v)
check('タグ分割: カンマで区切り前後の空白を除く', j(tagTerms('web, 調査')) === '["web","調査"]', j(tagTerms('web, 調査')))
check('タグ分割: 全角カンマでも区切る', j(tagTerms('web，調査')) === '["web","調査"]', j(tagTerms('web，調査')))
check('タグ分割: 空白は区切りにしない（タグ名の一部）', j(tagTerms('to do, web')) === '["to do","web"]', j(tagTerms('to do, web')))
check('タグ分割: 空の語（連続・末尾のカンマ）は捨てる', j(tagTerms(' ,web,, 調査, ')) === '["web","調査"]', j(tagTerms(' ,web,, 調査, ')))
check('タグ分割: 空白とカンマだけなら語なし', tagTerms(' , 　,').length === 0)

// --- タグの一致 ---
check('タグ: 空の入力は常に一致（タグなしのタスクも）', matchesTags(['web'], '') && matchesTags([], ''))
check('タグ: 同じタグを持てば一致', matchesTags(['web', 'waiting'], 'waiting'))
check('タグ: 部分一致はしない（完全一致）', !matchesTags(['調査中'], '調査') && !matchesTags(['web'], 'we'))
check('タグ: 複数はいずれかを持てば一致（OR）', matchesTags(['調査'], 'web, 調査') && matchesTags(['web'], 'web, 調査'))
check('タグ: どれも持たなければ不一致', !matchesTags(['waiting'], 'web, 調査'))
check('タグ: タグなしのタスクは条件ありなら不一致', !matchesTags([], 'web'))
check('タグ: 英字の大文字小文字を区別しない', matchesTags(['Web'], 'WEB') && matchesTags(['web'], 'Web'))
check('タグ: 全角英数は半角とみなす', matchesTags(['web'], 'ｗｅｂ') && matchesTags(['ｖ２'], 'v2'))
check('タグ: 空白を含むタグも一致', matchesTags(['to do'], 'web, to do'))

// --- タグ欄の候補（datalist） ---
const allTags = ['alpha', 'beta', 'web']
check('候補: 空の入力ならタグそのもの', j(tagSuggestions('', allTags)) === '["alpha","beta","web"]', j(tagSuggestions('', allTags)))
check('候補: 1語目の入力中もタグそのもの', j(tagSuggestions('al', allTags)) === '["alpha","beta","web"]')
check(
  '候補: カンマの後は入力済みの部分を残して差し替える',
  j(tagSuggestions('alpha, b', allTags)) === '["alpha, beta","alpha, web"]',
  j(tagSuggestions('alpha, b', allTags)),
)
check(
  '候補: カンマ直後で未入力なら空白を1つ補う',
  j(tagSuggestions('alpha,', allTags)) === '["alpha, beta","alpha, web"]',
  j(tagSuggestions('alpha,', allTags)),
)
check(
  '候補: 空白なしで打ち始めたら入力どおり（入力値を含む候補にする）',
  j(tagSuggestions('alpha,b', allTags)) === '["alpha,beta","alpha,web"]',
  j(tagSuggestions('alpha,b', allTags)),
)
// ブラウザは入力値を含む候補だけを出す。その絞り込みで、入力中の語で始まるタグの候補だけが残ることを見る
const shown = (q: string) => j(tagSuggestions(q, allTags).filter((v) => v.includes(q)))
const shownCases: [string, string[]][] = [
  ['al', ['alpha']],
  ['alpha,', ['alpha, beta', 'alpha, web']],
  ['alpha, ', ['alpha, beta', 'alpha, web']],
  ['alpha, b', ['alpha, beta']],
  ['alpha,b', ['alpha,beta']],
  ['alpha，w', ['alpha，web']],
  ['ALPHA, w', ['ALPHA, web']],
]
for (const [q, want] of shownCases) {
  check(`候補: 「${q}」と入力すると入力中の語で絞られる`, shown(q) === j(want), shown(q))
}
check('候補: 入力済みのタグは大文字小文字を問わず外す', j(tagSuggestions('ALPHA, beta, ', allTags)) === '["ALPHA, beta, web"]', j(tagSuggestions('ALPHA, beta, ', allTags)))
check('候補: 全角カンマの後も差し替える', j(tagSuggestions('alpha，w', allTags)) === '["alpha，beta","alpha，web"]', j(tagSuggestions('alpha，w', allTags)))

// --- タグの matchesFilter への組み込み ---
const tagged: FilterableTask = { title: '画面の調整', project: 'alpha', priority: null, tags: ['web', '調査中'], due: null }
check('組込タグ: 記述したタグで絞れる', matchesFilter(tagged, f({ tags: 'web' }), now) && !matchesFilter(tagged, f({ tags: '調査' }), now))
check('組込タグ: 複数タグは OR', matchesFilter(tagged, f({ tags: 'waiting, 調査中' }), now))
check('組込タグ: タグ一致でもプロジェクト不一致なら不一致（AND）', !matchesFilter(tagged, f({ tags: 'web', projects: ['beta'] }), now))
check('組込タグ: 空白とカンマだけは条件なし', matchesFilter(tagged, f({ tags: ' , ' }), now) && matchesFilter(task, f({ tags: ' , ' }), now))

// --- フィルタ使用中の判定（ヘッダーのアイコン強調） ---
check('使用中: 空のフィルタは未使用', !isFilterActive(EMPTY_FILTER))
check('使用中: タスク名を入れると使用中', isFilterActive(f({ title: '同期' })))
check('使用中: 空白だけのタスク名は未使用', !isFilterActive(f({ title: ' 　' })))
check('使用中: タグを入れると使用中', isFilterActive(f({ tags: 'web' })))
check('使用中: 空白とカンマだけのタグは未使用', !isFilterActive(f({ tags: ' , 　' })))
check('使用中: 他の項目は従来どおり', isFilterActive(f({ projects: ['alpha'] })) && isFilterActive(f({ due: 'today' })))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exit(1)
