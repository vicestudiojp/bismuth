import os from 'node:os'

// 待ち受けアドレス（--host / 環境変数 BISMUTH_HOST）の扱い。
// 既定は 127.0.0.1（このマシンからだけ開ける）。0.0.0.0 や LAN 側のアドレスを指定すると、同じ LAN の他の端末からも開ける。
// 認証は無いので、LAN に開くのは信頼できるネットワークでだけにする

export const DEFAULT_HOST = '127.0.0.1'

export function resolveHost(raw = process.env.BISMUTH_HOST): string {
  return raw?.trim() || DEFAULT_HOST
}

// すべてのアドレスで待ち受ける指定
export function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::'
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

function urlOf(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

// このマシンで開く URL（起動時に表示し、ブラウザで開く先）。
// すべてのアドレスかループバックで待ち受けるなら localhost、特定のアドレスならそのアドレス
export function localUrl(host: string, port: number): string {
  return isWildcard(host) || isLoopback(host) ? urlOf('localhost', port) : urlOf(host, port)
}

// 他の端末から開く URL。ループバックだけで待ち受けるなら空。
// すべてのアドレスで待ち受けるなら、Bonjour 名（macOS の <名前>.local）と、このマシンの LAN 側の IPv4 アドレスを並べる
export function lanUrls(
  host: string,
  port: number,
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  hostname: string = os.hostname(),
): string[] {
  if (isLoopback(host)) return []
  if (!isWildcard(host)) return [urlOf(host, port)]
  const addrs = Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  const names = hostname.endsWith('.local') ? [hostname] : []
  return [...new Set([...names, ...addrs])].map((h) => urlOf(h, port))
}
