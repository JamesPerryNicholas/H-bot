// Runs in a child Node process. Keep it self-contained so Electron can pass it
// with -e even when this module lives inside app.asar.
export async function runMcpStdio() {
  const { request } = await import('node:http')
  const { createInterface } = await import('node:readline')
  const endpoint = new URL(process.env.DS_BOT_MCP_URL)
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('MCP bridge requires a loopback URL')
  const token = process.env.DS_BOT_MCP_TOKEN
  delete process.env.DS_BOT_MCP_TOKEN
  const active = new Set()
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const req = request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    }, response => {
      if (response.statusCode !== 200 && response.statusCode !== 202) {
        response.resume()
        req.destroy(new Error(`MCP bridge HTTP ${response.statusCode}`))
        return
      }
      if (response.headers['content-type']?.includes('text/event-stream')) {
        const lines = createInterface({ input: response, crlfDelay: Infinity })
        let data = []
        lines.on('line', row => {
          if (row.startsWith('data:')) data.push(row.slice(5).trimStart())
          if (row === '' && data.length > 0) {
            try { send(JSON.parse(data.join('\n'))) } catch { req.destroy(new Error('Invalid MCP response')) }
            data = []
          }
        })
      } else {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          if (body === '') return
          try {
            const value = JSON.parse(body)
            for (const reply of Array.isArray(value) ? value : [value]) if (reply != null) send(reply)
          } catch { req.destroy(new Error('Invalid MCP response')) }
        })
      }
      response.on('error', error => req.destroy(error))
    })
    active.add(req)
    req.on('close', () => active.delete(req))
    req.on('error', error => {
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } })
    })
    req.end(JSON.stringify(message))
  })
  input.on('close', () => {
    for (const req of active) req.destroy()
  })
}

export function stdioServer(mcp, name) {
  return {
    name,
    command: process.execPath,
    args: ['-e', `(${runMcpStdio.toString()})().catch(() => { process.exitCode = 1 })`],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'DS_BOT_MCP_URL', value: mcp.url },
      { name: 'DS_BOT_MCP_TOKEN', value: mcp.token },
    ],
  }
}
