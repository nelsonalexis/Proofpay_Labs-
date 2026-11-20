import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { modelFile, modelAvailable } from './agents.mjs'

const source = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf'
const expected = '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db'

async function check(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex') === expected
}

if (await modelAvailable() && await check(modelFile)) {
  console.log('Modèle local déjà disponible.')
} else {
  await mkdir(dirname(modelFile), { recursive: true })
  const temporary = `${modelFile}.${process.pid}.partial`
  console.log('Téléchargement du modèle Qwen (~490 Mo)…')
  try {
    await promisify(execFile)('curl', ['--fail', '--silent', '--show-error', '--location',
      '--max-time', '600', '--retry', '2', '--output', temporary, source])
    if (!await check(temporary)) throw new Error('L’empreinte du modèle téléchargé diffère de la version attendue.')
    await rename(temporary, modelFile)
    console.log('Modèle local prêt.')
  } finally {
    await rm(temporary, { force: true })
  }
}
