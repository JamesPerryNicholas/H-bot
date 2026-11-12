import { createElement as h, useEffect, useRef, useState } from 'react'
import { FileIcon, TrashIcon } from './icons.js'
import { BotAvatar } from './mark.js'
import { t } from './i18n.js'

export const FILES_CSS = `
.bt-file-panel{display:flex;flex-direction:column;gap:12px;min-height:0}
.bt-file-empty{padding:16px 18px}
.bt-file-row{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:10px 12px;border:0;border-bottom:1px solid var(--bt-line);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-file-row:last-child{border-bottom:0}
.bt-file-row:hover{background:var(--bt-hover)}
.bt-file-row .bt-file-mark{flex:none}
.bt-file-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-file-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-file-view{min-height:80px;padding:4px 2px 16px;display:flex;flex-direction:column;gap:12px}
.bt-file-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-file-meta{color:var(--bt-ink-2);font-size:12px}
.bt-file-gone{padding:16px 4px}
.bt-file-preview{max-width:100%;max-height:min(420px,60vh);object-fit:contain;border-radius:8px;background:var(--bt-hover)}
.bt-file-actions{display:flex;flex-wrap:wrap;gap:8px}
`

const goneName = () => t('A removed Bot')

function whenText(ms) {
  if (!ms) return ''
  try { return new Date(ms).toLocaleString() } catch { return '' }
}

export function sizeText(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) {
    const kb = n / 1024
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  const mb = n / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function FileMeta({ file, roster }) {
  const bot = file.botId ? roster.byId?.[file.botId] : undefined
  const who = file.botId ? (bot ? t('Saved by {name}', { name: bot.name }) : goneName()) : ''
  const updated = t('Updated {time}', { time: whenText(file.updatedAt) })
  const size = sizeText(file.size)
  return h('span', { className: 'bt-file-meta' }, [file.name, size, who, updated].filter(Boolean).join(' · '))
}

function DeleteButton({ onDelete }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = (event) => {
    event.stopPropagation()
    if (busy) return
    if (!confirming) { setConfirming(true); return }
    setBusy(true)
    void Promise.resolve(onDelete()).catch(() => setBusy(false))
  }
  return h('button', {
    type: 'button', className: 'bt-mini bt-task-remove', 'data-confirm': confirming || undefined, disabled: busy,
    'aria-label': confirming ? t('Click again to delete') : t('Delete file'),
    title: confirming ? undefined : t('Delete file'),
    onClick: remove,
  }, confirming ? t('Delete') : h(TrashIcon))
}

function FileList({ files, roster, actions, readOnly }) {
  return h('div', { className: 'bt-set-card' },
    files.map(file => {
      const bot = file.botId ? roster.byId?.[file.botId] : undefined
      return h('div', { key: file.id, className: 'bt-set-row', style: { display: 'flex', alignItems: 'center', gap: 8, padding: 0 } },
        h('button', { type: 'button', className: 'bt-file-row', onClick: () => actions.openSettings('files', file.id) },
          h('span', { className: 'bt-file-mark', 'aria-hidden': true },
            bot ? h(BotAvatar, { bot, size: 18, badge: false, live: false }) : h(FileIcon)),
          h('span', { className: 'bt-file-copy' },
            h('span', { className: 'bt-file-title' }, file.title),
            h(FileMeta, { file, roster }))),
        readOnly ? null : h(DeleteButton, { onDelete: () => actions.deleteFile(file.id) }))
    }))
}

function FilePreview({ file, actions, readOnly }) {
  const [shot, setShot] = useState(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setShot(null)
    setError('')
    if (typeof actions.previewFile !== 'function') return undefined
    void actions.previewFile(file.id).then((result) => {
      if (!alive) return
      setShot(result ?? null)
    }).catch(() => {
      if (alive) setShot(null)
    })
    return () => { alive = false }
  }, [file.id, file.updatedAt])
  const open = () => {
    if (opening || typeof actions.openKeptFile !== 'function') return
    setOpening(true)
    setError('')
    void Promise.resolve(actions.openKeptFile(file.id)).catch((err) => {
      setError(err?.message || t('This file is no longer available.'))
    }).finally(() => setOpening(false))
  }
  const src = shot?.preview && shot.data && shot.mime ? `data:${shot.mime};base64,${shot.data}` : null
  return h('div', { className: 'bt-file-view' },
    src ? h('img', { className: 'bt-file-preview', src, alt: file.title }) : null,
    h('div', { className: 'bt-file-actions' },
      readOnly ? null : h('button', {
        type: 'button', className: 'bt-soft', disabled: opening, onClick: open,
      }, t('Open with system app'))),
    error ? h('div', { className: 'bt-set-hint' }, error) : null)
}

export function FilesPage({ roster, actions, id }) {
  const files = Array.isArray(roster.files) ? roster.files : []
  const readOnly = roster.readOnly === true
  const opened = id ? files.find(file => file.id === id) : undefined
  if (id && opened === undefined) {
    return h('div', { className: 'bt-file-panel' },
      h('div', { className: 'bt-set-card bt-file-gone' },
        h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('This file is no longer available.')))))
  }
  if (opened) {
    return h('div', { className: 'bt-file-panel' },
      h('div', { className: 'bt-file-toolbar' },
        h(FileMeta, { file: opened, roster }),
        readOnly ? null : h(DeleteButton, { onDelete: () => actions.deleteFile(opened.id).then(() => actions.openSettings('files')) })),
      h(FilePreview, { file: opened, actions, readOnly }))
  }
  if (files.length === 0) {
    return h('div', { className: 'bt-file-panel' },
      h('div', { className: 'bt-set-card bt-file-empty' },
        h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' },
          t('No files yet. To add one, tell a Bot in its chat to save a document, image, or other file you will come back to.')))))
  }
  return h('div', { className: 'bt-file-panel' }, h(FileList, { files, roster, actions, readOnly }))
}

// Opens Settings → Files when a Bot calls open_file.
export function useFileOpen(useRoster, actions) {
  const open = useRoster(value => value.fileOpen ?? null)
  const seen = useRef(0)
  useEffect(() => {
    if (open?.at > seen.current && open.id) {
      seen.current = open.at
      actions.openSettings('files', open.id)
    }
  }, [open?.at, open?.id])
}
