import { decideRoute } from './routing-model.mjs'

const route = new URL(self.location.href).searchParams.get('route')
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: decideRoute({ ...data, route }) })
  } catch {
    self.postMessage({ error: 'Le modèle de décision n’a pas pu analyser la proposition.' })
  }
}
