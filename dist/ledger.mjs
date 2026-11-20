const { AccountSetAsfFlags, BatchFlags, Client, GlobalFlags, NFTokenCreateOfferFlags,
  NFTokenMintFlags, Wallet, decode, decodeAccountID, hashes, multisign, signMultiBatch, convertStringToHex } = globalThis.xrpl

import { checkProposal, quote, TERMS } from './policy.mjs'
import { invoices } from './invoices.mjs'
import { digestDecision } from './decisions.mjs'

const roles = ['restaurant', 'agency', 'designer']
const amendment = '9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377'

async function post(url, body, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  } catch {
    return { status: 0, body: {} }
  } finally {
    clearTimeout(timer)
  }
}

const backupRpc = 'https://testnet.xrpl-labs.com/'
const backupFaucet = 'https://faucet.altnet.rippletest.net/accounts'
let directPreferred = false

async function testnetRequest(path, body, service) {
  const sameOrigin = () => post('/api/testnet/' + path, body, 22000)
  const direct = () => path === 'rpc'
    ? post(backupRpc, { method: body.command, params: [{ ...body, command: undefined, api_version: 2 }] }, 14000)
    : post(backupFaucet, body, 14000)
  const isSuccess = answer => answer.status >= 200 && answer.status < 300
    && (path === 'faucet' || answer.body.result)
  const firstDirect = path === 'rpc' && directPreferred
  const first = await (firstDirect ? direct : sameOrigin)()
  if (isSuccess(first)) return first.body
  if (path === 'faucet' && first.status === 429) throw new Error(first.body.message || 'The XRPL faucet is temporarily rate-limiting requests.')
  const second = await (firstDirect ? sameOrigin : direct)()
  if (isSuccess(second)) {
    if (path === 'rpc') directPreferred = !firstDirect
    return second.body
  }
  if (second.status === 429) throw new Error(service + ' is temporarily rate-limiting requests. Try again shortly.')
  throw new Error(first.body.message || service + ' is unavailable. Try again or return to simulation.')
}

// Reuse the SDK's autofill, signing and confirmation logic over same-origin HTTPS.
class TestnetClient extends Client {
  async connect() {
    const { result } = await this.request({ command: 'server_info' })
    if (result.info.network_id !== 1) throw new Error('The connected server is not on XRP Ledger Testnet.')
    this.networkID = result.info.network_id
    this.buildVersion = result.info.build_version
  }

  async disconnect() {}

  async request(command) {
    const response = await testnetRequest('rpc', command, 'The Testnet ledger')
    const { result } = response
    if (!result || result.error) {
      throw Object.assign(new Error(result?.error_message || result?.error || 'Invalid XRPL response.'), { data: result })
    }
    return response
  }
}

async function fundedWallet(client, wallet, minimum) {
  const requestFunds = async () => {
    const result = await testnetRequest('faucet', { destination: wallet.address }, 'The XRPL faucet')
    if (result.error) throw new Error('The XRPL faucet rejected the funding request.')
  }
  await requestFunds()
  let toppedUp = false
  for (let attempt = 0; attempt < 28; attempt++) {
    try {
      const info = await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' })
      if (BigInt(info.result.account_data.Balance) >= minimum) return
      if (!toppedUp) {
        await requestFunds()
        toppedUp = true
      }
    } catch (error) {
      if (error.data?.error !== 'actNotFound') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 1100))
  }
  throw new Error('The faucet did not provide enough test XRP.')
}

function resultCode(result) {
  return result.meta?.TransactionResult ?? 'unknown'
}

async function single(client, wallet, fields) {
  const { signers, ...transaction } = fields
  const tx = await client.autofill({ Account: wallet.address, ...transaction }, signers?.length)
  const blob = signers ? multisign(await Promise.all(signers.map(async signer =>
    (await signer.sign(tx, true)).tx_blob))) : wallet.sign(tx).tx_blob
  const { result } = await client.submitAndWait(blob)
  if (!result.validated || resultCode(result) !== 'tesSUCCESS') {
    throw new Error(`${fields.TransactionType} · ${resultCode(result)}`)
  }
  return result
}

async function offer(client, wallets, scenario, row) {
  const result = await single(client, wallets[row.payee], {
    TransactionType: 'NFTokenCreateOffer',
    Flags: NFTokenCreateOfferFlags.tfSellNFToken,
    NFTokenID: scenario.tokens[row.claim],
    Amount: row.drops,
    Destination: scenario.accounts[row.payer],
  })
  const id = result.meta.AffectedNodes.find(node => node.CreatedNode?.LedgerEntryType === 'NFTokenOffer')
    ?.CreatedNode.LedgerIndex
  if (!id) throw new Error('Could not find the validated offer.')
  return { ...row, id, token: scenario.tokens[row.claim], destination: scenario.accounts[row.payer],
    owner: scenario.accounts[row.payee] }
}

async function mint(client, wallet, taxon, uri) {
  const result = await single(client, wallet, {
    TransactionType: 'NFTokenMint', NFTokenTaxon: taxon,
    Flags: NFTokenMintFlags.tfTransferable | NFTokenMintFlags.tfOnlyXRP,
    URI: convertStringToHex(uri),
  })
  const id = result.meta.nftoken_id
  const tokens = await client.request({ command: 'account_nfts', account: wallet.address, ledger_index: 'validated' })
  const minted = tokens.result.account_nfts.find(token => token.NFTokenTaxon === taxon && (!id || token.NFTokenID === id))
  if (!minted || minted.URI?.toUpperCase() !== convertStringToHex(uri).toUpperCase()) {
    throw new Error('The invoice hash does not match the minted NFT.')
  }
  return { id: minted.NFTokenID, transaction: result.hash }
}

export async function liveSession(progress, signing = {}) {
  const client = new TestnetClient('wss://testnet.xrpl-labs.com/')
  try {
    progress('Connecting to XRP Ledger Testnet…')
    await client.connect()
    const features = await client.request({ command: 'feature' })
    if (!features.result.features[amendment]?.enabled) {
      throw new Error('BatchV1_1 is unavailable on this network.')
    }
    progress('Funding three XRPL accounts…')
    const wallets = Object.fromEntries(roles.map(role => [role, Wallet.generate()]))
    await Promise.all(roles.map(role =>
      fundedWallet(client, wallets[role], role === 'restaurant' ? 105000000n : 5000000n)))
    const agents = signing.agents ?? { normal: Wallet.generate(), rescue: Wallet.generate() }
    const reviewer = signing.reviewer ?? Wallet.generate()
    const accounts = Object.fromEntries(roles.map(role => [role, wallets[role].address]))
    progress('Setting up signer quorum and minting both tokens…')
    const signerRegistration = await single(client, wallets.restaurant, {
      TransactionType: 'SignerListSet', SignerQuorum: 3,
      SignerEntries: [
        ...Object.values(agents).map(wallet => ({
          SignerEntry: { Account: wallet.address, SignerWeight: 1 },
        })),
        { SignerEntry: { Account: reviewer.address, SignerWeight: 2 } },
      ],
    })
    await single(client, wallets.restaurant, {
      TransactionType: 'AccountSet', SetFlag: AccountSetAsfFlags.asfDisableMaster,
    })
    const [invoice, work] = await Promise.all([
      mint(client, wallets.agency, 100, invoices.invoice.uri),
      mint(client, wallets.designer, 80, invoices.work.uri),
    ])
    const scenario = { accounts, tokens: { invoice: invoice.id, work: work.id },
      issuance: { invoice: invoice.transaction, work: work.transaction }, offers: {}, cancelled: false,
      signerRegistration: signerRegistration.hash }
    progress('Creating restricted offers for both routes…')
    // Serialize writes per seller to avoid conflicting sequence numbers.
    const plans = { ...TERMS, ...quote }
    const all = Object.entries(plans).flatMap(([plan, rows]) => rows.map((row, index) => ({ plan, index, row })))
    for (const key of Object.keys(plans)) scenario.offers[key] = []
    await Promise.all(['agency', 'designer'].map(async role => {
      for (const item of all.filter(item => item.row.payee === role)) {
        scenario.offers[item.plan][item.index] = await offer(client, wallets, scenario, item.row)
      }
    }))
    progress('Enabling co-signing for the agency account…')
    await single(client, wallets.agency, {
      TransactionType: 'SignerListSet', SignerQuorum: 2,
      SignerEntries: [agents.normal, reviewer].map(wallet => ({
        SignerEntry: { Account: wallet.address, SignerWeight: 1 },
      })),
    })
    await single(client, wallets.agency, {
      TransactionType: 'AccountSet', SetFlag: AccountSetAsfFlags.asfDisableMaster,
    })
    return { scenario, client, wallets, agents, reviewer }
  } catch (error) {
    await client.disconnect().catch(() => {})
    throw error
  }
}

export async function observedOffer(client, row) {
  const response = await client.request({
    command: 'ledger_entry', index: row.id, ledger_index: 'validated',
  })
  const node = response.result.node
  if (node.LedgerEntryType !== 'NFTokenOffer' || node.Flags !== 1) {
    throw new Error('Unexpected XRPL offer type.')
  }
  return { ...row, drops: node.Amount, owner: node.Owner, token: node.NFTokenID, destination: node.Destination }
}

export async function snapshot(ctx) {
  const { client, scenario } = ctx
  const current = await client.request({ command: 'ledger', ledger_index: 'validated' })
  const ledger = current.result.ledger_index
  const balances = await Promise.all(roles.map(async role => {
    const response = await client.request({
      command: 'account_info', ledger_index: ledger, account: scenario.accounts[role],
    })
    return [role, response.result.account_data.Balance]
  }))
  return Object.fromEntries(balances)
}

export async function findTransaction(client, hash) {
  try {
    const { result } = await client.request({ command: 'tx', transaction: hash })
    return { hash, code: resultCode(result), applied: result.validated === true && resultCode(result) === 'tesSUCCESS' }
  } catch (error) {
    if (error.data?.error !== 'txnNotFound') throw error
    return { hash, code: 'txnNotFound', applied: false }
  }
}

export async function liveProposal(ctx, route, variant) {
  const { scenario, client } = ctx
  const plan = variant === 'wrong' ? 'wrong' : route
  const expected = scenario.offers[plan]
  const replay = variant === 'replay'
  const rows = replay ? expected : await Promise.all(expected.map(row => observedOffer(client, row)))
  return checkProposal(scenario, route, rows)
}

export async function prepareBatch(ctx, route, variant, proposal, attestation) {
  const { scenario, client, wallets, agents, reviewer } = ctx
  const rows = proposal.transfers

  const draft = {
    TransactionType: 'Batch', Account: wallets.restaurant.address,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: rows.map(row => ({ RawTransaction: {
      Account: scenario.accounts[row.payer], TransactionType: 'NFTokenAcceptOffer',
      NFTokenSellOffer: row.id, Flags: GlobalFlags.tfInnerBatchTxn,
    } })),
  }
  if (attestation) {
    const evidence = JSON.parse(attestation.document)
    if (await digestDecision(attestation.document) !== attestation.digest
      || evidence.agent !== agents[route].address || evidence.observation.route !== route
      || evidence.offers.length !== rows.length
      || evidence.offers.some((offer, index) => {
        const row = rows[index]
        return ['id', 'token', 'drops', 'owner', 'destination'].some(field => offer[field] !== row[field])
      })) throw new Error('The model decision no longer matches the offers being signed.')
    draft.Memos = [{ Memo: {
      MemoType: convertStringToHex('proofpay-mobile-decision-v1'),
      MemoFormat: convertStringToHex('text/plain'),
      MemoData: convertStringToHex(attestation.digest),
    } }]
  }
  // The normal route requires two additional signatures for the agency account.
  const unsigned = await client.autofill(draft, route === 'normal' ? 4 : 2)
  unsigned.LastLedgerSequence += variant === 'rollback' ? 20 : 0
  // Both signers receive the exact batch. The review ties the serialized offer IDs
  // and the authorizing accounts to the trusted invoice terms above.
  const matches = unsigned.Account === scenario.accounts.restaurant
    && unsigned.Flags === BatchFlags.tfAllOrNothing && Number(unsigned.Fee) <= 1000000
    && unsigned.RawTransactions.length === rows.length
    && unsigned.RawTransactions.every(({ RawTransaction: inner }, index) =>
      inner.TransactionType === 'NFTokenAcceptOffer' && inner.NFTokenSellOffer === rows[index].id
      && inner.Account === rows[index].destination && inner.Flags === GlobalFlags.tfInnerBatchTxn)
  if (!matches) throw new Error('The exact batch differs from the approved proposal.')
  if (route === 'normal') {
    const approvals = (await Promise.all([agents.normal, reviewer].map(async wallet => {
      const copy = structuredClone(unsigned)
      if (wallet.signBatch) return wallet.signBatch(copy, scenario.accounts.agency)
      signMultiBatch(wallet, copy, { batchAccount: scenario.accounts.agency, multisign: true })
      return copy.BatchSigners[0].BatchSigner.Signers
    }))).flat()
    approvals.sort((left, right) => {
      const a = decodeAccountID(left.Signer.Account)
      const b = decodeAccountID(right.Signer.Account)
      return (a.find((value, index) => value !== b[index]) ?? 0)
        - (b.find((value, index) => value !== a[index]) ?? 0)
    })
    unsigned.BatchSigners = [{ BatchSigner: { Account: scenario.accounts.agency, Signers: approvals } }]
  }
  const signed = await Promise.all([agents[route], reviewer].map(wallet => wallet.sign(unsigned, true)))
  return { blob: multisign(signed.map(item => item.tx_blob)), unsigned }
}

export async function liveRun(ctx, route, variant, attestation) {
  const { scenario, client, wallets, agents, reviewer } = ctx
  const proposal = await liveProposal(ctx, route, variant)
  if (!proposal.ok) return { status: 'refused', proposal }
  const rows = proposal.transfers
  const { blob, unsigned } = await prepareBatch(ctx, route, variant, proposal, attestation)
  let cancelled
  if (variant === 'rollback') {
    const cancellation = await single(client, wallets.agency, {
      TransactionType: 'NFTokenCancelOffer', NFTokenOffers: [rows[1].id],
      signers: [agents.normal, reviewer],
    })
    cancelled = cancellation.hash
    scenario.cancelled = true
  }
  const before = await snapshot(ctx)
  const { result } = await client.submitAndWait(blob)
  const inclusion = await Promise.all(decode(blob).RawTransactions
    .map(({ RawTransaction }) => findTransaction(client, hashes.hashSignedTx(RawTransaction))))
  const after = await snapshot(ctx)
  const fee = result.tx_json?.Fee ?? unsigned.Fee
  const deltas = Object.fromEntries(roles.map(role => [role, String(BigInt(after[role]) - BigInt(before[role])
    + (role === 'restaurant' ? BigInt(fee) : 0n))]))
  const applied = result.validated && inclusion.every(row => row.applied)
  if (inclusion.some(row => row.applied) !== applied) {
    throw new Error('The inner transaction results are inconsistent. Check the ledger.')
  }
  const amounts = applied ? { restaurant: '-100000000', agency: '20000000', designer: '80000000' }
    : { restaurant: '0', agency: '0', designer: '0' }
  if (roles.some(role => amounts[role] !== deltas[role])) {
    throw new Error('The observed balance changes do not match the expected amounts.')
  }
  return {
    status: applied ? 'settled' : 'reverted', proposal, deltas, inclusion, cancelled,
    batch: result.hash, outerCode: resultCode(result), fee, ledger: result.ledger_index,
  }
}
