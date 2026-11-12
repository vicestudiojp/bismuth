// web の一覧フィルタの判定ロジック（web/src/filter.ts）の検証。タスク名の部分一致（bismuth-275）を中心に見る。
// vault には触れない（純粋関数だけを呼ぶ）。
// 実行: npx tsx scripts/verify-filter.ts
//
// 方針:
// - タスク名は空白（全角も含む）で区切った語をすべて含めば一致する（AND）
// - 英字の大文字小文字、全角半角（NFKC）は区別しない
// - 空・空白だけの入力は条件なし（全件一致・フィルタ未使用の扱い）
// - タスク名と他の項目（プロジェクト・優先度・タグ・期限）は AND
import { EMPTY_FILTER, isFilterActive, matchesFilter, matchesTitle, titleWords } from '../../web/src/filter.js'
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
check('組込: タグ・優先度と組み合わせる', matchesFilter(task, f({ title: 'todoist', tags: ['web'], priorities: ['P2'] }), now))

// --- フィルタ使用中の判定（ヘッダーのアイコン強調） ---
check('使用中: 空のフィルタは未使用', !isFilterActive(EMPTY_FILTER))
check('使用中: タスク名を入れると使用中', isFilterActive(f({ title: '同期' })))
check('使用中: 空白だけのタスク名は未使用', !isFilterActive(f({ title: ' 　' })))
check('使用中: 他の項目は従来どおり', isFilterActive(f({ projects: ['alpha'] })) && isFilterActive(f({ due: 'today' })))

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exit(1)
