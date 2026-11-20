import { liveRun, liveSession, observedOffer } from './ledger.mjs'
import { checkProposal, quote, TERMS } from './policy.mjs'
import { invoices } from './invoices.mjs'
import { digestDecision, runRoutingAgent, stopRoutingAgent } from './decisions.mjs'

const agentsByRoute = { normal: { title: 'Circuit normal' }, rescue: { title: 'Circuit de secours' } }
let onUpdate = () => {}
export const onProgress = callback => { onUpdate = callback }
export const currentState = () => state
export { initialize, execute }
let state
let session

function event(title, detail) {
  state.timeline.unshift({ title, detail, time: new Date().toISOString() })
}

function reset(mode) {
  state = { mode, agencyOnline: true, status: 'ready', result: null, winner: null,
    agentsHealth: { normal: { online: false }, rescue: { online: false } },
    outageAt: null, timeline: [], claims: {}, accounts: {}, identities: {}, decisions: {}, invoiceHashes: Object.fromEntries(
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
  for (const route of Object.keys(agentsByRoute)) stopRoutingAgent(route)
  if (session?.client) await session.client.disconnect().catch(() => {})
  session = null
  reset(mode)
  state.status = 'loading'
  try {
    session = mode === 'testnet' ? await liveSession(message => { state.progress = message; onUpdate() }) : mockSession()
    state.claims = session.scenario.tokens
    state.accounts = session.scenario.accounts
    state.issuance = session.scenario.issuance
    state.offers = session.scenario.offers
    state.signerRegistration = session.scenario.signerRegistration
    state.identities = Object.fromEntries(Object.keys(agentsByRoute).map(route =>
      [route, session.agents?.[route].address ?? 'simulation-' + route]))
    state.agentsHealth = {
      normal: { online: true }, rescue: { online: true },
    }
    state.status = 'ready'
    event('Deux droits au paiement prêts', mode === 'testnet'
      ? 'Deux NFT et six offres réservées ont été validés sur le testnet.'
      : 'Les droits au paiement sont représentés dans la simulation locale.')
  } catch (error) {
    state.agentsHealth = { normal: { online: false }, rescue: { online: false } }
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
  const observation = {
    route, agencyOnline: state.agencyOnline, settled: Boolean(state.winner), cancelled: state.cancelled,
    candidates: candidates.map(rows => ({
      amountErrors: rows.map((row, index) => Math.min(1,
        Math.abs(Number(row.drops) - Number(TERMS[route][index].drops)) / 1000000)),
      identityErrors: rows.map((row, index) => {
        const term = TERMS[route][index]
        return row.token !== scenario.tokens[term.claim]
          || row.owner !== scenario.accounts[term.payee] || row.destination !== scenario.accounts[term.payer]
      }),
    })),
  }
  const inference = await runRoutingAgent(observation)
  const selected = inference.index === null ? null : candidates[inference.index]
  const proposal = selected ? checkProposal(scenario, route, selected) : null
  const explanation = selected ? 'Le modèle propose ce lot. Le cosignataire doit encore vérifier les montants et les bénéficiaires.'
    : 'Aucun lot n’a atteint le seuil du modèle. L’agent attend.'
  const document = JSON.stringify({
    schema: 'proofpay-mobile-decision-v1', agent: state.identities[route], inference, observation,
    offers: selected?.map(row => ({ id: row.id, token: row.token, drops: row.drops,
      owner: row.owner, destination: row.destination })) ?? [],
  })
  const decision = { ...inference, choice: selected ? String(inference.index + 1) : 'wait',
    explanation, digest: await digestDecision(document), document }
  state.decisions[route] = { ...decision, approved: eligible && proposal?.ok === true }
  if (state.decisions[route].approved) {
    state.pending = { route, proposal, attestation: decision }
    event(agentsByRoute[route].title, decision.explanation)
  } else {
    event(agentsByRoute[route].title, decision.choice === 'wait'
      ? 'Aucun règlement proposé. ' + decision.explanation
      : 'Proposition rejetée par les règles du cosignataire. ' + decision.explanation)
  }
}

async function execute(action) {
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
    state.agencyOnline = !state.agencyOnline
    state.agentsHealth.normal.online = state.agencyOnline
    if (!state.agencyOnline) {
      state.outageAt = performance.now()
      stopRoutingAgent('normal')
    }
    event(state.agencyOnline ? 'Circuit principal rétabli' : 'Panne simulée du circuit principal',
      state.agencyOnline ? 'Le circuit normal est de nouveau disponible.' : 'Le circuit de secours reste disponible.')
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
  if (variant === 'approved' && !confirmed) return askAgent(route)
  state.pending = null
  const started = performance.now()
  const result = state.mode === 'testnet' ? await liveRun(session, route, variant, attestation) : simulate(route, variant)
  const finished = performance.now()
  state.result = { ...result, route, variant, attestation,
    ...(state.mode === 'testnet' && result.status === 'settled' ? {
      durationMs: Math.round(finished - started),
      ...(route === 'rescue' && state.outageAt !== null ? { recoveryMs: Math.round(finished - state.outageAt) } : {}),
    } : {}),
  }
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
