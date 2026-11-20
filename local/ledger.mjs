import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  AccountSetAsfFlags, BatchFlags, Client, GlobalFlags, NFTokenCreateOfferFlags,
  NFTokenMintFlags, Wallet, decode, decodeAccountID, hashes, multisign, signMultiBatch, convertStringToHex,
} from 'xrpl'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { checkProposal, quote, TERMS } from './policy.mjs'
import { invoices } from './invoices.mjs'

const run = promisify(execFile)
const roles = ['restaurant', 'agency', 'designer']
const endpoint = 'wss://s.altnet.rippletest.net:51233'
const faucet = 'https://faucet.altnet.rippletest.net/accounts'
const amendment = '9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377'

function createClient() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  return new Client(endpoint, {
    connectionTimeout: 12000,
    timeout: 16000,
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
  })
}

async function fundedWallet(client, wallet, minimum) {
  async function requestFunds() {
    try {
      const { stdout } = await run('curl', ['--fail', '--silent', '--show-error',
        '--max-time', '20', '--retry', '2', '--retry-max-time', '35', faucet,
        '-H', 'Content-Type: application/json', '-d', JSON.stringify({ destination: wallet.address }),
      ])
      const result = JSON.parse(stdout)
      if (result.error) throw new Error(result.error)
    } catch (error) {
      if (String(error.stderr).includes('429')) {
        throw new Error('Le faucet XRPL limite les demandes. Attends quelques instants avant de relancer le scénario testnet.')
      }
      throw new Error('Financement des comptes de démonstration impossible. Vérifie le faucet XRPL et réessaie.')
    }
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
  throw new Error('Le faucet n’a pas crédité suffisamment de XRP de test.')
}

function resultCode(result) {
  return result.meta?.TransactionResult ?? 'unknown'
}

async function single(client, wallet, fields) {
  const { signers, ...transaction } = fields
  const tx = await client.autofill({ Account: wallet.address, ...transaction }, signers?.length)
  const blob = signers ? multisign(signers.map(signer => signer.sign(tx, true).tx_blob)) : wallet.sign(tx).tx_blob
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
  if (!id) throw new Error('Impossible de récupérer l’offre validée.')
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
    throw new Error('La facture ne correspond pas au NFT émis.')
  }
  return minted.NFTokenID
}

export async function liveSession(progress) {
  const client = createClient()
  try {
    await client.connect()
    const features = await client.request({ command: 'feature' })
    if (!features.result.features[amendment]?.enabled) {
      throw new Error('BatchV1_1 est indisponible sur ce réseau.')
    }
    progress('Financement de trois comptes XRPL…')
    const wallets = Object.fromEntries(roles.map(role => [role, Wallet.generate()]))
    await Promise.all(roles.map(role =>
      fundedWallet(client, wallets[role], role === 'restaurant' ? 105000000n : 5000000n)))
    const agents = { normal: Wallet.generate(), rescue: Wallet.generate() }
    const reviewer = Wallet.generate()
    const accounts = Object.fromEntries(roles.map(role => [role, wallets[role].address]))
    progress('Configuration du quorum et émission des deux jetons…')
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
    const scenario = { accounts, tokens: { invoice, work }, offers: {}, cancelled: false,
      signerRegistration: signerRegistration.hash }
    progress('Création des offres réservées aux deux circuits…')
    // Serialize writes per seller to avoid conflicting sequence numbers.
    const plans = { ...TERMS, ...quote }
    const all = Object.entries(plans).flatMap(([plan, rows]) => rows.map((row, index) => ({ plan, index, row })))
    for (const key of Object.keys(plans)) scenario.offers[key] = []
    await Promise.all(['agency', 'designer'].map(async role => {
      for (const item of all.filter(item => item.row.payee === role)) {
        scenario.offers[item.plan][item.index] = await offer(client, wallets, scenario, item.row)
      }
    }))
    progress('Activation de la cosignature pour le compte de l’agence…')
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
    throw new Error('Type d’offre XRPL inattendu.')
  }
  return { ...row, drops: node.Amount, owner: node.Owner, token: node.NFTokenID, destination: node.Destination }
}

async function snapshot(ctx) {
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

async function findInner(client, hash) {
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

export async function liveRun(ctx, route, variant, attestation) {
  const { scenario, client, wallets, agents, reviewer } = ctx
  const proposal = await liveProposal(ctx, route, variant)
  const rows = proposal.transfers
  if (!proposal.ok) return { status: 'refused', proposal }

  const draft = {
    TransactionType: 'Batch', Account: wallets.restaurant.address,
    Flags: BatchFlags.tfAllOrNothing,
    RawTransactions: rows.map(row => ({ RawTransaction: {
      Account: scenario.accounts[row.payer], TransactionType: 'NFTokenAcceptOffer',
      NFTokenSellOffer: row.id, Flags: GlobalFlags.tfInnerBatchTxn,
    } })),
  }
  if (attestation) {
    const digest = createHash('sha256').update(attestation.document).digest('hex')
    const evidence = JSON.parse(attestation.document)
    const offerIds = rows.map(row => row.id)
    if (digest !== attestation.digest || evidence.route !== route || !['A', 'B'].includes(evidence.choice)
      || evidence.agent !== agents[route].address || evidence.offers.length !== offerIds.length
      || evidence.offers.some((id, index) => id !== offerIds[index])) {
      throw new Error('La décision IA ne correspond pas au lot proposé.')
    }
    draft.Memos = [{ Memo: {
      MemoType: convertStringToHex('proofpay/agent-decision-v1'),
      MemoFormat: convertStringToHex('text/plain'),
      MemoData: convertStringToHex(digest),
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
  if (!matches) throw new Error('Le lot exact diffère de la proposition approuvée.')
  if (route === 'normal') {
    const approvals = [agents.normal, reviewer].flatMap(wallet => {
      const copy = structuredClone(unsigned)
      signMultiBatch(wallet, copy, { batchAccount: scenario.accounts.agency, multisign: true })
      return copy.BatchSigners[0].BatchSigner.Signers
    })
    approvals.sort((left, right) => Buffer.compare(
      decodeAccountID(left.Signer.Account), decodeAccountID(right.Signer.Account),
    ))
    unsigned.BatchSigners = [{ BatchSigner: { Account: scenario.accounts.agency, Signers: approvals } }]
  }
  const blob = multisign([agents[route].sign(unsigned, true).tx_blob, reviewer.sign(unsigned, true).tx_blob])

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
    .map(({ RawTransaction }) => findInner(client, hashes.hashSignedTx(RawTransaction))))
  const after = await snapshot(ctx)
  const fee = result.tx_json?.Fee ?? unsigned.Fee
  const deltas = Object.fromEntries(roles.map(role => [role, String(BigInt(after[role]) - BigInt(before[role])
    + (role === 'restaurant' ? BigInt(fee) : 0n))]))
  const applied = result.validated && inclusion.every(row => row.applied)
  if (inclusion.some(row => row.applied) !== applied) {
    throw new Error('Résultat des opérations internes incohérent, inspecte le registre.')
  }
  const amounts = applied ? { restaurant: '-100000000', agency: '20000000', designer: '80000000' }
    : { restaurant: '0', agency: '0', designer: '0' }
  if (roles.some(role => amounts[role] !== deltas[role])) {
    throw new Error('Les variations de soldes observées diffèrent des montants attendus.')
  }
  return {
    status: applied ? 'settled' : 'reverted', proposal, deltas, inclusion, cancelled,
    batch: result.hash, outerCode: resultCode(result), fee, ledger: result.ledger_index,
  }
}
