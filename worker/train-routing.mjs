import { writeFile } from 'node:fs/promises'

// Fit a small binary classifier on synthetic contract, availability and quote scenarios.
function makeRandom(seed) {
  return () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 2 ** 32)
}
const sigmoid = value => 1 / (1 + Math.exp(-value))
function dataset(seed, count) {
  const rand = makeRandom(seed)
  return Array.from({ length: count }, (_, index) => {
    const [phase, spent, revoked, amount1, amount2, identity1, identity2] =
      Array.from({ length: 7 }, () => rand() < .16 ? 1 : 0)
    const features = index % 4 === 0 ? [0, 0, 0, 0, 0, 0, 0] :
      [phase, spent, revoked, amount1 * (.7 + .3 * rand()), amount2 * (.7 + .3 * rand()), identity1, identity2]
    return { features: [1, ...features], label: features.every(value => value === 0) ? 1 : 0 }
  })
}
const train = dataset(27, 3800)
const holdout = dataset(149, 1200)
const weights = Array(8).fill(0)
const epochs = 24
const predict = features => sigmoid(features.reduce((sum, feature, index) => sum + feature * weights[index], 0))
for (let epoch = 0; epoch < epochs; epoch++) {
  for (const row of train) {
    const error = row.label - predict(row.features)
    row.features.forEach((value, index) => { weights[index] += .04 * error * value })
  }
}
const threshold = .85
const passed = holdout.filter(row => Number(predict(row.features) >= threshold) === row.label).length
if (passed !== holdout.length) throw new Error('Routing classifier failed its synthetic holdout.')
const model = { version: 'ProofPay Routing v1', type: 'logistic regression', threshold,
  weights: weights.map(weight => +weight.toFixed(8)), trainCount: train.length, testCount: holdout.length, passed }
await writeFile('dist/routing-weights.mjs', 'export default ' + JSON.stringify(model, null, 2) + '\n')
