import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { test } from 'node:test'

test('ProofPay API demonstrates review, atomic failure, settlement and replay', async t => {
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => child.kill())
  const [line] = await once(child.stdout, 'data')
  const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(line.toString())[0]

  async function act(action, extra = {}) {
    const response = await fetch(origin + '/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    })
    return { status: response.status, state: await response.json() }
  }
  const start = await fetch(origin + '/api/state').then(response => response.json())
  assert.equal(start.mode, 'simulation')
  for (const type of ['invoice', 'work']) {
    const bytes = await fetch(origin + '/factures/' + type + '.json').then(response => response.text())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), start.invoiceHashes[type])
  }
  assert.equal((await act('rescue')).status, 400)
  assert.ok(start.agentsHealth.normal.pid > 0)
  assert.notEqual(start.agentsHealth.normal.pid, start.agentsHealth.rescue.pid)
  const stopped = (await act('toggle')).state
  assert.equal(stopped.agentsHealth.normal.online, false)
  assert.equal(stopped.agentsHealth.rescue.pid, start.agentsHealth.rescue.pid)
  const wrong = (await act('wrong')).state
  assert.equal(wrong.result.status, 'refused')
  assert.deepEqual(wrong.result.proposal.transfers.map(row => row.ok), [false, false])
  assert.equal(wrong.result.batch, undefined)

  const rollback = (await act('rollback')).state
  assert.equal(rollback.result.status, 'reverted')
  assert.ok(Object.values(rollback.result.deltas).every(delta => delta === '0'))
  assert.equal((await act('rescue')).status, 400)

  await act('reset', { mode: 'simulation' })
  await act('toggle')
  const preview = (await act('rescue')).state
  assert.equal(preview.pending.route, 'rescue')
  assert.equal(preview.winner, null)
  const settled = (await act('confirm')).state
  assert.equal(settled.winner, 'rescue')
  assert.deepEqual(settled.result.deltas, { restaurant: '-100000000', agency: '20000000', designer: '80000000' })
  await act('toggle')
  const replay = (await act('replay')).state
  assert.equal(replay.result.status, 'reverted')
  assert.equal(replay.settlement.status, 'settled')
  await act('reset', { mode: 'simulation' })
  assert.equal((await act('normal')).state.pending.route, 'normal')
  assert.equal((await act('confirm')).state.winner, 'normal')
})
