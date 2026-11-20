import { decideRoute } from './routing-model.mjs'

const agents = new Map()

export function stopRoutingAgent(route) {
  agents.get(route)?.terminate()
  agents.delete(route)
}

export async function runRoutingAgent(observation) {
  if (typeof Worker === 'undefined') return decideRoute(observation)
  const { route } = observation
  if (!agents.has(route)) {
    const url = new URL('./routing-agent.mjs', import.meta.url)
    url.searchParams.set('route', route)
    agents.set(route, new Worker(url, { type: 'module', name: 'ProofPay-' + route }))
  }
  const agent = agents.get(route)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopRoutingAgent(route)
      reject(new Error('L’agent de décision n’a pas répondu.'))
    }, 7000)
    agent.onmessage = ({ data }) => {
      clearTimeout(timer)
      if (data.error) reject(new Error(data.error))
      else resolve(data.result)
    }
    agent.onerror = () => {
      clearTimeout(timer)
      stopRoutingAgent(route)
      reject(new Error('Impossible de démarrer l’agent de décision.'))
    }
    agent.postMessage(observation)
  })
}

export async function digestDecision(document) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
