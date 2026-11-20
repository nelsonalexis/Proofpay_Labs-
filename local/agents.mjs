import { access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'

export const modelFile = resolve(process.env.PROOFPAY_MODEL || 'models/qwen2.5-0.5b-instruct-q4_k_m.gguf')
export const agentsByRoute = {
  normal: { title: 'Agent IA Agence', job: 'Plan standard. Intervenir uniquement si le service de paiement de l’agence est en ligne.' },
  rescue: { title: 'Agent IA Restaurant', job: 'Plan de secours. Intervenir uniquement si le service de paiement de l’agence est hors ligne.' },
}

let engine
async function loadEngine() {
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp')
  const llama = await getLlama({ gpu: false, logLevel: 'error' })
  const model = await llama.loadModel({ modelPath: modelFile })
  return { llama, model, LlamaChatSession }
}

export async function modelAvailable() {
  return access(modelFile).then(() => true, () => false)
}

export async function infer(route, observation) {
  if (!await modelAvailable()) {
    throw new Error('Modèle IA absent. Suis la section « Activer les agents IA » du README puis réessaie.')
  }
  engine ??= loadEngine().catch(error => {
    engine = undefined
    throw error
  })
  const { llama, model, LlamaChatSession } = await engine
  const choices = Object.entries(observation.plans).filter(([, item]) => item.conforme).map(([id]) => id)
  const grammar = await llama.createGrammarForJsonSchema({
    type: 'object',
    properties: {
      choice: { enum: choices.length ? choices : ['wait'] },
      explanation: { type: 'string', minLength: 1, maxLength: 150 },
    },
    required: ['choice', 'explanation'],
    additionalProperties: false,
  })
  const context = await model.createContext({ contextSize: 1536, threads: 4 })
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: [
        'Tu es un agent de règlement ProofPay.',
        'Reformule en une courte phrase française le résultat fourni par l’outil.',
        'Respecte exactement le statut autorisé ou en attente et les faits fournis.',
        'Tu ne signes pas de transaction.',
      ].join(' '),
    })
    const instruction = choices.length
      ? 'Le circuit est autorisé. Le ou les plans conformes sont : ' + choices.join(', ') + '. Explique que le plan respecte les paiements convenus.'
      : 'Ce circuit est indisponible. La décision est wait. Explique pourquoi il faut attendre.'
    const answer = await session.prompt(instruction + '\n' + JSON.stringify({
      mission: agentsByRoute[route].job, ...observation,
    }), {
      grammar, maxTokens: 192, temperature: 0,
    })
    return { ...grammar.parse(answer), model: basename(modelFile) }
  } finally {
    await context.dispose()
  }
}

export function makeAttestation({ route, address, observation, decision, proposal }) {
  const document = JSON.stringify({
    schema: 'proofpay/agent-decision-v1',
    agent: address,
    route,
    model: decision.model,
    choice: decision.choice,
    explanation: decision.explanation,
    observation,
    offers: proposal?.transfers.map(row => row.id) ?? [],
  }, null, 2) + '\n'
  return { route, address, ...decision, document, digest: createHash('sha256').update(document).digest('hex') }
}
