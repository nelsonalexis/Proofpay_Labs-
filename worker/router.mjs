import assets from './assets.mjs'

const rpcEndpoints = ['https://testnet.xrpl-labs.com/', 'https://s.altnet.rippletest.net:51234/']
const faucet = 'https://faucet.altnet.rippletest.net/accounts'
const methods = new Set(['server_info', 'server_state', 'feature', 'account_info',
  'ledger', 'account_nfts', 'ledger_entry', 'fee', 'submit', 'tx'])
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

const error = (message, status) => Response.json({ message }, { status, headers })

async function forward(url, payload, name) {
  let upstream
  try {
    upstream = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8500),
    })
  } catch (failure) {
    console.error('ProofPay Testnet upstream', new URL(url).hostname, failure.name, failure.message)
    return error(name + ' ne répond pas. Réessaie dans quelques instants.', 502)
  }
  if (upstream.status === 429) return error(name + ' limite temporairement les demandes. Réessaie dans quelques instants.', 429)
  if (!upstream.ok) {
    console.error('ProofPay Testnet upstream HTTP', new URL(url).hostname, upstream.status)
    return error(name + ' est temporairement indisponible.', 502)
  }
  try {
    const result = await upstream.json()
    if (url === faucet) {
      if (result.error) return error('Le robinet XRPL a refusé le financement de test.', 502)
      return Response.json({ funded: true }, { headers })
    }
    return Response.json(result, { headers })
  } catch {
    return error(name + ' a renvoyé une réponse illisible.', 502)
  }
}

async function api(request, path) {
  if (request.method !== 'POST') return error('Méthode non autorisée.', 405)
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) {
    return error('Origine non autorisée.', 403)
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return error('Une requête JSON est attendue.', 415)
  }
  let payload
  try {
    const input = await request.text()
    if (input.length > 20000) return error('Requête trop volumineuse.', 413)
    payload = JSON.parse(input)
  } catch {
    return error('Requête JSON invalide.', 400)
  }

  if (path === '/api/testnet/faucet') {
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(payload?.destination ?? '')) {
      return error('Adresse XRP de test invalide.', 400)
    }
    return forward(faucet, { destination: payload.destination }, 'Le robinet XRPL')
  }

  const { command, account, ledger_index, index, transaction, tx_blob, fail_hard } = payload ?? {}
  if (!methods.has(command)) return error('Commande Testnet non prise en charge.', 400)
  if (command === 'submit' && !/^(?:[0-9a-f]{2}){1,8192}$/i.test(tx_blob ?? '')) {
    return error('Un lot signé est attendu.', 400)
  }
  const requestBody = { method: command, params: [{
    api_version: 2, account, ledger_index, index, transaction, tx_blob,
    ...(command === 'submit' ? { fail_hard: fail_hard === true } : {}),
  }] }
  for (const endpoint of rpcEndpoints) {
    const response = await forward(endpoint, requestBody, 'Le registre Testnet')
    if (response.ok) return response
  }
  return error('Les serveurs XRPL Testnet sont momentanément injoignables.', 502)
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/api/testnet/rpc' || path === '/api/testnet/faucet') return api(request, path)
    const asset = assets[path === '/' ? '/index.html' : path]
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response('Page introuvable', { status: 404 })
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
    })
  },
}
