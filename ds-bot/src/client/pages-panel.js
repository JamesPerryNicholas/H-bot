import { createElement as h, useEffect, useRef, useState } from 'react'
import { ViewCard } from './widget-cell.js'
import { PageIcon, TrashIcon } from './icons.js'
import { BotAvatar } from './mark.js'
import { t } from './i18n.js'

export const PAGES_CSS = `
.bt-page-panel{display:flex;flex-direction:column;gap:12px;min-height:0}
.bt-page-empty{padding:16px 18px}
.bt-page-row{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:10px 12px;border:0;border-bottom:1px solid var(--bt-line);background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-page-row:last-child{border-bottom:0}
.bt-page-row:hover{background:var(--bt-hover)}
.bt-page-row .bt-page-mark{flex:none}
.bt-page-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-page-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-page-view{min-height:120px;padding:4px 2px 16px}
.bt-page-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-page-meta{color:var(--bt-ink-2);font-size:12px}
.bt-page-gone{padding:16px 4px}
`

const goneName = () => t('A removed Bot')

function whenText(ms) {
  if (!ms) return ''
  try { return new Date(ms).toLocaleString() } catch { return '' }
}

function PageMeta({ page, roster }) {
  const bot = page.botId ? roster.byId?.[page.botId] : undefined
  const who = page.botId ? (bot ? t('Saved by {name}', { name: bot.name }) : goneName()) : ''
  const updated = t('Updated {time}', { time: whenText(page.updatedAt) })
  return h('span', { className: 'bt-page-meta' }, [who, updated].filter(Boolean).join(' · '))
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
    'aria-label': confirming ? t('Click again to delete') : t('Delete page'),
    title: confirming ? undefined : t('Delete page'),
    onClick: remove,
  }, confirming ? t('Delete') : h(TrashIcon))
}

function PageList({ pages, roster, actions, readOnly }) {
  return h('div', { className: 'bt-set-card' },
    pages.map(page => {
      const bot = page.botId ? roster.byId?.[page.botId] : undefined
      return h('div', { key: page.id, className: 'bt-set-row', style: { display: 'flex', alignItems: 'center', gap: 8, padding: 0 } },
        h('button', { type: 'button', className: 'bt-page-row', onClick: () => actions.openSettings('pages', page.id) },
          h('span', { className: 'bt-page-mark', 'aria-hidden': true },
            bot ? h(BotAvatar, { bot, size: 18, badge: false, live: false }) : h(PageIcon)),
          h('span', { className: 'bt-page-copy' },
            h('span', { className: 'bt-page-title' }, page.title),
            h(PageMeta, { page, roster }))),
        readOnly ? null : h(DeleteButton, { onDelete: () => actions.deletePage(page.id) }))
    }))
}

export function PagesPage({ roster, actions, id }) {
  const pages = Array.isArray(roster.pages) ? roster.pages : []
  const readOnly = roster.readOnly === true
  const opened = id ? pages.find(page => page.id === id) : undefined
  if (id && opened === undefined) {
    return h('div', { className: 'bt-page-panel' },
      h('div', { className: 'bt-set-card bt-page-gone' },
        h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('This page is no longer available.')))))
  }
  if (opened) {
    return h('div', { className: 'bt-page-panel' },
      h('div', { className: 'bt-page-toolbar' },
        h(PageMeta, { page: opened, roster }),
        readOnly ? null : h(DeleteButton, { onDelete: () => actions.deletePage(opened.id).then(() => actions.openSettings('pages')) })),
      h('div', { className: 'bt-page-view' }, h(ViewCard, { title: opened.title, view: opened.view, raised: true })))
  }
  if (pages.length === 0) {
    return h('div', { className: 'bt-page-panel' },
      h('div', { className: 'bt-set-card bt-page-empty' },
        h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' },
          t('No pages yet. To add one, tell a Bot in its chat to save a report, dashboard, or page you will come back to.')))))
  }
  return h('div', { className: 'bt-page-panel' }, h(PageList, { pages, roster, actions, readOnly }))
}

// Opens Settings → Pages when a Bot calls open_page.
export function usePageOpen(useRoster, actions) {
  const open = useRoster(value => value.pageOpen ?? null)
  const seen = useRef(0)
  useEffect(() => {
    if (open?.at > seen.current && open.id) {
      seen.current = open.at
      actions.openSettings('pages', open.id)
    }
  }, [open?.at, open?.id])
}
