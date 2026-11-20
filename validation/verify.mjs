import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import './sdk.mjs'
import { startSigner } from './processes.mjs'
import { liveSession, liveProposal, liveRun, prepareBatch, findTransaction, snapshot } from '../dist/ledger.mjs'
import { digestDecision } from '../dist/decisions.mjs'

const { hashes, decode, convertStringToHex } = globalThis.xrpl
const remoteFetch = globalThis.fetch
const relay = process.env.PROOFPAY_TEST_RELAY
if (!relay) {
  const router = (await import('../dist/server/index.js')).default
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/testnet/')
    ? router.fetch(new Request(new URL(input, 'https://localhost'), options)) : remoteFetch(input, options)
} else {
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/testnet/')
    ? remoteFetch(new URL(input, relay), options) : remoteFetch(input, options)
}

const [, , check, output] = process.argv
assert(['outage', 'race'].includes(check) && output, 'Utilisation : node validation/verify.mjs outage|race sortie.json')
const processes = []
try {
  const [normal, rescue, reviewer] = await Promise.all(['normal', 'rescue', 'reviewer'].map(async role => {
    const signer = await startSigner(role)
    processes.push(signer)
    return signer
  }))
  assert.equal(new Set(processes.map(signer => signer.pid)).size, 3)
  const ctx = await liveSession(message => console.error(check, message), { agents: { normal, rescue }, reviewer })
  const { client, scenario } = ctx
  const evidence = { network: 'XRPL Testnet', recordedAt: new Date().toISOString(), check,
    accounts: scenario.accounts, issuance: scenario.issuance, tokens: scenario.tokens,
    offers: scenario.offers, quorumTransaction: scenario.signerRegistration,
    signers: Object.fromEntries(Object.entries({ normal, rescue, reviewer }).map(([role, { address, pid }]) => [role, { address, pid }])),
  }
  if (check === 'outage') {
    const started = performance.now()
    await normal.stop()
    const healthy = { route: 'normal', agencyOnline: true, settled: false, cancelled: false, candidates: [] }
    await assert.rejects(normal.decide(healthy), /arrêté/)
    const options = await Promise.all(['wrong', 'approved'].map(variant => liveProposal(ctx, 'rescue', variant)))
    assert(!options[0].ok && options[1].ok)
    const observation = { ...healthy, route: 'rescue', agencyOnline: false, candidates: options.map(proposal => ({
      amountErrors: proposal.transfers.map(({ drops, expected }) => Math.min(1, Math.abs(Number(drops) - Number(expected)) / 1e6)),
      identityErrors: [false, false],
    })) }
    const inference = await rescue.decide(observation)
    assert.equal(inference.index, 1)
    const document = JSON.stringify({ schema: 'proofpay-mobile-decision-v1', agent: rescue.address, inference, observation,
      offers: options[inference.index].transfers.map(({ id, token, drops, owner, destination }) => ({ id, token, drops, owner, destination })) })
    const digest = await digestDecision(document)
    const result = await liveRun(ctx, 'rescue', 'approved', { document, digest })
    assert.equal(result.status, 'settled')
    const response = await client.request({ command: 'tx', transaction: result.batch })
    const tx = response.result.tx_json ?? response.result
    assert(tx.Signers.some(({ Signer }) => Signer.Account === rescue.address))
    assert(tx.Signers.some(({ Signer }) => Signer.Account === reviewer.address))
    assert(!tx.Signers.some(({ Signer }) => Signer.Account === normal.address))
    assert(tx.Memos.some(({ Memo }) => Memo.MemoData === convertStringToHex(digest)))
    Object.assign(evidence, { primaryStopped: true, recoveryMs: Math.round(performance.now() - started),
      decision: { document, digest }, settlement: result })
  } else {
    const routes = ['normal', 'rescue']
    const candidates = await Promise.all(routes.map(async route => {
      const proposal = await liveProposal(ctx, route, 'approved')
      assert(proposal.ok)
      const { blob, unsigned } = await prepareBatch(ctx, route, 'approved', proposal)
      return { route, blob, unsigned, hash: hashes.hashSignedTx(blob) }
    }))
    assert.notEqual(candidates[0].hash, candidates[1].hash)
    assert.equal(candidates[0].unsigned.Sequence, candidates[1].unsigned.Sequence)
    const before = await snapshot(ctx)
    const preliminary = await Promise.all(candidates.map(({ blob }) =>
      client.request({ command: 'submit', tx_blob: blob, fail_hard: true })))
    const final = await Promise.all(candidates.map(async ({ route, blob, hash }) => {
      const innerHashes = decode(blob).RawTransactions.map(({ RawTransaction }) => hashes.hashSignedTx(RawTransaction))
      return { route, hash, innerHashes }
    }))
    let inspection
    for (let attempt = 0; attempt < 18; attempt++) {
      inspection = await Promise.all(final.map(async item => ({
        ...item, outer: await findTransaction(client, item.hash),
        inner: await Promise.all(item.innerHashes.map(hash => findTransaction(client, hash))),
      })))
      if (inspection.some(item => item.outer.applied && item.inner.every(tx => tx.applied))) break
      await new Promise(resolve => setTimeout(resolve, 1800))
    }
    const applied = inspection.filter(item => item.inner.every(tx => tx.applied))
    assert.equal(applied.length, 1)
    const winner = applied[0]
    const loser = inspection.find(item => item !== winner)
    assert(winner.outer.applied && loser.inner.every(tx => !tx.applied))
    const account = await client.request({ command: 'account_info', account: scenario.accounts.restaurant, ledger_index: 'validated' })
    const sequence = candidates[0].unsigned.Sequence
    assert(account.result.account_data.Sequence > sequence)
    const after = await snapshot(ctx)
    const fee = BigInt(candidates.find(item => item.route === winner.route).unsigned.Fee)
    const deltas = Object.fromEntries(Object.keys(before).map(key =>
      [key, String(BigInt(after[key]) - BigInt(before[key]) + (key === 'restaurant' ? fee : 0n))]))
    assert.deepEqual(deltas, { restaurant: '-100000000', agency: '20000000', designer: '80000000' })
    console.error('race', 'Deux soumissions concurrentes vérifiées, préparation de la relance…')
    const replay = await liveRun(ctx, loser.route, 'replay')
    assert.equal(replay.status, 'reverted')
    Object.assign(evidence, { sequence, winner: winner.route, deltas, replay,
      submissions: inspection.map((item, i) => ({ ...item, preliminary: preliminary[i].result.engine_result })) })
  }
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log(check, 'vérifié', output)
} finally {
  await Promise.all(processes.map(signer => signer.stop()))
}
