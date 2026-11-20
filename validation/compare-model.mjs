import assert from 'node:assert/strict'
import { decideRoute } from '../dist/routing-model.mjs'
import { checkProposal, TERMS } from '../dist/policy.mjs'

const scenario = { tokens: { invoice: 'invoice', work: 'work' },
  accounts: { restaurant: 'client', agency: 'agency', designer: 'designer' } }

const amounts = [0, .000001, .001, .01, .1, .27, .3, 1]
const counts = { scenarios: 0, ruleAccepted: 0, modelAccepted: 0, modelOnly: 0, ruleOnly: 0, unsafeAfterRules: 0 }

for (const route of ['normal', 'rescue'])
  for (const agencyOnline of [false, true])
    for (const settled of [false, true])
      for (const cancelled of [false, true])
        for (const first of amounts)
          for (const second of amounts)
            for (const identityA of [false, true])
              for (const identityB of [false, true]) {
                const candidates = [{ amountErrors: [first, second], identityErrors: [identityA, identityB] }]
                const result = decideRoute({ route, agencyOnline, settled, cancelled, candidates })
                const eligible = (route === 'normal') === agencyOnline && !settled && !cancelled
                const rows = TERMS[route].map((term, index) => ({ ...term,
                  token: candidates[0].identityErrors[index] ? 'other' : scenario.tokens[term.claim],
                  drops: String(Number(term.drops) + 1e6 * candidates[0].amountErrors[index]),
                  owner: scenario.accounts[term.payee], destination: scenario.accounts[term.payer],
                }))
                const conforms = first === 0 && second === 0 && !identityA && !identityB
                const rule = eligible && checkProposal(scenario, route, rows).ok
                const model = result.index === 0
                counts.scenarios++
                counts.ruleAccepted += Number(rule)
                counts.modelAccepted += Number(model)
                counts.modelOnly += Number(model && !rule)
                counts.ruleOnly += Number(rule && !model)
                // The application requires both model selection and the exact policy.
                counts.unsafeAfterRules += Number(model && rule && !(eligible && conforms))
              }

assert.equal(counts.ruleOnly, 0)
assert.equal(counts.unsafeAfterRules, 0)
console.log(JSON.stringify(counts, null, 2))
