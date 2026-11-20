import { createHash } from 'node:crypto'

// The exact downloadable bytes are the documents referenced by the NFT URIs.
const facts = {
  invoice: { id: 'PP-100', issuer: 'Agence', debtor: 'Restaurant', service: 'Conception d’un logo', faceValueXrp: 100 },
  work: { id: 'PP-080', issuer: 'Graphiste', debtor: 'Agence', service: 'Réalisation du logo', faceValueXrp: 80 },
}

export const invoices = Object.fromEntries(Object.entries(facts).map(([key, fact]) => {
  const document = JSON.stringify({ ...fact, demo: true, currency: 'XRP Testnet' }, null, 2) + '\n'
  const digest = createHash('sha256').update(document).digest('hex')
  return [key, { document, digest, uri: 'urn:sha256:' + digest }]
}))
