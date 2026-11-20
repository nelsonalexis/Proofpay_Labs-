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
  const anchor = node('a', 'Télécharger la décision IA', 'ledger-link')
  anchor.href = '/decisions/' + attestation.digest + '.json'
  return anchor
}

function renderAgents() {
  byId('signer-proof').replaceChildren(...(state.signerRegistration
    ? [link(state.signerRegistration, 'Voir l’enregistrement des signataires sur XRPL ↗')] : []))
  byId('ai-status').textContent = state.modelReady ? 'MODÈLE LOCAL' : 'MODÈLE À INSTALLER'
  for (const route of ['normal', 'rescue']) {
    const health = state.agentsHealth[route]
    byId('health-' + route).textContent = health.online ? 'En ligne · processus ' + health.pid : 'Processus arrêté'
    byId('identity-' + route).textContent = state.identities[route] || ''
    const panel = byId('decision-' + route)
    const item = state.decisions[route]
    if (!item) {
      panel.replaceChildren()
      continue
    }
    const title = item.approved ? 'Règlement proposé' : item.choice === 'wait' ? 'En attente' : 'Proposition rejetée'
    panel.replaceChildren(node('strong', title), node('p', item.explanation), receiptLink(item))
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
    panel.append(link(result.batch, 'Voir le lot sur XRPL ↗'))
    const checks = result.inclusion.map(item => item.applied ? 'confirmée' : 'sans versement').join(' / ')
    panel.append(node('small', 'Opérations internes : ' + checks))
    if (result.cancelled) panel.append(link(result.cancelled, 'Voir l’annulation de l’offre ↗'))
  }
  if (state.settlement?.batch && state.settlement !== result && state.settlement.batch !== result.batch) {
    panel.append(link(state.settlement.batch, 'Voir le règlement initial ↗'))
  }
}

function render() {
  const running = waiting || state.busy
  const ready = state.status === 'ready' && !running
  const err = error || (state.status === 'error' && state.progress)
  const message = err || (running && (state.progress || 'Traitement en cours…'))
  byId('notice').hidden = !message
  byId('notice').textContent = message || ''
  byId('notice').classList.toggle('error', Boolean(err))
  byId('agency-state').textContent = state.agencyOnline ? 'Agence en ligne' : 'Agence hors ligne'
  byId('agency-state').classList.toggle('offline', !state.agencyOnline)
  byId('mode-tag').textContent = state.mode === 'testnet' ? 'XRPL TESTNET' : 'SIMULATION'
  byId('mode-tag').classList.toggle('live', state.mode === 'testnet')
  byId('toggle').textContent = state.agencyOnline ? 'Arrêter l’agent principal' : 'Relancer l’agent principal'
  const other = state.winner === 'rescue' ? 'normal' : 'rescue'
  const enabled = {
    reset: !running,
    toggle: ready,
    'ask-normal': ready && state.modelReady && !state.pending && state.agentsHealth.normal.online,
    'ask-rescue': ready && state.modelReady && !state.pending && state.agentsHealth.rescue.online,
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
    const download = node('a', 'Télécharger la facture de démo')
    download.href = '/factures/' + key + '.json'
    item.append(node('code', 'SHA-256 · ' + state.invoiceHashes[key]), download)
    claims.append(item)
  }
  byId('proof-export').hidden = !(state.mode === 'testnet' && state.settlement?.batch)
  byId('timeline').replaceChildren(...state.timeline.map(entry => {
    const li = node('li')
    li.append(node('time', new Date(entry.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })),
      node('strong', entry.title), node('span', entry.detail))
    return li
  }))
}

async function refresh() {
  const response = await fetch('/api/state')
  state = await response.json()
  render()
}

async function act(action) {
  waiting = true
  error = ''
  render()
  const poll = setInterval(() => refresh().catch(() => {}), 1200)
  try {
    const response = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, mode: mode.value }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    state = result
  } catch (failure) {
    error = failure.message
    await refresh().catch(() => {})
  } finally {
    clearInterval(poll)
    waiting = false
    render()
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]')
  if (button && !waiting && !button.disabled) void act(button.dataset.action)
})

refresh().then(() => { mode.value = state.mode }).catch(() => {
  byId('notice').hidden = false
  byId('notice').textContent = 'Impossible de joindre ProofPay.'
})
