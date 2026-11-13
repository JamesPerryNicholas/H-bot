import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'
import { SUMMARY_SYSTEM, askSystem, memoryRules, reviewSystem, tidySystem } from '../src/host/memory-copy.js'

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
    '- When a next step is genuinely useful in your own chat — an obvious follow-up after you finished something, work the user already implied, or a stuck or incomplete task — call pitch_in once with what you would do, and write one short sentence of normal reply text before the call in the same response. That shows a card; wait for the user to accept. A suggestion is not permission: do not start that work, send messages, spend money, or delete anything until they accept. If nothing is clearly useful, stay quiet. Do not call pitch_in in a group chat or in a Bot-to-Bot turn, and do not suggest again until they send a new message.',
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

test('Main Bot self-execution rules yield to group admin delegation', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = prompt('main')
  assert.match(rules, /In your own chat, do the work yourself/)
  assert.match(rules, /In a group you administer, follow the group coordination rules instead/)
  assert.match(rules, /delegate suitable parts before executing them yourself/)
  assert.equal(prompt('group-worker'), prompt('worker'), 'the system prefix stays stable across private and group chats')
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
  assert.match(prompt('main'), /In your own chat, do the work yourself/)
  assert.match(prompt('main'), /Never end a user-facing turn with only a promise/)
  assert.doesNotMatch(prompt('worker'), /primary assistant/)
  assert.doesNotMatch(prompt('worker'), /In your own chat, do the work yourself/)
  assert.match(prompt('worker'), /Check files\./)
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('Bots get talk-to-user rules that match the size of the work and the user\'s words', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '## How you talk to the user',
    '- Match the size of the work in how you speak: a small change is a small change. Do not describe a minor fix as if it were a large project.',
    '- Use the same words the user used for the task (for example 爬视频 or 上传到自己账号). Do not swap in labels they did not use, such as 安全 or 台账, or other jargon that does not match what they asked for.',
    '- Still do any check the work actually needs. Describe it in the user\'s terms, not those mismatched labels.',
    '- Say where the work is happening in words the user can see: which window, which page, and what you are doing there. Do not use internal tool names, code names, or other labels they would not recognize on screen.',
  ]
  for (const id of ['main', 'worker', 'group-worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule), id + ' missing: ' + rule)
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.doesNotMatch(prompt('room'), /How you talk to the user/)
  assert.equal(prompt('outside'), '')
})

test('Bots get SSH rules only in Bot prompts, and must not claim the capability without the tools', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '## SSH to a remote server',
    '- Only when you have the ssh_connect, ssh_exec, ssh_read, ssh_write, ssh_upload, ssh_download, and ssh_disconnect tools may you tell the user you can connect to a remote server over SSH to edit code, run commands, transfer files, or deploy. If those tools are not available, do not say you can do that, and do not offer it.',
    '- When the user wants this, ask for the server address, the username, and the port if it is not 22. Then connect and do the work they asked for (run a command, edit or transfer a file, or deploy). Disconnect when the work is finished or they ask you to.',
    '- Never ask the user to type a password or a private key into the chat, and never pass one to a tool. Call request_secret so they enter it on a local card; then pass only the saved name as password_secret or key_secret (and passphrase_secret if the key has a passphrase). Use list_secrets to see names already saved. Secret cards only work in your own chat: in a group, say you will ask in your own chat and call it there.',
    '- Speak in the user\'s words: which server, which folder or file, and what you are doing there. The first time a server is reached, its identity is saved; if that identity changes later, refuse and tell the user.',
  ]
  for (const id of ['main', 'worker', 'group-worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule), id + ' missing: ' + rule)
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.doesNotMatch(prompt('room'), /SSH to a remote server/)
  assert.equal(prompt('outside'), '')
})

test('memory summaries and reviewers use the current application identity', () => {
  for (const text of [SUMMARY_SYSTEM, askSystem(false), askSystem(true), reviewSystem(), reviewSystem({ group: true }), tidySystem({ who: 'Chief', max: 100 })]) {
    assert.match(text, /H bot/)
    assert.doesNotMatch(text, /DS Bot|heng bot/)
  }
})

test('memory rules tell the Bot to apply standing preferences and not re-ask them', () => {
  for (const review of [true, false]) {
    assert.match(memoryRules(review), /do not ask the user to repeat what is already saved/)
    assert.match(memoryRules(review), /An entry marked standing is this kind/)
    assert.match(memoryRules(review), /standing profile facts belong there/)
  }
  assert.match(reviewSystem(), /"standing": true/)
  assert.match(reviewSystem({ group: true }), /"standing": true/)
  assert.match(tidySystem({ who: 'Chief', max: 100 }), /Never move a standing profile fact out of MEMORY.md/)
})
