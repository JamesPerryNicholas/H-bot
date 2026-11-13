// Packages must not include a provider API key. Users enter their own keys.
// This script only removes leftover sealed credit files from app/src.
// The old "seal a key into the envelope" usage is refused.
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envelopePath, OPEN_WRAP_FILE } from '../src/bundled-credit.mjs'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const args = process.argv.slice(2).filter(arg => arg !== '--')
if (args.some(arg => arg === 'open' || arg === 'unlock' || arg === 'seal')) {
  throw new Error('Refusing to seal a provider API key into the package. Users must enter their own keys.')
}

for (const file of [envelopePath(srcDir), join(srcDir, OPEN_WRAP_FILE)]) {
  if (existsSync(file)) rmSync(file)
}
console.log('bundled-credit-cleared')
