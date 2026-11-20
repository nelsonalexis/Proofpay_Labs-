import model from './routing-weights.mjs'

export function decideRoute({ agencyOnline, settled, cancelled, route, candidates }) {
  const expectedOnline = route === 'normal'
  const quoteScores = candidates.map(({ amountErrors, identityErrors }, index) => {
    const features = [1, Number(agencyOnline !== expectedOnline), Number(settled), Number(cancelled),
      ...amountErrors, ...identityErrors.map(Number)]
    const logit = features.reduce((sum, value, weight) => sum + value * model.weights[weight], 0)
    return { index, score: 1 / (1 + Math.exp(-logit)) }
  })
  const best = quoteScores.reduce((leading, row) => !leading || row.score > leading.score ? row : leading, null)
  return {
    model: model.version, threshold: model.threshold,
    index: best && best.score >= model.threshold ? best.index : null,
    scores: quoteScores.map(({ score }) => +score.toFixed(5)),
  }
}
