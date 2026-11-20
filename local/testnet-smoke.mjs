import assert from 'node:assert/strict'
import { liveSession, liveRun } from './ledger.mjs'

const session = await liveSession(console.log)
try {
  for (const [route, variant, status] of [
    ['rescue', 'wrong', 'refused'],
    ['rescue', 'rollback', 'reverted'],
    ['normal', 'approved', 'settled'],
    ['rescue', 'replay', 'reverted'],
  ]) {
    const result = await liveRun(session, route, variant)
    console.log({ route, variant, status: result.status, batch: result.batch,
      inner: result.inclusion?.map(tx => tx.code), deltas: result.deltas })
    assert.equal(result.status, status)
  }
} finally {
  await session.client.disconnect()
}

const rescue = await liveSession(console.log)
try {
  const settled = await liveRun(rescue, 'rescue', 'approved')
  const replay = await liveRun(rescue, 'normal', 'replay')
  console.log({ rescue: settled.batch, replay: replay.batch, statuses: [settled.status, replay.status] })
  assert.equal(settled.status, 'settled')
  assert.equal(replay.status, 'reverted')
} finally {
  await rescue.client.disconnect()
}
