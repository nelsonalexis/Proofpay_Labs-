import { fork } from 'node:child_process'
import { once } from 'node:events'

export async function startSigner(role) {
  const child = fork(new URL('./signer.mjs', import.meta.url), [role], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {},
  })
  const [identity] = await once(child, 'message', { signal: AbortSignal.timeout(15000) })
    .catch(error => { child.kill(); throw error })
  let sequence = 0
  const pending = new Map()
  child.on('message', ({ id, result, error }) => {
    const handler = pending.get(id)
    if (!handler) return
    if (error) handler.reject(new Error(error))
    else handler.resolve(result)
  })
  child.once('exit', () => {
    for (const handler of pending.values()) handler.reject(new Error('Processus arrêté.'))
  })
  const call = async (type, payload) => {
    if (!child.connected) throw new Error('Processus arrêté.')
    const id = ++sequence
    const answer = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.send({ id, type, payload }, error => { if (error) reject(error) })
    })
    const timeout = AbortSignal.timeout(10000)
    const expire = () => pending.get(id)?.reject(new Error('Temps de réponse du signataire dépassé.'))
    timeout.addEventListener('abort', expire, { once: true })
    return answer.finally(() => {
      pending.delete(id)
      timeout.removeEventListener('abort', expire)
    })
  }
  return {
    ...identity,
    sign: tx => call('sign', { tx }),
    signBatch: (tx, account) => call('signBatch', { tx, account }),
    decide: observation => call('decide', observation),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exit = once(child, 'exit')
      child.kill('SIGKILL')
      await exit
    },
  }
}
