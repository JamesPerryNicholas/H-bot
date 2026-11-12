// Pack-time helper: seal the official OpenAI key into the package envelope.
// Never prints the key, user codes, or the open-edition wrap.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envelopePath, OPEN_WRAP_FILE, VARIANT_FILE, sealSecrets } from '../src/bundled-credit.mjs'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const variant = String(process.argv[2] ?? 'unlock').trim() === 'open' ? 'open' : 'unlock'
const keyFile = resolve(process.argv[3] ?? process.env.HBOT_OPENAI_KEY_FILE ?? '')
if (!keyFile || !existsSync(keyFile)) throw new Error('missing API key file')
const apiKey = readFileSync(keyFile, 'utf8').trim()
if (!apiKey || apiKey.length < 20) throw new Error('API key file looks too short')

writeFileSync(join(srcDir, VARIANT_FILE), `${JSON.stringify({ variant }, null, 2)}\n`, 'utf8')

let passphrases
const wrapFile = join(srcDir, OPEN_WRAP_FILE)
if (variant === 'open') {
  const passphrase = randomBytes(32).toString('hex')
  passphrases = [passphrase]
  writeFileSync(wrapFile, `${JSON.stringify({ v: 1, passphrase }, null, 2)}\n`, 'utf8')
} else {
  if (existsSync(wrapFile)) rmSync(wrapFile)
  const codesFile = resolve(process.argv[4] ?? process.env.HBOT_UNLOCK_CODES_FILE ?? '')
  if (!codesFile || !existsSync(codesFile)) throw new Error('missing unlock codes file')
  passphrases = readFileSync(codesFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (passphrases.length === 0) throw new Error('missing unlock code file')
}

const outFile = envelopePath(srcDir)
const envelope = await sealSecrets(apiKey, passphrases)
const json = `${JSON.stringify(envelope, null, 2)}\n`
if (json.includes(apiKey) || passphrases.some(code => json.includes(code))) {
  throw new Error('refusing to write an envelope that still contains secrets')
}
if (envelope.slots.length !== passphrases.length) throw new Error('slot count mismatch')
writeFileSync(outFile, json, 'utf8')
console.log('envelope-ok variant', variant, 'slots', envelope.slots.length, 'bytes', Buffer.byteLength(json))
