import test from 'node:test'
import assert from 'node:assert/strict'
import { checkShownView } from 'deep-view/core'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { MAX_PAGES, TITLE_MAX, deletePage, openPage, pagesView, savePage } from '../src/host/pages.js'

const candidates = [
  { type: 'markdown', markdown: 'Hello' },
  { type: 'markdown', text: 'Hello' },
  { markdown: 'Hello' },
  { type: 'text', text: 'Hello' },
  { type: 'doc', blocks: [{ type: 'markdown', markdown: 'Hello' }] },
  { kind: 'markdown', markdown: 'Hello' },
  { view: { type: 'markdown', body: 'Hello' } },
]

function validView() {
  const errors = []
  for (const view of candidates) {
    const checked = checkShownView('Title', view)
    if (checked.error === undefined) return checked.view
    errors.push(`${JSON.stringify(view)} => ${checked.error}`)
  }
  throw new Error('no valid view fixture:\n' + errors.join('\n'))
}

test('page tools are on the team tool list', () => {
  for (const name of ['save_page', 'list_pages', 'open_page', 'delete_page']) {
    assert.ok(TEAM_TOOLS.includes(name), name)
  }
})

test('save_page creates, lists, updates, opens, and deletes a page', () => {
  const state = { pages: {} }
  const view = validView()
  const created = savePage(state, { title: '  Weekly report  ', view, botId: 'bot-1' })
  assert.equal(created.error, undefined)
  assert.equal(created.created, true)
  assert.equal(created.page.title, 'Weekly report')
  assert.equal(created.page.botId, 'bot-1')
  assert.ok(created.page.id)
  assert.deepEqual(pagesView(state).map(page => page.id), [created.page.id])

  const updated = savePage(state, { title: 'Weekly report v2', view, id: created.page.id, botId: 'bot-2' })
  assert.equal(updated.error, undefined)
  assert.equal(updated.created, false)
  assert.equal(updated.page.title, 'Weekly report v2')
  assert.equal(updated.page.botId, 'bot-2')
  assert.ok(updated.page.updatedAt >= created.page.createdAt)

  const opened = openPage(state, created.page.id)
  assert.equal(opened.error, undefined)
  assert.equal(state.pageOpen.id, created.page.id)
  assert.ok(state.pageOpen.at)

  const removed = deletePage(state, created.page.id)
  assert.equal(removed.error, undefined)
  assert.equal(pagesView(state).length, 0)
  assert.equal(state.pageOpen, null)
})

test('save_page rejects a bad title or view, a missing id, and a full list', () => {
  const view = validView()
  assert.equal(savePage({ pages: {} }, { title: '   ', view }).error !== undefined, true)
  assert.equal(savePage({ pages: {} }, { title: 'A', view: { not: 'a view' } }).error !== undefined, true)
  assert.match(savePage({ pages: {} }, { title: 'A', view, id: 'missing' }).error, /No page/)

  const state = { pages: {} }
  for (let i = 0; i < MAX_PAGES; i++) {
    const result = savePage(state, { title: `Page ${i}`, view, botId: 'bot' })
    assert.equal(result.error, undefined, result.error)
  }
  const full = savePage(state, { title: 'One more', view, botId: 'bot' })
  assert.match(full.error, new RegExp(String(MAX_PAGES)))
  const firstId = pagesView(state).at(-1).id
  const updated = savePage(state, { title: 'Renamed', view, id: firstId })
  assert.equal(updated.error, undefined)
  assert.equal(updated.page.title, 'Renamed')
})

test('a long title is trimmed to the limit', () => {
  const view = validView()
  const title = 'N'.repeat(TITLE_MAX + 20)
  const result = savePage({ pages: {} }, { title, view })
  assert.equal(result.page.title.length, TITLE_MAX)
})

test('delete_page and open_page report a missing id', () => {
  const state = { pages: {} }
  assert.match(deletePage(state, 'missing').error, /No page/)
  assert.match(openPage(state, 'missing').error, /No page/)
})
