import { infer } from './agents.mjs'

const route = process.argv[2]
process.on('disconnect', () => process.exit(0))
process.on('message', async ({ id, observation }) => {
  try {
    const decision = await infer(route, observation)
    process.send({ id, decision })
  } catch (error) {
    process.send({ id, error: error.message })
  }
})
process.send({ ready: true })
