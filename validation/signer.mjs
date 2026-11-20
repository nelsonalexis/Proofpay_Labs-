// Testnet worker. Its ephemeral key never leaves this process.
import './sdk.mjs'
const { Wallet, signMultiBatch } = globalThis.xrpl
const { decideRoute } = await import('../dist/routing-model.mjs')
const wallet = Wallet.generate()
const role = process.argv[2]
process.send({ address: wallet.address, pid: process.pid })
process.on('message', ({ id, type, payload }) => {
  try {
    let result
    if (type === 'decide' && role === payload.route && role !== 'reviewer') {
      result = decideRoute(payload)
    } else if (type === 'sign' && payload.tx.TransactionType === 'Batch') {
      result = { tx_blob: wallet.sign(payload.tx, true).tx_blob }
    } else if (type === 'signBatch' && payload.tx.TransactionType === 'Batch' && role !== 'rescue') {
      const { tx, account } = payload
      signMultiBatch(wallet, tx, { batchAccount: account, multisign: true })
      result = tx.BatchSigners[0].BatchSigner.Signers
    } else {
      throw new Error('Opération hors du périmètre du signataire de test.')
    }
    process.send({ id, result })
  } catch (error) {
    process.send({ id, error: error.message })
  }
})
