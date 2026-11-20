import { executionStatus, processes } from './agent-processes.mjs'
import { agentsByRoute, makeAttestation, modelAvailable } from './agents.mjs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { liveProposal, liveRun, liveSession, observedOffer } from './ledger.mjs'
import { checkProposal, quote, TERMS } from './policy.mjs'
import { invoices } from './invoices.mjs'

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
}
let state
let session
let busy = false

function event(title, detail) {
  state.timeline.unshift({ title, detail, time: new Date().toISOString() })
}

function reset(mode) {
  state = { mode, agencyOnline: true, status: 'ready', result: null, winner: null,
    timeline: [], claims: {}, accounts: {}, identities: {}, decisions: {}, invoiceHashes: Object.fromEntries(
      Object.entries(invoices).map(([key, item]) => [key, item.digest])), cancelled: false, progress: '' }
  event('Accord initial', 'Le restaurant, l’agence et le graphiste ont autorisé les deux circuits.')
}

function mockSession() {
  const accounts = { restaurant: 'demo-restaurant', agency: 'demo-agency', designer: 'demo-designer' }
  const tokens = { invoice: 'DEMO-FACTURE-100', work: 'DEMO-LOGO-80' }
  const offers = Object.fromEntries(Object.entries({ ...TERMS, ...quote }).map(([plan, rows]) =>
    [plan, rows.map((row, index) => ({ ...row, id: `demo-${plan}-${index}`,
      token: tokens[row.claim], owner: accounts[row.payee], destination: accounts[row.payer] }))]))
  return { scenario: { accounts, tokens, offers, cancelled: false } }
}

async function initialize(mode) {
  if (session?.client) await session.client.disconnect().catch(() => {})
  session = null
  reset(mode)
  state.status = 'loading'
  try {
    await Promise.all(Object.values(processes).map(process => process.start()))
    session = mode === 'testnet' ? await liveSession(message => state.progress = message) : mockSession()
    state.claims = session.scenario.tokens
    state.accounts = session.scenario.accounts
    state.signerRegistration = session.scenario.signerRegistration
    state.identities = Object.fromEntries(Object.keys(agentsByRoute).map(route =>
      [route, session.agents?.[route].address ?? 'simulation-' + route]))
    state.status = 'ready'
    event('Deux droits au paiement prêts', mode === 'testnet'
      ? 'Deux NFT et six offres réservées ont été validés sur le testnet.'
      : 'Les droits au paiement sont représentés dans la simulation locale.')
  } catch (error) {
    state.status = 'error'
    state.progress = error.message
    event('Initialisation interrompue', error.message)
  }
}

function simulate(route, variant) {
  const { scenario } = session
  const proposal = checkProposal(scenario, route, scenario.offers[variant === 'wrong' ? 'wrong' : route])
  if (!proposal.ok) return { status: 'refused', proposal }
  const applied = !['rollback', 'replay'].includes(variant)
  if (variant === 'rollback') scenario.cancelled = true
  return { proposal, status: applied ? 'settled' : 'reverted',
    deltas: applied ? { restaurant: '-100000000', agency: '20000000', designer: '80000000' }
      : { restaurant: '0', agency: '0', designer: '0' } }
}

const actions = new Set(['normal', 'rescue', 'wrong', 'rollback', 'replay'])
async function askAgent(route) {
  if (state.pending) throw new Error('Ferme ou confirme la proposition en cours.')
  state.progress = agentsByRoute[route].title + ' consulte les offres et analyse la situation…'
  const scenario = session.scenario
  const eligible = !state.winner && (route === 'normal' ? state.agencyOnline : !state.agencyOnline && !state.cancelled)
  const planned = !eligible ? [] : route === 'rescue'
    ? [scenario.offers.wrong, scenario.offers.rescue] : [scenario.offers.normal]
  const candidates = await Promise.all(planned.map(rows => state.mode === 'testnet'
    ? Promise.all(rows.map(row => observedOffer(session.client, row))) : rows))
  const values = rows => rows.map(({ payee, payer, drops }) => ({ payer, payee, drops }))
  const observation = {
    agencyOnline: state.agencyOnline,
    circuitAuthorized: eligible,
    agreement: values(TERMS[route]),
    plans: Object.fromEntries(candidates.map((rows, index) => {
      const review = checkProposal(scenario, route, rows)
      return [index === 0 ? 'A' : 'B', { versements: values(rows), conforme: review.ok, ecarts: review.issues }]
    })),
  }
  const decision = await processes[route].infer(observation)
  const chosen = { A: candidates[0], B: candidates[1] }[decision.choice]
  const proposal = chosen ? checkProposal(scenario, route, chosen) : null
  const receipt = makeAttestation({ route, address: state.identities[route], observation, decision, proposal })
  state.decisions[route] = { ...receipt, approved: eligible && proposal?.ok === true }
  if (state.decisions[route].approved) {
    state.pending = { route, proposal, attestation: receipt }
    event(agentsByRoute[route].title, decision.explanation)
  } else {
    event(agentsByRoute[route].title, decision.choice === 'wait'
      ? 'Aucun règlement proposé. ' + decision.explanation
      : 'Proposition rejetée par les règles du cosignataire. ' + decision.explanation)
  }
}

async function execute(action) {
  state.agencyOnline = processes.normal.health.online
  if (state.status !== 'ready') throw new Error('Initialise un scénario avant de continuer.')
  if (action === 'ask-normal' || action === 'ask-rescue') {
    return askAgent(action === 'ask-normal' ? 'normal' : 'rescue')
  }
  if (action === 'discard') {
    state.pending = null
    return
  }
  if (action === 'toggle') {
    state.pending = null
    const previous = processes.normal.health
    if (previous.online) await processes.normal.stop()
    else await processes.normal.start()
    const current = processes.normal.health
    state.agencyOnline = current.online
    event(current.online ? 'Agent principal redémarré' : 'Agent principal arrêté',
      current.online ? 'Le circuit normal est de nouveau disponible. Processus ' + current.pid + '.'
        : 'Processus ' + previous.pid + ' arrêté. L’agent de secours reste disponible.')
    return
  }
  const confirmed = action === 'confirm'
  const attestation = confirmed ? state.pending?.attestation : undefined
  if (confirmed) action = state.pending?.route
  if (!actions.has(action)) throw new Error('Action inconnue.')
  if (action === 'replay' ? !state.winner : state.winner) throw new Error('Action incompatible avec ce règlement.')
  const route = action === 'replay' ? (state.winner === 'normal' ? 'rescue' : 'normal')
    : action === 'normal' ? 'normal' : 'rescue'
  if (route === 'normal' && !state.agencyOnline) throw new Error('L’agence doit être de nouveau en ligne.')
  if (route === 'rescue' && state.agencyOnline) throw new Error('Simule d’abord la panne de l’agence.')
  if (route === 'rescue' && state.cancelled && action !== 'wrong') throw new Error('L’offre à 20 XRP a été annulée.')
  const variant = ['normal', 'rescue'].includes(action) ? 'approved' : action
  state.progress = action === 'wrong' ? 'Analyse des montants de l’offre…' : 'Vérification et règlement du lot…'
  if (variant === 'approved' && !confirmed) {
    const proposal = state.mode === 'testnet' ? await liveProposal(session, route, variant)
      : checkProposal(session.scenario, route, session.scenario.offers[route])
    if (!proposal.ok) throw new Error('Proposition non conforme.')
    state.pending = { route, proposal }
    return
  }
  state.pending = null
  if (attestation && !processes[route].health.online) throw new Error('L’agent à l’origine de la décision est arrêté.')
  const result = state.mode === 'testnet' ? await liveRun(session, route, variant, attestation) : simulate(route, variant)
  state.result = { ...result, route, variant, attestation }
  state.cancelled = session.scenario.cancelled
  if (result.status === 'settled') {
    state.winner = route
    state.settlement = state.result
    event('Deux versements effectués ensemble', 'Le restaurant paie 100 XRP. Le graphiste gagne 80 XRP et l’agence conserve 20 XRP.')
  } else if (result.status === 'refused') {
    event('Cosignature refusée', '85 + 15 XRP proposés. Le total est correct, mais la répartition doit être 80 + 20 XRP.')
  } else {
    event('Aucun versement effectué', action === 'replay'
      ? 'L’autre circuit ne peut plus racheter les droits au paiement déjà réglés.'
      : 'L’offre à 20 XRP a été annulée avant soumission. Le lot entier est rejeté.')
  }
  state.progress = ''
}

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON requis.')
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 2048) throw new Error('Requête trop volumineuse.')
  }
  return JSON.parse(body)
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

await initialize('simulation')
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/state') return json(res, 200, { ...state, agencyOnline: processes.normal.health.online, agentsHealth: executionStatus(), busy, modelReady: await modelAvailable() })
    const receiptMatch = /^\/decisions\/([a-f0-9]{64})\.json$/.exec(req.url)
    if (req.method === 'GET' && receiptMatch) {
      const receipt = [...Object.values(state.decisions), state.settlement?.attestation]
        .find(item => item?.digest === receiptMatch[1])
      if (!receipt) return json(res, 404, { error: 'Décision introuvable.' })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="proofpay-agent-decision.json"' })
      return res.end(receipt.document)
    }
    if (req.method === 'GET' && req.url === '/preuve.json') {
      if (state.mode !== 'testnet' || !state.settlement?.batch) {
        return json(res, 404, { error: 'Aucun règlement confirmé sur le testnet.' })
      }
      const proof = {
        schema: 'proofpay/demo-evidence-v1',
        network: 'XRPL Testnet',
        signerRegistration: state.signerRegistration,
        agents: state.identities,
        claims: state.claims,
        invoiceHashes: state.invoiceHashes,
        settlement: state.settlement,
        retry: state.result?.variant === 'replay' ? state.result : undefined,
        serviceEvents: state.timeline.filter(item => [
          'Agent principal arrêté', 'Agent principal redémarré',
        ].includes(item.title)).reverse(),
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="proofpay-preuve.json"', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(proof, null, 2) + '\n')
    }
    const invoiceMatch = /^\/factures\/(invoice|work)\.json$/.exec(req.url)
    if (req.method === 'GET' && invoiceMatch) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + invoiceMatch[1] + '.json"' })
      return res.end(invoices[invoiceMatch[1]].document)
    }
    if (req.method === 'GET' && files[req.url]) {
      const [file, type] = files[req.url]
      const body = await readFile(new URL(`./public/${file}`, import.meta.url))
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' })
      return res.end(body)
    }
    if (req.method === 'POST' && req.url === '/api/action') {
      const { action, mode } = await jsonBody(req)
      if (busy) return json(res, 409, { error: 'Un traitement est déjà en cours.' })
      busy = true
      try {
        if (action === 'reset') {
          if (!['simulation', 'testnet'].includes(mode)) throw new Error('Mode inconnu.')
          await initialize(mode)
        } else await execute(action)
        return json(res, 200, { ...state, agencyOnline: processes.normal.health.online, agentsHealth: executionStatus(), busy: false, modelReady: await modelAvailable() })
      } finally {
        busy = false
        if (state.status === 'ready') state.progress = ''
      }
    }
    return json(res, 404, { error: 'Page introuvable.' })
  } catch (error) {
    return json(res, 400, { error: error.message })
  }
})

const port = Number(process.env.PORT || 4173)
server.listen(port, '127.0.0.1', () => console.log(`ProofPay · http://127.0.0.1:${server.address().port}`))
