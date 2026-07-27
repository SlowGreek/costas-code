import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAeGenerationRoot } from '../electron/ae-generation.ts'

export function prepareAePackage({ storeRoot, destination }) {
  const selected = resolveAeGenerationRoot(storeRoot)
  const generationName = selected.generationId.slice('sha256:'.length)
  const candidate = `${destination}.candidate-${process.pid}-${Date.now()}`
  fs.rmSync(candidate, { force: true, recursive: true })
  fs.mkdirSync(path.join(candidate, 'generations'), { recursive: true })
  fs.copyFileSync(path.join(storeRoot, 'CURRENT.json'), path.join(candidate, 'CURRENT.json'))
  fs.cpSync(selected.root, path.join(candidate, 'generations', generationName), { recursive: true })

  resolveAeGenerationRoot(candidate)
  fs.rmSync(destination, { force: true, recursive: true })
  fs.renameSync(candidate, destination)
  return { destination, generationId: selected.generationId }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const result = prepareAePackage({
    storeRoot: path.join(desktopRoot, 'build', 'ae'),
    destination: path.join(desktopRoot, 'build', 'ae-package')
  })
  console.log(`[prepare-ae-package] ${result.generationId} -> ${result.destination}`)
}
