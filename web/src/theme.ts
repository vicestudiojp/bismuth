// 画面テーマ（bismuth-174）。設定の正本はサーバのユーザー設定（theme）。
// <html data-theme> に dark / light を入れ、色は styles.css の変数が切り替える。
// system は OS の設定（prefers-color-scheme）に合わせ、OS 側の切り替えにも追従する。
export type Theme = 'dark' | 'light' | 'system'

export const THEME_LABELS: Record<Theme, string> = {
  dark: 'ダーク',
  light: 'ライト',
  system: 'OS に合わせる',
}

// 起動直後のちらつき防止用の控え。index.html の先頭スクリプトがこれを読んで、描画前に data-theme を入れる
const CACHE_KEY = 'bismuth-theme'

const media = window.matchMedia('(prefers-color-scheme: light)')
let current: Theme = 'dark'

function resolve(t: Theme): 'dark' | 'light' {
  if (t === 'system') return media.matches ? 'light' : 'dark'
  return t
}

function render() {
  document.documentElement.dataset.theme = resolve(current)
}

media.addEventListener('change', () => {
  if (current === 'system') render()
})

export function applyTheme(t: Theme) {
  current = t
  render()
  try {
    localStorage.setItem(CACHE_KEY, t)
  } catch {
    // localStorage が使えなくても表示は切り替わる（起動時のちらつきが出るだけ）
  }
}
