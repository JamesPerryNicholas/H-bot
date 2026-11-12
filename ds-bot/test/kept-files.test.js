import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEAM_TOOLS } from '../src/host/constants.js'
import {
  MAX_FILES, TITLE_MAX, deleteKeptFile, extOf, filePath, filesView, mimeOf,
  openKeptFile, previewKeptFile, resolveKeptPath, safeName, saveKeptFile,
} from '../src/host/kept-files.js'

const PNG = Buffer.from('iVBORw0KGoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function scratch() {
  return mkdtemp(join(tmpdir(), 'hbot-files-'))
}

test('file tools are on the team tool list', () => {
  for (const name of ['save_file', 'list_files', 'open_file', 'delete_file']) {
    assert.ok(TEAM_TOOLS.includes(name), name)
  }
})

test('save_file creates, lists, updates, opens, and deletes a file', async () => {
  const root = await scratch()
  try {
    const state = { files: {} }
    const src = join(root, 'weekly.txt')
    await writeFile(src, 'hello week')
    const created = await saveKeptFile(state, { title: '  Weekly notes  ', path: src, botId: 'bot-1' }, { root })
    assert.equal(created.error, undefined)
    assert.equal(created.created, true)
    assert.equal(created.file.title, 'Weekly notes')
    assert.equal(created.file.botId, 'bot-1')
    assert.equal(created.file.name, 'weekly.txt')
    assert.equal(created.file.size, 10)
    assert.ok(created.file.id)
    const stored = await readFile(filePath(root, created.file), 'utf8')
    assert.equal(stored, 'hello week')
    assert.deepEqual(filesView(state).map(file => file.id), [created.file.id])

    const next = join(root, 'weekly-v2.txt')
    await writeFile(next, 'hello week two!!')
    const updated = await saveKeptFile(state, { title: 'Weekly notes v2', path: next, id: created.file.id, botId: 'bot-2' }, { root })
    assert.equal(updated.error, undefined)
    assert.equal(updated.created, false)
    assert.equal(updated.file.title, 'Weekly notes v2')
    assert.equal(updated.file.botId, 'bot-2')
    assert.equal(updated.file.name, 'weekly-v2.txt')
    assert.equal(updated.file.size, 'hello week two!!'.length)
    assert.ok(updated.file.updatedAt >= created.file.createdAt)
    assert.equal(await readFile(filePath(root, updated.file), 'utf8'), 'hello week two!!')

    const opened = openKeptFile(state, created.file.id)
    assert.equal(opened.error, undefined)
    assert.equal(state.fileOpen.id, created.file.id)
    assert.ok(state.fileOpen.at)

    const removed = await deleteKeptFile(state, created.file.id, root)
    assert.equal(removed.error, undefined)
    assert.equal(filesView(state).length, 0)
    assert.equal(state.fileOpen, null)
    await assert.rejects(readFile(filePath(root, created.file)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('save_file rejects a missing file, a missing id, an oversized file, and a full list', async () => {
  const root = await scratch()
  try {
    const missing = await saveKeptFile({ files: {} }, { title: 'A', path: join(root, 'nope.txt') }, { root })
    assert.match(missing.error, /not found/i)
    assert.match((await saveKeptFile({ files: {} }, { title: 'A', path: root }, { root })).error, /not a file/i)
    assert.match((await saveKeptFile({ files: {} }, { title: 'A', id: 'missing' }, { root })).error, /No file/)

    const src = join(root, 'big.bin')
    await writeFile(src, Buffer.alloc(32, 1))
    const huge = await saveKeptFile({ files: {} }, { title: 'Big', path: src }, { root, maxBytes: 16 })
    assert.match(huge.error, /limit/)

    const state = { files: {} }
    for (let i = 0; i < MAX_FILES; i++) {
      const path = join(root, `f-${i}.txt`)
      await writeFile(path, String(i))
      const result = await saveKeptFile(state, { title: `File ${i}`, path, botId: 'bot' }, { root })
      assert.equal(result.error, undefined, result.error)
    }
    const extra = join(root, 'one-more.txt')
    await writeFile(extra, 'x')
    const full = await saveKeptFile(state, { title: 'One more', path: extra, botId: 'bot' }, { root })
    assert.match(full.error, new RegExp(String(MAX_FILES)))
    const firstId = filesView(state).at(-1).id
    const updated = await saveKeptFile(state, { title: 'Renamed', id: firstId }, { root })
    assert.equal(updated.error, undefined)
    assert.equal(updated.file.title, 'Renamed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a long title is trimmed to the limit and names are sanitized', async () => {
  const root = await scratch()
  try {
    const src = join(root, 'notes.txt')
    await writeFile(src, 'ok')
    const title = 'N'.repeat(TITLE_MAX + 20)
    const result = await saveKeptFile({ files: {} }, { title, path: src }, { root })
    assert.equal(result.file.title.length, TITLE_MAX)
    assert.equal(safeName('a/../b:c?.txt'), 'b_c_.txt')
    assert.equal(extOf('Photo.PNG'), 'png')
    assert.equal(mimeOf('shot.jpg'), 'image/jpeg')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('relative paths resolve against the working folder and attachments can be saved', async () => {
  const root = await scratch()
  try {
    const work = join(root, 'work')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(work)
    const src = join(work, 'inside.md')
    await writeFile(src, '# hi')
    const resolved = resolveKeptPath('inside.md', work)
    assert.equal(resolved.path, src)
    const saved = await saveKeptFile({ files: {} }, { path: 'inside.md', botId: 'bot' }, { root, base: work })
    assert.equal(saved.error, undefined)
    assert.equal(saved.file.title, 'inside.md')

    const attached = await saveKeptFile({ files: {} }, {
      title: 'Tiny',
      attachment: { attachmentId: 'att-1', name: 'dot.png' },
    }, { root, readAttachment: async () => PNG })
    assert.equal(attached.error, undefined)
    assert.equal(attached.file.name, 'dot.png')
    assert.equal(attached.file.mime, 'image/png')
    const preview = await previewKeptFile(root, attached.file)
    assert.equal(preview.preview, true)
    assert.ok(preview.data)
    assert.equal(preview.mime, 'image/png')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_file and open_file report a missing id', async () => {
  const state = { files: {} }
  assert.match((await deleteKeptFile(state, 'missing')).error, /No file/)
  assert.match(openKeptFile(state, 'missing').error, /No file/)
})
