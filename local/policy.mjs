export const TERMS = {
  normal: [
    { claim: 'invoice', payer: 'restaurant', payee: 'agency', drops: '100000000' },
    { claim: 'work', payer: 'agency', payee: 'designer', drops: '80000000' },
  ],
  rescue: [
    { claim: 'work', payer: 'restaurant', payee: 'designer', drops: '80000000' },
    { claim: 'invoice', payer: 'restaurant', payee: 'agency', drops: '20000000' },
  ],
}

export const quote = {
  wrong: [
    { ...TERMS.rescue[0], drops: '85000000' },
    { ...TERMS.rescue[1], drops: '15000000' },
  ],
}

export function checkProposal(scenario, route, actual) {
  const expected = TERMS[route]
  if (!expected || actual.length !== expected.length) {
    return { ok: false, issues: ['Circuit ou nombre de versements invalide.'], transfers: [] }
  }
  const issues = []
  const transfers = expected.map((leg, index) => {
    const row = actual[index]
    const amountOK = row.drops === leg.drops
    const identityOK = row.claim === leg.claim
      && row.token === scenario.tokens[leg.claim]
      && row.payer === leg.payer && row.payee === leg.payee
      && row.destination === scenario.accounts[leg.payer]
      && row.owner === scenario.accounts[leg.payee]
    if (!amountOK) issues.push(`Versement ${index + 1} · ${formatXrp(row.drops)} XRP proposés, ${formatXrp(leg.drops)} convenus.`)
    if (!identityOK) issues.push(`Versement ${index + 1} · payeur, bénéficiaire ou jeton non conforme.`)
    return { ...row, expected: leg.drops, ok: amountOK && identityOK }
  })
  return { ok: issues.length === 0, issues, transfers }
}

export function formatXrp(drops) {
  const value = BigInt(drops)
  const abs = value < 0n ? -value : value
  const fraction = String(abs % 1000000n).padStart(6, '0').replace(/0+$/, '')
  return (value < 0n ? '−' : '') + (abs / 1000000n) + (fraction ? '.' + fraction : '')
}
