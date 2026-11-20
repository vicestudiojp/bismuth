// 待ち受けアドレス（--host / BISMUTH_HOST）の実地検証。
// 本番 vault・ユーザー設定には触れず、一時ディレクトリのミニ vault に向けてサーバを実際に起動して検証する。
// 実行: npx tsx scripts/verify-host.ts
//
// 方針（2026-11-20 オーナー指示）:
// - 1台のマシンで起動し、同じ LAN の他の端末からブラウザで開けるようにする。認証は付けない（信頼できる LAN が前提）
// - 既定は従来どおり 127.0.0.1（このマシンだけ）。LAN に開くのは --host 0.0.0.0 を明示したときだけ
// - LAN に開いたときは、他の端末から開く URL と、認証が無いことを起動時に表示する
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopback, isWildcard, lanUrls, localUrl, resolveHost } from '../src/network.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..')
const serverEntry = path.join(here, '..', 'src', 'index.ts')
const binEntry = path.join(repo, 'bin', 'bismuth-tasks.js')

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bismuth-verify-'))
const conf = path.join(vault, 'user-config.json')

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

// 1) アドレスの解決と URL の組み立て
check('resolveHost: 未指定なら 127.0.0.1', resolveHost(undefined) === '127.0.0.1')
check('resolveHost: 空白だけなら 127.0.0.1', resolveHost('  ') === '127.0.0.1')
check('resolveHost: 前後の空白は除く', resolveHost(' 0.0.0.0 ') === '0.0.0.0')
check('isWildcard: 0.0.0.0 と ::', isWildcard('0.0.0.0') && isWildcard('::') && !isWildcard('192.168.0.10'))
check(
  'isLoopback: 127.x・::1・localhost',
  isLoopback('127.0.0.1') && isLoopback('127.0.1.1') && isLoopback('::1') && isLoopback('localhost') && !isLoopback('0.0.0.0'),
)
check('localUrl: 既定は localhost', localUrl('127.0.0.1', 8383) === 'http://localhost:8383')
check('localUrl: 0.0.0.0 でも localhost', localUrl('0.0.0.0', 8383) === 'http://localhost:8383')
check('localUrl: 特定のアドレスならそのアドレス', localUrl('192.168.0.10', 8383) === 'http://192.168.0.10:8383')
check('localUrl: IPv6 は [] で囲む', localUrl('fd00::10', 8383) === 'http://[fd00::10]:8383')

const fakeIfaces = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
  en0: [
    { address: '192.168.0.10', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 4 },
  ],
  en1: [{ address: '192.168.0.11', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
} as NodeJS.Dict<os.NetworkInterfaceInfo[]>
check('lanUrls: ループバックだけなら空', lanUrls('127.0.0.1', 8383, fakeIfaces, 'alpha.local').length === 0)
const wild = lanUrls('0.0.0.0', 8383, fakeIfaces, 'alpha.local')
check(
  'lanUrls: 0.0.0.0 なら .local 名と LAN 側の IPv4 を並べる（ループバック・IPv6 は除く）',
  JSON.stringify(wild) ===
    JSON.stringify(['http://alpha.local:8383', 'http://192.168.0.10:8383', 'http://192.168.0.11:8383']),
  JSON.stringify(wild),
)
check(
  'lanUrls: .local でないホスト名は出さない',
  !lanUrls('0.0.0.0', 8383, fakeIfaces, 'alpha').some((u) => u.includes('alpha')),
)
check(
  'lanUrls: 特定のアドレスならそのアドレスだけ',
  JSON.stringify(lanUrls('192.168.0.10', 8383, fakeIfaces, 'alpha.local')) === JSON.stringify(['http://192.168.0.10:8383']),
)

// 2) 起動コマンドの引数
function runBin(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [binEntry, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}
check('bin: --help に --host を載せる', runBin(['--help']).out.includes('--host <アドレス>'))
const noValue = runBin(['--host'])
check('bin: --host に値が無ければ止める', noValue.code === 1 && noValue.out.includes('--host には値が必要です'), noValue.out.trim())

// 3) サーバを実際に起動して、どのアドレスから届くかを確かめる
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

interface Running {
  out: string
  code: number | null // 起動に失敗して終了したときの終了コード（起動できたら null）
  stop: () => Promise<void>
}

// 起動ログの最後の行（projects:）が出るか、プロセスが終わるまで待つ
async function startServer(port: number, host?: string): Promise<Running> {
  const env: NodeJS.ProcessEnv = { ...process.env, BISMUTH_VAULT: vault, BISMUTH_CONFIG: conf, BISMUTH_PORT: String(port) }
  delete env.BISMUTH_HOST
  delete env.BISMUTH_OPEN
  delete env.BISMUTH_LOG
  if (host !== undefined) env.BISMUTH_HOST = host
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  const exited = new Promise<number>((resolve) => child.once('exit', (c) => resolve(c ?? 1)))
  const ready = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('projects:')) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
    void exited.then(() => clearInterval(timer))
  })
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20000))
  const result = await Promise.race([ready.then(() => 'ready' as const), exited, timeout])
  return {
    get out() {
      return out
    },
    code: typeof result === 'number' ? result : null,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await exited
      }
    },
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok && ((await res.json()) as { app?: string }).app === 'bismuth'
  } catch {
    return false
  }
}

const lanIp = Object.values(os.networkInterfaces())
  .flatMap((l) => l ?? [])
  .find((i) => i.family === 'IPv4' && !i.internal)?.address

// 3-1) 既定（127.0.0.1）: このマシンからだけ届く
{
  const port = await freePort()
  const s = await startServer(port)
  check('既定: 起動できる', s.code === null, s.out.trim())
  check('既定: 127.0.0.1 から届く', await reachable(`http://127.0.0.1:${port}`))
  check('既定: LAN の案内は出さない', !s.out.includes('LAN:'), s.out.trim())
  if (lanIp) check(`既定: LAN 側のアドレス（${lanIp}）からは届かない`, !(await reachable(`http://${lanIp}:${port}`)))
  else console.log('SKIP: LAN 側の IPv4 アドレスが無いので、LAN からの到達は確かめない')
  await s.stop()
}

// 3-2) 0.0.0.0: LAN 側のアドレスからも届き、URL と認証なしの注意を出す
{
  const port = await freePort()
  const s = await startServer(port, '0.0.0.0')
  check('0.0.0.0: 起動できる', s.code === null, s.out.trim())
  check('0.0.0.0: 127.0.0.1 から届く', await reachable(`http://127.0.0.1:${port}`))
  check('0.0.0.0: 表示する URL は localhost', s.out.includes(`: http://localhost:${port}`), s.out.trim())
  check('0.0.0.0: 認証が無いことを知らせる', s.out.includes('認証はありません'), s.out.trim())
  if (lanIp) {
    check(`0.0.0.0: LAN 側のアドレス（${lanIp}）から届く`, await reachable(`http://${lanIp}:${port}`))
    check('0.0.0.0: LAN 側の URL を表示する', s.out.includes(`http://${lanIp}:${port}`), s.out.trim())
  }
  await s.stop()
}

// 3-3) このマシンに無いアドレス（文書用の 192.0.2.0/24）: 分かる言葉で止める
{
  const port = await freePort()
  const s = await startServer(port, '192.0.2.1')
  check(
    '無いアドレス: 終了コード 1 で止まる',
    s.code === 1 && s.out.includes('アドレス 192.0.2.1 では待ち受けられません'),
    `code=${s.code} ${s.out.trim()}`,
  )
  await s.stop()
}

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`)
if (fail === 0) {
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('（ミニ vault は削除済み）')
} else {
  console.log(`FAIL あり。ミニ vault を残しています: ${vault}`)
  process.exit(1)
}
