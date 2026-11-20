import { initialize, execute, currentState, onProgress } from './demo.mjs'

const byId = id => document.getElementById(id)
const mode = byId('mode')
const roles = { restaurant: 'Restaurant', agency: 'Agence', designer: 'Graphiste' }
const explorer = 'https://testnet.xrpl.org/transactions/'
let state
let waiting = false
let error = ''

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function xrp(drops) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 }).format(Number(drops) / 1e6)
}

function label(route) {
  return route === 'normal' ? 'Agent Agence' : 'Agent Restaurant'
}

function link(hash, text) {
  const anchor = node('a', text, 'ledger-link')
  anchor.href = explorer + encodeURIComponent(hash)
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  return anchor
}

function receiptLink(attestation) {
  const button = node('button', 'Télécharger la décision IA', 'secondary')
  button.addEventListener('click', () => downloadJson(attestation.document, 'decision-' + attestation.digest.slice(0, 8) + '.json'))
  return button
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
  const download = node('a')
  download.href = url
  download.download = filename
  download.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function renderAgents() {
  byId('signer-proof').replaceChildren(...(state.signerRegistration
    ? [link(state.signerRegistration, 'Voir l’enregistrement des signataires sur XRPL')] : []))
  byId('ai-status').textContent = 'MODÈLE DE ROUTAGE'
  for (const route of ['normal', 'rescue']) {
    const health = state.agentsHealth[route]
    byId('health-' + route).textContent = health.online ? 'Disponible' : 'Panne simulée'
    byId('identity-' + route).textContent = state.identities[route] || ''
    const panel = byId('decision-' + route)
    const item = state.decisions[route]
    if (!item) {
      panel.replaceChildren()
      continue
    }
    const title = item.approved ? 'Règlement proposé' : item.choice === 'wait' ? 'En attente' : 'Proposition rejetée'
    const scores = item.scores.map((score, index) => 'Offre ' + (index + 1) + ' : ' + Math.round(score * 100) + ' %')
    panel.replaceChildren(node('strong', title), node('p', item.explanation),
      node('p', scores.length ? scores.join(' · ') + ' · Seuil : ' + Math.round(item.threshold * 100) + ' %' : 'Aucune offre disponible'),
      receiptLink(item))

  }
}

function renderReport() {
  const panel = byId('report')
  panel.replaceChildren()
  const result = state.result
  const preview = state.pending
  const active = preview ?? result
  const heading = preview ? 'Vérifier avant de signer' : ({
    refused: 'Cosignature refusée', reverted: 'Lot sans versement', settled: 'Règlement confirmé',
  })[result?.status] || 'Aucune proposition'
  panel.append(node('h3', heading))
  if (!active) {
    panel.append(node('p', 'Choisis un circuit pour voir la proposition de son agent, les montants et les bénéficiaires.'))
    return
  }
  panel.append(node('p', label(active.route) + ' · ' + (active.route === 'normal' ? 'Circuit normal' : 'Circuit de secours'), 'muted'))
  const list = node('ul', undefined, 'review-list')
  for (const item of active.proposal.transfers) {
    const li = node('li')
    const values = node('div')
    values.append(node('strong', roles[item.payee]), node('small', 'Payé par ' + roles[item.payer] + ' · ' + item.id.slice(0, 9) + '…'))
    li.append(values, node('strong', xrp(item.drops) + ' XRP', item.ok ? 'ok' : 'error'))
    if (!item.ok) values.append(node('small', xrp(item.expected) + ' XRP convenus', 'error'))
    list.append(li)
  }
  panel.append(list)
  if (active.attestation) {
    panel.append(node('small', (result?.batch && !preview ? 'Empreinte inscrite sur XRPL · ' : 'Empreinte de la décision · ')
      + active.attestation.digest), receiptLink(active.attestation))
  }
  if (preview) {
    const confirm = node('button', 'Cosigner et régler', 'primary')
    confirm.dataset.action = 'confirm'
    const discard = node('button', 'Fermer', 'secondary')
    discard.dataset.action = 'discard'
    confirm.disabled = discard.disabled = waiting || state.busy
    const buttons = node('div', undefined, 'confirm')
    buttons.append(confirm, discard)
    panel.append(buttons)
    return
  }
  if (result.status === 'refused') {
    panel.append(node('p', 'Total proposé : 100 XRP. Les deux montants individuels diffèrent de l’accord.', 'error'))
  }
  if (result.deltas) {
    const totals = node('div', undefined, 'totals')
    for (const [role, drops] of Object.entries(result.deltas)) {
      const cell = node('div')
      cell.append(node('span', roles[role]), node('strong', (Number(drops) > 0 ? '+' : '') + xrp(drops)))
      totals.append(cell)
    }
    panel.append(totals, node('small', 'Variations en XRP, hors frais du lot.'))
  }
  if (result.batch) {
    panel.append(link(result.batch, 'Voir le lot sur XRPL'))
    const checks = result.inclusion.map(item => item.applied ? 'confirmée' : 'sans versement').join(' / ')
    panel.append(node('small', 'Opérations internes : ' + checks))
    if (result.cancelled) panel.append(link(result.cancelled, 'Voir l’annulation de l’offre'))
  }
  if (state.settlement?.batch && state.settlement !== result && state.settlement.batch !== result.batch) {
    panel.append(link(state.settlement.batch, 'Voir le règlement initial'))
  }
}

function render() {
  const running = waiting || state.busy
  const ready = state.status === 'ready' && !running
  const err = error || (state.status === 'error' && state.progress)
  const message = err || (running && (state.progress || 'Traitement en cours…'))
  byId('notice').hidden = !message
  byId('simulation-return').hidden = !err || state.mode !== 'testnet'
  byId('notice').textContent = message || ''
  byId('notice').classList.toggle('error', Boolean(err))
  byId('agency-state').textContent = state.agencyOnline ? 'Agence en ligne' : 'Agence hors ligne'
  byId('agency-state').classList.toggle('offline', !state.agencyOnline)
  byId('mode-tag').textContent = state.mode === 'testnet' ? 'XRPL TESTNET' : 'SIMULATION'
  byId('mode-tag').classList.toggle('live', state.mode === 'testnet')
  byId('toggle').textContent = state.agencyOnline ? 'Simuler la panne' : 'Rétablir le principal'
  const other = state.winner === 'rescue' ? 'normal' : 'rescue'
  const enabled = {
    reset: !running, testnet: !running, simulation: !running,
    toggle: ready,
    'ask-normal': ready && !state.pending && state.agentsHealth.normal.online,
    'ask-rescue': ready && !state.pending && state.agentsHealth.rescue.online,
    normal: ready && state.agencyOnline && !state.winner && !state.pending,
    rescue: ready && !state.agencyOnline && !state.winner && !state.pending && !state.cancelled,
    wrong: ready && !state.agencyOnline && !state.winner && !state.pending,
    rollback: ready && !state.agencyOnline && !state.winner && !state.pending && !state.cancelled,
    replay: ready && Boolean(state.winner) && (other === 'normal' ? state.agencyOnline : !state.agencyOnline)
      && !(other === 'rescue' && state.cancelled),
  }
  for (const button of document.querySelectorAll('button[data-action]')) {
    if (button.dataset.action in enabled) button.disabled = !enabled[button.dataset.action]
  }
  mode.disabled = running
  renderAgents()
  renderReport()
  const claims = byId('claims')
  claims.replaceChildren(node('h3', 'Créances commerciales tokenisées'))
  for (const [key, title] of [['invoice', 'Facture du restaurant · 100 XRP'], ['work', 'Mission du graphiste · 80 XRP']]) {
    const item = node('div', undefined, 'claim')
    item.append(node('strong', title))
    if (state.claims[key]) {
      const id = node('code', state.claims[key])
      item.append(id)
    }
    if (state.issuance?.[key]) item.append(link(state.issuance[key], 'Voir l’émission du NFT'))
    const download = node('a', 'Télécharger la facture de démo')
    download.href = '/factures/' + key + '.json'
    item.append(node('code', 'SHA-256 · ' + state.invoiceHashes[key]), download)
    claims.append(item)
  }
  const offerProof = byId('offer-proof')
  offerProof.replaceChildren()
  if (state.offers && state.mode === 'testnet') {
    for (const key of ['invoice', 'work']) {
      const group = node('details', undefined, 'claim')
      group.append(node('summary', key === 'invoice' ? 'PP-100 · Facture du restaurant' : 'PP-080 · Mission du graphiste'),
        node('code', state.claims[key]))
      for (const route of ['normal', 'rescue']) {
        const offer = state.offers[route].find(row => row.claim === key)
        group.append(node('strong', (route === 'normal' ? 'Circuit normal' : 'Circuit de secours') + ' · ' + xrp(offer.drops) + ' XRP'),
          node('code', offer.id))
      }
      offerProof.append(group)
    }
  } else {
    offerProof.append(node('p', 'Démarrer sur le Testnet pour afficher les identifiants d’émission et d’offres de la session.'))
  }
  const settlement = state.settlement
  byId('impact-measurements').textContent = settlement?.durationMs !== undefined
    ? [
        'Confirmation à l’écran après cosignature : ' + (settlement.durationMs / 1000).toLocaleString('fr-FR') + ' s.',
        settlement.recoveryMs === undefined ? '' : 'Temps entre panne simulée et confirmation : '
          + (settlement.recoveryMs / 1000).toLocaleString('fr-FR') + ' s, temps opérateur inclus.',
        state.result?.variant === 'replay' && state.result.status === 'reverted' ? 'Versement supplémentaire après relance : 0 XRP hors frais.' : '',
      ].filter(Boolean).join(' ')
    : 'Les mesures apparaissent après un règlement sur le Testnet.'
  byId('proof-export').hidden = !(state.mode === 'testnet' && state.settlement?.batch)
  byId('timeline').replaceChildren(...state.timeline.map(entry => {
    const li = node('li')
    li.append(node('time', new Date(entry.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })),
      node('strong', entry.title), node('span', entry.detail))
    return li
  }))
}

function refresh() {
  state = currentState()
  render()
}

async function act(action) {
  waiting = true
  error = ''
  render()
  let showReview = false
  try {
    if (action === 'reset') await initialize(mode.value)
    else {
      await execute(action)
      showReview = !['toggle', 'discard'].includes(action)
        && Boolean(currentState().pending || currentState().result)
        && (!action.startsWith('ask-') || Boolean(currentState().pending))
    }
  } catch (failure) {
    error = failure.message
  } finally {
    waiting = false
    refresh()
    if (showReview) byId('review-title').focus()
  }
}

function markNavigation() {
  const location = window.location.hash || '#apercu'
  for (const link of document.querySelectorAll('nav a')) {
    if (link.getAttribute('href') === location) link.setAttribute('aria-current', 'location')
    else link.removeAttribute('aria-current')
  }
}
window.addEventListener('hashchange', markNavigation)
markNavigation()

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]')
  if (button && !waiting && !button.disabled) {
    if (['testnet', 'simulation'].includes(button.dataset.action)) {
      mode.value = button.dataset.action
      void act('reset')
    } else void act(button.dataset.action)
  }
})

byId('proof-export').addEventListener('click', event => {
  event.preventDefault()
  const data = { network: 'XRPL Testnet', claims: state.claims, issuance: state.issuance,
    offers: state.offers, settlement: state.settlement,
    latestResult: state.result, signers: state.identities, registration: state.signerRegistration, timeline: state.timeline }
  downloadJson(JSON.stringify(data, null, 2), 'proofpay-preuve.json')
})

onProgress(refresh)
await initialize('simulation')
refresh()
