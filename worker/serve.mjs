import { createServer } from 'node:http'
import worker from '../dist/server/index.js'

const origin = 'http://127.0.0.1:4173'
createServer(async (req, res) => {
  try {
    const body = []
    for await (const part of req) body.push(part)
    const response = await worker.fetch(new Request(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(body) } : {}),
    }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Local ProofPay server error.')
  }
}).listen(4173, '127.0.0.1', () => console.log(origin))
