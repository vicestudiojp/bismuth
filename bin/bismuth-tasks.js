#!/usr/bin/env node
// Bismuth の起動コマンド（npx bismuth-tasks）。
//   bismuth-tasks [--port <番号>] [--vault <パス>] [--no-open]   サーバを起動してブラウザで開く
//   bismuth-tasks cli [CLI の引数...]                             vault を直接読み書きする CLI
// 実体はビルド済みの dist/server。初回起動時（vault の場所が未設定）は端末で場所を尋ねて保存する。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(root, 'dist', 'server')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

const HELP = `Bismuth ${version} — Obsidian の vault をデータベースとして使うタスク管理

使い方:
  bismuth-tasks [オプション]       サーバを起動してブラウザで開く
  bismuth-tasks cli [引数...]      CLI（一覧・起票・完了・コメント）。詳しくは bismuth-tasks cli --help

オプション:
  --port <番号>    待ち受けるポート（既定 8383）
  --vault <パス>   今回だけ使う vault の場所（設定は書き換えない）
  --no-open        ブラウザを開かない
  -v, --version    バージョンを表示
  -h, --help       このヘルプを表示

vault の場所は ~/.config/bismuth/config.json の root に保存されます（初回起動時に尋ねます）。`

function fail(message) {
  console.error(message)
  process.exit(1)
}

function expandHome(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

async function importServer(file) {
  const target = path.join(serverDir, file)
  if (!fs.existsSync(target)) fail(`ビルド済みのファイルが見つかりません: ${target}\n（リポジトリから動かす場合は先に npm run build を実行してください）`)
  return import(pathToFileURL(target).href)
}

// 初回起動: vault の場所を尋ねてユーザー設定に保存する。端末でない（パイプ等）ときは尋ねられないので、
// 既定の場所を黙って作らずに止める
async function setupVault(settings) {
  const fallback = settings.DEFAULTS.root
  if (!process.stdin.isTTY) {
    fail('vault の場所が未設定です。--vault <パス> か環境変数 BISMUTH_VAULT で指定するか、端末から起動して設定してください')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log('Bismuth へようこそ。タスクノートを置く vault（フォルダ）の場所を指定してください。')
    const answer = (await rl.question(`vault の場所 [${fallback}]: `)).trim()
    const dir = path.resolve(expandHome(answer || fallback))
    if (!fs.existsSync(dir)) {
      const yes = (await rl.question(`${dir} はありません。作成しますか？ [Y/n]: `)).trim().toLowerCase()
      if (yes !== '' && yes !== 'y' && yes !== 'yes') fail('中止しました。もう一度起動して場所を指定してください')
      fs.mkdirSync(dir, { recursive: true })
    } else if (!fs.statSync(dir).isDirectory()) {
      fail(`${dir} はフォルダではありません`)
    }
    settings.saveSettings({ root: dir })
    console.log(`保存しました: ${settings.userConfigFile()}\n`)
  } finally {
    rl.close()
  }
}

function parseServerArgs(args) {
  const opts = { port: null, vault: null, open: true }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-h' || a === '--help') {
      console.log(HELP)
      process.exit(0)
    } else if (a === '-v' || a === '--version') {
      console.log(version)
      process.exit(0)
    } else if (a === '--no-open') {
      opts.open = false
    } else if (a === '--port' || a === '--vault') {
      const v = args[++i]
      if (!v) fail(`${a} には値が必要です`)
      opts[a.slice(2)] = v
    } else {
      fail(`不明な引数です: ${a}\n\n${HELP}`)
    }
  }
  if (opts.port != null && !/^\d+$/.test(opts.port)) fail(`--port は数字で指定してください: ${opts.port}`)
  return opts
}

const [command, ...rest] = process.argv.slice(2)

if (command === 'cli') {
  // CLI は process.argv.slice(2) を読むので、cli の後ろだけを渡す
  process.argv = [process.argv[0], path.join(serverDir, 'cli.js'), ...rest]
  await importServer('cli.js')
} else {
  const opts = parseServerArgs(process.argv.slice(2))
  if (opts.vault) process.env.BISMUTH_VAULT = path.resolve(expandHome(opts.vault))
  if (opts.port) process.env.BISMUTH_PORT = opts.port
  if (opts.open && !process.env.BISMUTH_OPEN) process.env.BISMUTH_OPEN = '1'
  const settings = await importServer('settings.js')
  if (!settings.hasConfiguredRoot()) await setupVault(settings)
  await importServer('index.js')
}
