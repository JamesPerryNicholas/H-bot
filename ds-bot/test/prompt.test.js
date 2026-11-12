import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'
import { SUMMARY_SYSTEM, askSystem, reviewSystem, tidySystem } from '../src/host/memory-copy.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
    '- An opening status sentence is not the result. Before you end a user-facing turn, send the answer, file, or card the user is waiting for, or say clearly what is still blocked.',
    '- For a direct question, lead with the answer in the first sentence, then add only what the user needs next.',
    '- When the user wants a reminder or work that should run at a time or on a repeating schedule, call schedule_create in this chat (target this_session). Confirm the name, what it will do, and when it will run; do not only promise to remember. Use schedule_list to avoid adding a duplicate, and schedule_edit to change or stop a task the user names. If those tools are unavailable, tell the user and point them to Settings → Scheduled tasks.',
    '- When the user wants to connect an outside service, or you need one that is not connected, call list_connectors first, then request_connector with its id and a short purpose so a Connect card appears in this chat. Do not only send them to Settings. Connector cards only work in your own chat: in a group, say you will ask in your own chat and call it there. If the service is already connected, use its tools. If those tools are unavailable, tell the user and point them to Settings → Connectors.',
    '- When the user wants a report, dashboard, or a page they will come back to, call save_page, then show_view, and tell them it is in Pages. Use list_pages to avoid saving a duplicate, save_page with id to update one, open_page to reopen one, and delete_page only when they ask to remove it. If those tools are unavailable, tell the user and point them to Settings → Pages.',
    '- When the user wants to keep a file, document, or image to open later, call save_file, then tell them it is in Files. Use list_files to avoid saving a duplicate, save_file with id to replace one, open_file to reopen one, and delete_file only when they ask to remove it. If those tools are unavailable, tell the user and point them to Settings → Files.',
    '- When the user wants to keep a way of working as a reusable skill, call propose_skill with a short name, a one-sentence description of when to use it, and the full instructions. That shows a card in this chat; the skill is saved only if the user approves it. Use list_capabilities first to avoid proposing a duplicate; if a skill with that name already exists and should be updated, pass action "update". If propose_skill is unavailable, tell the user and point them to Settings → Capabilities.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('current product identity reaches Main Bots, members and their group sessions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    assert.match(prompt(id), /a Bot on the user's team in H bot\./)
    assert.match(prompt(id), /older names in imported chat history or data paths/)
    assert.doesNotMatch(prompt(id), /DS Bot|heng bot/)
  }
  assert.match(prompt('main'), /You are Chief/)
  assert.match(prompt('main'), /Chief of Staff/)
  assert.match(prompt('main'), /primary assistant/)
  assert.match(prompt('main'), /Do the work yourself/)
  assert.match(prompt('main'), /Never end a user-facing turn with only a promise/)
  assert.doesNotMatch(prompt('worker'), /primary assistant/)
  assert.doesNotMatch(prompt('worker'), /Do the work yourself/)
  assert.match(prompt('worker'), /Check files\./)
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('memory summaries and reviewers use the current application identity', () => {
  for (const text of [SUMMARY_SYSTEM, askSystem(false), askSystem(true), reviewSystem(), reviewSystem({ group: true }), tidySystem({ who: 'Chief', max: 100 })]) {
    assert.match(text, /H bot/)
    assert.doesNotMatch(text, /DS Bot|heng bot/)
  }
})
