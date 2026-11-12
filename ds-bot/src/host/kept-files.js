// Kept files: a file the user can reopen later, not only see once in chat.
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

export const MAX_FILES = 40
export const TITLE_MAX = 80
export const NAME_MAX = 180
export const MAX_BYTES = 50 * 1024 * 1024
export const PREVIEW_MAX = 8 * 1024 * 1024

const execFileAsync = promisify(execFile)

const TITLE_OF = (title) => String(title ?? '').trim().slice(0, TITLE_MAX)

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

export function extOf(name) {
  const base = String(name ?? '')
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function mimeOf(name, mime) {
  if (typeof mime === 'string' && mime.includes('/') && mime.length < 200) return mime
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream'
}

export function isImageName(name, mime) {
  const type = mimeOf(name, mime)
  return type.startsWith('image/') || IMAGE_EXT.has(extOf(name))
}

export function safeName(name) {
  const base = basename(String(name ?? '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  const trimmed = (cleaned || 'file').slice(0, NAME_MAX)
  return trimmed === '.' || trimmed === '..' ? 'file' : trimmed
}

export function filesView(state) {
  return Object.values(state.files ?? {}).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function fileDir(root, id) {
  return join(root, 'kept-files', id)
}

export function filePath(root, entry) {
  return join(fileDir(root, entry.id), entry.name)
}

export function folderOf(bot, home) {
  const raw = bot?.folder || bot?.cwd || bot?.workDir || bot?.workingFolder || home
  return typeof raw === 'string' && raw.trim() !== '' ? raw : home
}

export function resolveKeptPath(input, base) {
  const raw = String(input ?? '').trim()
  if (raw === '') return { error: 'A file path is required.' }
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(base || process.cwd(), raw)
  return { path: resolved }
}

async function removeDir(root, id) {
  await rm(fileDir(root, id), { recursive: true, force: true })
}

async function storeBytes(root, id, name, bytes) {
  const dir = fileDir(root, id)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, name)
  await writeFile(dest, bytes)
  return dest
}

async function storeCopy(root, id, name, from) {
  const dir = fileDir(root, id)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, name)
  await copyFile(from, dest)
  return dest
}

export async function saveKeptFile(state, { title, path: sourcePath, attachment, id, botId, name: givenName, mime: givenMime }, options = {}) {
  const root = options.root
  const maxBytes = options.maxBytes ?? MAX_BYTES
  if (typeof root !== 'string' || root === '') return { error: 'No file store is available.' }

  state.files ??= {}
  const existing = id ? state.files[id] : undefined
  if (id && existing === undefined) return { error: `No file with id ${id}.` }

  const hasSource = (typeof sourcePath === 'string' && sourcePath.trim() !== '') || attachment != null
  if (!existing && !hasSource) return { error: 'A file path or attachment is required.' }

  let bytes = options.bytes
  let sourceSize
  let sourceName = givenName
  let mime = givenMime

  if (bytes != null) {
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return { error: 'The file data was not readable.' }
    bytes = Buffer.from(bytes)
    sourceSize = bytes.length
  } else if (attachment != null && typeof options.readAttachment === 'function') {
    const attachmentId = typeof attachment === 'string' ? attachment : attachment.attachmentId
    if (typeof attachmentId !== 'string' || attachmentId.trim() === '') return { error: 'No attachment named.' }
    sourceName = sourceName || (typeof attachment === 'object' ? attachment.name : undefined)
    mime = mime || (typeof attachment === 'object' ? attachment.mime || attachment.contentType : undefined)
    try {
      bytes = await options.readAttachment({ attachmentId, name: sourceName })
    } catch (error) {
      return { error: `The attachment could not be read: ${error?.message ?? error}` }
    }
    if (bytes == null) return { error: 'This attachment cannot be read here.' }
    bytes = Buffer.from(bytes)
    sourceSize = bytes.length
  } else if (typeof sourcePath === 'string' && sourcePath.trim() !== '') {
    const resolved = resolveKeptPath(sourcePath, options.base)
    if (resolved.error) return resolved
    try {
      const info = await stat(resolved.path)
      if (!info.isFile()) return { error: 'That path is not a file.' }
      sourceSize = info.size
      sourceName = sourceName || basename(resolved.path)
      sourcePath = resolved.path
    } catch (error) {
      if (error?.code === 'ENOENT') return { error: 'That file was not found.' }
      return { error: `The file could not be read: ${error?.message ?? error}` }
    }
  }

  if (sourceSize != null && sourceSize > maxBytes) {
    const limit = maxBytes < 1024 * 1024
      ? `${Math.max(1, Math.round(maxBytes / 1024))} KB`
      : `${Math.round(maxBytes / (1024 * 1024))} MB`
    return { error: `That file is larger than the ${limit} limit.` }
  }

  const fileName = safeName(sourceName || existing?.name || title || 'file')
  const label = TITLE_OF(title) || TITLE_OF(existing?.title) || fileName
  if (label === '') return { error: 'A file needs a title or a name.' }

  const now = Date.now()
  if (existing) {
    if (hasSource || bytes != null) {
      if (existing.name !== fileName) await removeDir(root, existing.id)
      if (bytes != null) await storeBytes(root, existing.id, fileName, bytes)
      else await storeCopy(root, existing.id, fileName, sourcePath)
      existing.name = fileName
      existing.size = sourceSize ?? existing.size
      existing.mime = mimeOf(fileName, mime)
    }
    if (TITLE_OF(title)) existing.title = label
    existing.updatedAt = now
    if (botId) existing.botId = botId
    return { file: existing, created: false }
  }

  if (Object.keys(state.files).length >= (options.maxFiles ?? MAX_FILES)) {
    return { error: `The team already has ${options.maxFiles ?? MAX_FILES} files. Delete one before saving another, or update an existing file by id.` }
  }

  const file = {
    id: randomUUID(),
    title: label,
    name: fileName,
    mime: mimeOf(fileName, mime),
    size: sourceSize ?? 0,
    botId: botId ?? null,
    createdAt: now,
    updatedAt: now,
  }
  if (bytes != null) await storeBytes(root, file.id, fileName, bytes)
  else await storeCopy(root, file.id, fileName, sourcePath)
  if (!file.size) {
    try { file.size = (await stat(filePath(root, file))).size } catch {}
  }
  state.files[file.id] = file
  return { file, created: true }
}

export function openKeptFile(state, id) {
  const file = state.files?.[id]
  if (file === undefined) return { error: `No file with id ${id}.` }
  state.fileOpen = { id, at: Date.now() }
  return { file }
}

export async function deleteKeptFile(state, id, root) {
  const file = state.files?.[id]
  if (file === undefined) return { error: `No file with id ${id}.` }
  delete state.files[id]
  if (state.fileOpen?.id === id) state.fileOpen = null
  if (typeof root === 'string' && root !== '') await removeDir(root, id)
  return { file }
}

export async function previewKeptFile(root, entry, { max = PREVIEW_MAX } = {}) {
  if (!entry) return { error: 'No file named.' }
  const path = filePath(root, entry)
  try {
    const info = await stat(path)
    if (!info.isFile()) return { error: 'This file is no longer available.' }
    const image = isImageName(entry.name, entry.mime)
    if (!image || info.size > max) return { path, preview: false, mime: mimeOf(entry.name, entry.mime), size: info.size, name: entry.name }
    const bytes = await readFile(path)
    return {
      path,
      preview: true,
      mime: mimeOf(entry.name, entry.mime),
      size: info.size,
      name: entry.name,
      data: bytes.toString('base64'),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: 'This file is no longer available.' }
    return { error: `The file could not be read: ${error?.message ?? error}` }
  }
}

export async function openWithSystem(abs) {
  try {
    const electron = await import('electron')
    const shell = electron.shell ?? electron.default?.shell
    if (shell?.openPath) {
      const err = await shell.openPath(abs)
      if (err) throw new Error(err)
      return
    }
  } catch (error) {
    if (error && /Cannot find package 'electron'|Cannot find module 'electron'/.test(String(error?.message ?? error))) {
      // Fall through to the system opener.
    } else if (error && !/Cannot find/.test(String(error?.message ?? error))) {
      // Electron was present but openPath failed; try the system opener next.
    }
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/c', 'start', '', abs])
    return
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [abs])
    return
  }
  await execFileAsync('xdg-open', [abs])
}

const listText = (state) => {
  const rows = filesView(state)
  if (rows.length === 0) return 'No files yet.'
  return ['Files:', ...rows.map((file) => {
    const size = typeof file.size === 'number' ? `, ${file.size} bytes` : ''
    return `- ${file.title} (${file.id}) — ${file.name}${size} — updated ${new Date(file.updatedAt).toISOString()}`
  })].join('\n')
}

async function readAttachmentBytes(rt, file) {
  const attachments = rt.ctx?.get?.('attachments')
  if (attachments === undefined || typeof attachments.readFileStream !== 'function') return undefined
  const chunks = []
  let size = 0
  for await (const chunk of attachments.readFileStream(file, AbortSignal.timeout(60_000))) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > MAX_BYTES) throw new Error(`That file is larger than the ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit.`)
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

export function install(rt) {
  const { state, home } = rt
  const root = home

  rt.filesView = () => filesView(state)
  rt.fileEndpoint = async (endpoint, body) => {
    const id = String(body?.id ?? '').trim()
    if (endpoint === 'file-delete') {
      const result = await deleteKeptFile(state, id, root)
      if (result.error) throw Object.assign(new Error(result.error), { code: 'bot/invalid' })
      await rt.save()
      return { ok: true, id }
    }
    if (endpoint === 'file-open') {
      const entry = state.files?.[id]
      if (entry === undefined) throw Object.assign(new Error(`No file with id ${id}.`), { code: 'bot/invalid' })
      const dest = filePath(root, entry)
      try {
        await stat(dest)
      } catch {
        throw Object.assign(new Error('This file is no longer available.'), { code: 'bot/unavailable' })
      }
      await openWithSystem(dest)
      return { ok: true, id, path: dest }
    }
    if (endpoint === 'file-preview') {
      const entry = state.files?.[id]
      if (entry === undefined) throw Object.assign(new Error(`No file with id ${id}.`), { code: 'bot/invalid' })
      const result = await previewKeptFile(root, entry)
      if (result.error) throw Object.assign(new Error(result.error), { code: 'bot/unavailable' })
      return result
    }
    throw Object.assign(new Error('Unknown file action'), { code: 'bot/invalid' })
  }

  rt.teamTools.push(defineTool({
    name: 'list_files',
    description: 'List the saved files the user can reopen: title, id, file name, size, and when each was last updated. Save or replace one with save_file, reopen one with open_file, and remove one with delete_file.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_files.'
      return listText(state)
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'save_file',
    description: 'Save a file the user can reopen later (a document, image, spreadsheet, or other file they will come back to). Pass a path on this computer, or an attachment from this chat. Pass id to replace an existing file from list_files. After saving, tell the user it is in Files.',
    parameters: {
      title: { type: 'string', description: 'Short title shown in Files; defaults to the file name' },
      path: { type: 'string', description: 'Path of the file to keep, absolute or relative to this Bot\'s working folder' },
      attachment: { type: 'object', additionalProperties: true, description: 'A chat attachment to keep, with attachmentId and optional name' },
      id: { type: 'string', description: 'Existing file id to update; omit to keep a new file' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (bot === undefined) return 'Only Bots on the team can use save_file.'
      const attachment = args.attachment && typeof args.attachment === 'object' ? args.attachment : undefined
      const result = await saveKeptFile(state, {
        title: args.title,
        path: args.path,
        attachment,
        id: args.id ? String(args.id).trim() : undefined,
        botId: bot.id,
      }, {
        root,
        base: folderOf(bot, root),
        readAttachment: file => readAttachmentBytes(rt, file),
      })
      if (result.error) return result.error
      await rt.save()
      return result.created
        ? `Saved "${result.file.title}" (${result.file.id}). It is in Files. Tell the user they can reopen it from Files in the account menu or under Settings → Files.`
        : `Updated "${result.file.title}" (${result.file.id}).`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'open_file',
    description: 'Open a saved file for the user in Files. Use an id from list_files when they ask to reopen a file.',
    parameters: {
      id: { type: 'string', required: true, description: 'File id from list_files' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use open_file.'
      const result = openKeptFile(state, String(args.id ?? '').trim())
      if (result.error) return result.error
      await rt.save()
      return `Opening "${result.file.title}" in Files for the user.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'delete_file',
    description: 'Delete a saved file. Use only when the user asks to remove that file.',
    parameters: {
      id: { type: 'string', required: true, description: 'File id from list_files' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use delete_file.'
      const result = await deleteKeptFile(state, String(args.id ?? '').trim(), root)
      if (result.error) return result.error
      await rt.save()
      return `Deleted "${result.file.title}".`
    },
  }))
}
