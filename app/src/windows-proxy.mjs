import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)

// DSH already routes fetch and bypasses loopback. Supply only a manually configured
// Windows proxy when the user's DSH launch environment has no explicit route.
export async function applyWindowsProxy(environment) {
  if (['https_proxy', 'http_proxy', 'all_proxy'].some(key =>
    [key, key.toUpperCase()].some(name => environment.get(name)?.value?.trim()))) return false
  const script = "$p=Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings'; if ($p.ProxyEnable -and !$p.AutoConfigURL) { $p | Select-Object ProxyServer,ProxyOverride | ConvertTo-Json -Compress }"
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let settings
  try {
    const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 })
    if (!stdout.trim()) return false
    settings = JSON.parse(stdout)
  } catch {
    return false
  }
  const server = settings.ProxyServer?.trim()
  if (!server) return false
  const assignments = new Map(server.split(';').map(item => item.trim().split('=')))
  const routes = {}
  for (const scheme of ['http', 'https']) {
    const address = server.includes('=') ? assignments.get(scheme) : server
    if (!address) continue
    const url = URL.parse(address.includes('://') ? address : 'http://' + address)
    if (url && ['http:', 'https:'].includes(url.protocol)) routes[scheme.toUpperCase() + '_PROXY'] = url.origin
  }
  if (!Object.keys(routes).length) return false
  const bypass = [environment.get('no_proxy')?.value ?? environment.get('NO_PROXY')?.value,
    ...(settings.ProxyOverride ?? '').split(';').filter(item => item && item !== '<local>')]
  Object.assign(process.env, routes)
  if (bypass.some(Boolean)) process.env.NO_PROXY = bypass.filter(Boolean).join(',')
  return true
}
