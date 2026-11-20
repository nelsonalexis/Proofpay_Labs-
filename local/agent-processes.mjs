import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('./agent-worker.mjs', import.meta.url))

class AgentProcess {
  #child
  #requests = new Map()
  #counter = 0
  #ready = false

  constructor(route) {
    this.route = route
  }

  get health() {
    return { online: this.#ready, pid: this.#ready ? this.#child.pid : null }
  }

  async start() {
    if (this.#ready) return
    const child = fork(worker, [this.route], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    this.#child = child
    child.on('message', message => {
      if (message.ready) this.#ready = true
      else {
        const request = this.#requests.get(message.id)
        if (request) {
          this.#requests.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.decision)
        }
      }
    })
    const clean = () => {
      if (this.#child !== child) return
      this.#ready = false
      for (const { timer, reject } of this.#requests.values()) {
        clearTimeout(timer)
        reject(new Error('Le processus de l’agent est indisponible.'))
      }
      this.#requests.clear()
    }
    child.on('exit', clean)
    child.on('disconnect', clean)
    child.on('error', clean)
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('error', finish)
        if (error) reject(error)
        else resolve()
      }
      const onMessage = message => { if (message.ready) finish() }
      const onExit = () => finish(new Error('L’agent s’est arrêté avant son démarrage.'))
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('Délai de démarrage de l’agent dépassé.'))
      }, 8000)
      child.on('message', onMessage)
      child.once('exit', onExit)
      child.once('error', finish)
    })
  }

  async stop() {
    const child = this.#child
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }

  infer(observation) {
    if (!this.#ready) throw new Error('L’agent est arrêté. Rétablis son processus pour le consulter.')
    const id = ++this.#counter
    return new Promise((resolve, reject) => {
      const fail = error => {
        clearTimeout(timer)
        this.#requests.delete(id)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('Délai de réponse du modèle dépassé.')), 90000)
      this.#requests.set(id, { timer, resolve, reject })
      this.#child.send({ id, observation }, error => { if (error) fail(error) })
    })
  }
}

export const processes = { normal: new AgentProcess('normal'), rescue: new AgentProcess('rescue') }

export function executionStatus() {
  return Object.fromEntries(Object.entries(processes).map(([route, process]) => [route, process.health]))
}
