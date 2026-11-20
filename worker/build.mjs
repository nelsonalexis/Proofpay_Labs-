import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'

const entries = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'xrpl.js': 'text/javascript; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'demo.mjs': 'text/javascript; charset=utf-8',
  'ledger.mjs': 'text/javascript; charset=utf-8',
  'invoices.mjs': 'text/javascript; charset=utf-8',
  'policy.mjs': 'text/javascript; charset=utf-8',
  'decisions.mjs': 'text/javascript; charset=utf-8',
  'routing-agent.mjs': 'text/javascript; charset=utf-8',
  'routing-model.mjs': 'text/javascript; charset=utf-8',
  'routing-weights.mjs': 'text/javascript; charset=utf-8',
  'factures/invoice.json': 'application/json; charset=utf-8',
  'factures/work.json': 'application/json; charset=utf-8',
  'preuves/panne.json': 'application/json; charset=utf-8',
  'preuves/concurrence.json': 'application/json; charset=utf-8',
  'XRPL-LICENSE.txt': 'text/plain; charset=utf-8',
}
const assets = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, type]) =>
  ['/' + name, { type, body: await readFile('dist/' + name, 'utf8') }])))
await mkdir('dist/server', { recursive: true })
await cp('worker/router.mjs', 'dist/server/index.js')
await writeFile('dist/server/assets.mjs', 'export default Object.assign(Object.create(null), '
  + JSON.stringify(assets) + ')\n')
