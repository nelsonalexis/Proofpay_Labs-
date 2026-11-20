import { liveRun, liveSession, observedOffer } from './ledger.mjs'
import { checkProposal, quote, TERMS } from './policy.mjs'
import { invoices } from './invoices.mjs'
import { digestDecision, runRoutingAgent, stopRoutingAgent } from './decisions.mjs'

const agentsByRoute = { normal: { title: 'Normal route' }, rescue: { title: 'Backup route' } }
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
  event('Initial agreement', 'The restaurant, agency, and freelancer authorized both routes.')
}

function mockSession() {
  const accounts = { restaurant: 'demo-restaurant', agency: 'demo-agency', designer: 'demo-designer' }
  const tokens = { invoice: 'DEMO-INVOICE-100', work: 'DEMO-LOGO-80' }
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
    event('Two receivables ready', mode === 'testnet'
      ? 'Testnet validated two NFTs and six restricted offers.'
      : 'The local simulation represents both receivables.')
  } catch (error) {
    state.agentsHealth = { normal: { online: false }, rescue: { online: false } }
    state.status = 'error'
    state.progress = error.message
    event('Initialization stopped', error.message)
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
  if (state.pending) throw new Error('Close or confirm the current proposal.')
  state.progress = agentsByRoute[route].title + ' is reviewing the available offers…'
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
  const explanation = selected ? 'The model proposes this batch. The co-signer must still verify the amounts and recipients.'
    : 'No batch reached the model threshold. The agent is waiting.'
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
      ? 'No settlement proposed. ' + decision.explanation
      : 'The co-signer’s rules rejected the proposal. ' + decision.explanation)
  }
}

async function execute(action) {
  if (state.status !== 'ready') throw new Error('Start a scenario before continuing.')
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
    event(state.agencyOnline ? 'Normal route restored' : 'Simulated normal route outage',
      state.agencyOnline ? 'The normal route is available again.' : 'The backup route is still available.')
    return
  }
  const confirmed = action === 'confirm'
  const attestation = confirmed ? state.pending?.attestation : undefined
  if (confirmed) action = state.pending?.route
  if (!actions.has(action)) throw new Error('Unknown action.')
  if (action === 'replay' ? !state.winner : state.winner) throw new Error('This action is unavailable for the current settlement.')
  const route = action === 'replay' ? (state.winner === 'normal' ? 'rescue' : 'normal')
    : action === 'normal' ? 'normal' : 'rescue'
  if (route === 'normal' && !state.agencyOnline) throw new Error('Bring the agency back online first.')
  if (route === 'rescue' && state.agencyOnline) throw new Error('Simulate the agency outage first.')
  if (route === 'rescue' && state.cancelled && action !== 'wrong') throw new Error('The 20 XRP offer was cancelled.')
  const variant = ['normal', 'rescue'].includes(action) ? 'approved' : action
  state.progress = action === 'wrong' ? 'Checking offer amounts…' : 'Verifying and settling the batch…'
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
    event('Both payouts settled together', 'The restaurant pays 100 XRP. The freelancer receives 80 XRP and the agency keeps 20 XRP.')
  } else if (result.status === 'refused') {
    event('Co-signature rejected', 'The offer proposed 85 + 15 XRP. The total is correct, but the split must be 80 + 20 XRP.')
  } else {
    event('No payout', action === 'replay'
      ? 'The other route cannot settle these receivables again using the original offers.'
      : 'The 20 XRP offer was cancelled before submission. The entire batch was rejected.')
  }
  state.progress = ''
}
