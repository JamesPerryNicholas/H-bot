// Saved pages: a view the user can reopen later, not only see once in chat.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkShownView } from 'deep-view/core'
import { output } from './tools.js'

export const MAX_PAGES = 40
export const TITLE_MAX = 80

const TITLE_OF = (title) => String(title ?? '').trim().slice(0, TITLE_MAX)

export function pagesView(state) {
  return Object.values(state.pages ?? {}).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function savePage(state, { title, view, id, botId }) {
  const checked = checkShownView(title, view)
  if (checked.error !== undefined) return { error: checked.error }
  const name = TITLE_OF(checked.title || title)
  if (name === '') return { error: 'A page needs a title.' }
  state.pages ??= {}
  const now = Date.now()
  if (id) {
    const existing = state.pages[id]
    if (existing === undefined) return { error: `No page with id ${id}.` }
    existing.title = name
    existing.view = checked.view
    existing.updatedAt = now
    if (botId) existing.botId = botId
    return { page: existing, created: false }
  }
  if (Object.keys(state.pages).length >= MAX_PAGES) {
    return { error: `The team already has ${MAX_PAGES} pages. Delete one before saving another, or update an existing page by id.` }
  }
  const page = { id: randomUUID(), title: name, view: checked.view, botId: botId ?? null, createdAt: now, updatedAt: now }
  state.pages[page.id] = page
  return { page, created: true }
}

export function deletePage(state, id) {
  const page = state.pages?.[id]
  if (page === undefined) return { error: `No page with id ${id}.` }
  delete state.pages[id]
  if (state.pageOpen?.id === id) state.pageOpen = null
  return { page }
}

export function openPage(state, id) {
  const page = state.pages?.[id]
  if (page === undefined) return { error: `No page with id ${id}.` }
  state.pageOpen = { id, at: Date.now() }
  return { page }
}

const listText = (state) => {
  const rows = pagesView(state)
  if (rows.length === 0) return 'No pages yet.'
  return ['Pages:', ...rows.map(page => `- ${page.title} (${page.id}) — updated ${new Date(page.updatedAt).toISOString()}`)].join('\n')
}

export function install(rt) {
  const { state } = rt

  rt.pagesView = () => pagesView(state)
  rt.pageEndpoint = async (endpoint, body) => {
    if (endpoint === 'page-delete') {
      const id = String(body?.id ?? '').trim()
      const result = deletePage(state, id)
      if (result.error) throw Object.assign(new Error(result.error), { code: 'bot/invalid' })
      await rt.save()
      return { ok: true, id }
    }
    throw Object.assign(new Error('Unknown page action'), { code: 'bot/invalid' })
  }

  rt.teamTools.push(defineTool({
    name: 'list_pages',
    description: 'List the saved pages the user can reopen: title, id, and when each was last updated. Save or update one with save_page, reopen one with open_page, and remove one with delete_page.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_pages.'
      return listText(state)
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'save_page',
    description: 'Save a page the user can reopen later (a report, dashboard, or other view they will come back to). Use the same view blueprint as show_view. Pass id to update an existing page from list_pages. After saving, show it in this chat with show_view and tell the user it is in Pages.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title shown in Pages' },
      view: { type: 'object', required: true, additionalProperties: true, description: 'The view blueprint, same as show_view' },
      id: { type: 'string', description: 'Existing page id to update; omit to create a new page' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (bot === undefined) return 'Only Bots on the team can use save_page.'
      const result = savePage(state, { title: args.title, view: args.view, id: args.id ? String(args.id).trim() : undefined, botId: bot.id })
      if (result.error) return result.error
      await rt.save()
      return result.created
        ? `Saved "${result.page.title}" (${result.page.id}). It is in Pages. Show it in this chat with show_view, and tell the user they can reopen it from Pages in the account menu or under Settings → Pages.`
        : `Updated "${result.page.title}" (${result.page.id}). Show the new view in this chat with show_view if the user should see it now.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'open_page',
    description: 'Open a saved page for the user in Pages. Use an id from list_pages when they ask to reopen a page.',
    parameters: {
      id: { type: 'string', required: true, description: 'Page id from list_pages' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use open_page.'
      const result = openPage(state, String(args.id ?? '').trim())
      if (result.error) return result.error
      await rt.save()
      return `Opening "${result.page.title}" in Pages for the user.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'delete_page',
    description: 'Delete a saved page. Use only when the user asks to remove that page.',
    parameters: {
      id: { type: 'string', required: true, description: 'Page id from list_pages' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use delete_page.'
      const result = deletePage(state, String(args.id ?? '').trim())
      if (result.error) return result.error
      await rt.save()
      return `Deleted "${result.page.title}".`
    },
  }))
}
