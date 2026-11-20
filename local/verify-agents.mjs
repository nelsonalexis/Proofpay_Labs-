import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Client, convertHexToString } from 'xrpl'
import { HttpsProxyAgent } from 'https-proxy-agent'

const child = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
})
let client
try {
  const [line] = await once(child.stdout, 'data')
  const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(line.toString())[0]
  async function act(action, fields = {}) {
    const response = await fetch(origin + '/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
    })
    const state = await response.json()
    assert.equal(response.status, 200, state.error)
    return state
  }
  const mode = process.argv.includes('--testnet') ? 'testnet' : 'simulation'
  const selected = process.argv.includes('--normal') ? 'normal' : 'rescue'
  if (mode === 'testnet') {
    console.log('Préparation des comptes et offres XRPL…')
    const setup = await act('reset', { mode })
    assert.equal(setup.status, 'ready', setup.progress)
    assert.notEqual(setup.identities.normal, setup.identities.rescue)
  }
  const initial = await act('ask-rescue')
  assert.equal(initial.decisions.rescue.choice, 'wait', initial.decisions.rescue.explanation)
  const standard = await act('ask-normal')
  assert.equal(standard.pending?.route, 'normal', standard.decisions.normal.explanation)
  console.log('Agence:', standard.decisions.normal.explanation)
  const running = standard.agentsHealth
  assert.notEqual(running.normal.pid, running.rescue.pid)
  let proposed = standard
  if (selected === 'rescue') {
    const stopped = await act('toggle')
    assert.equal(stopped.pending, null)
    assert.deepEqual(stopped.agentsHealth.normal, { online: false, pid: null })
    assert.equal(stopped.agentsHealth.rescue.pid, running.rescue.pid)
    if (process.platform !== 'win32') {
      assert.throws(() => process.kill(running.normal.pid, 0), { code: 'ESRCH' })
    }
    assert.equal(stopped.identities.normal, standard.identities.normal)
    proposed = await act('ask-rescue')
    assert.equal(proposed.pending?.route, 'rescue', proposed.decisions.rescue.explanation)
    assert.deepEqual(proposed.pending.proposal.transfers.map(row => row.drops), ['80000000', '20000000'])
    console.log('Restaurant:', proposed.decisions.rescue.explanation)
  }
  const receipt = proposed.decisions[selected]
  const document = await fetch(origin + '/decisions/' + receipt.digest + '.json').then(response => response.text())
  assert.equal(createHash('sha256').update(document).digest('hex'), receipt.digest)
  console.log('Restaurant:', receipt.explanation)
  const settled = await act('confirm')
  assert.equal(settled.result.status, 'settled')
  assert.equal(settled.result.attestation.digest, receipt.digest)
  if (mode === 'testnet') {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    console.log('Lot XRPL ' + selected + ':', settled.result.batch)
    console.log('Identité ' + selected + ':', receipt.address)
    client = new Client('wss://s.altnet.rippletest.net:51233', {
      connectionTimeout: 20000,
      timeout: 16000,
      ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    })
    await client.connect()
    const { result } = await client.request({ command: 'tx', transaction: settled.result.batch })
    assert.equal(result.validated, true)
    const tx = result.tx_json ?? result
    assert.equal(convertHexToString(tx.Memos[0].Memo.MemoData), receipt.digest)
    assert.ok(tx.Signers.some(({ Signer }) => Signer.Account === receipt.address))
    console.log('Empreinte et signataire vérifiés sur le registre.')
  }
  if (selected === 'rescue') {
    const restarted = await act('toggle')
    assert.notEqual(restarted.agentsHealth.normal.pid, running.normal.pid)
    assert.equal(restarted.agentsHealth.rescue.pid, running.rescue.pid)
    assert.equal(restarted.identities.normal, standard.identities.normal)
    const replay = await act('replay')
    assert.equal(replay.result.status, 'reverted')
    assert.deepEqual(replay.result.deltas, { restaurant: '0', agency: '0', designer: '0' })
    if (mode === 'testnet') {
      const exported = await fetch(origin + '/preuve.json').then(response => response.json())
      assert.equal(exported.settlement.batch, settled.result.batch)
      assert.equal(exported.retry.batch, replay.result.batch)
      assert.equal(exported.serviceEvents.length, 2)
      console.log('Relance vérifiée sans versement:', replay.result.batch)
    }
  }
} finally {
  child.kill()
  if (client) await client.disconnect()
}
