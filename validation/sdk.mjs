import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'

globalThis.self = globalThis
globalThis.location = new URL('https://localhost/xrpl.js')
globalThis.importScripts = () => { throw new Error('Chargement dynamique indisponible.') }
runInThisContext(readFileSync(new URL('../dist/xrpl.js', import.meta.url), 'utf8'))
if (!globalThis.xrpl) throw new Error('SDK XRPL indisponible.')
