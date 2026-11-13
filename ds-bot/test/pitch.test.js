import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { historyEntry, questionReply, replyText } from '../src/host/parts.js'
import { REPLY_KIND } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'
import {
  PITCH_ACCEPT,
  PITCH_DECLINE,
  PITCH_TOOL,
  PITCH_WHY_MAX,
  PITCH_WORK_MAX,
  buildPitchQuestion,
  clipPitch,
  isPitchAccept,
  isPitchDecline,
  noteUserSpokeState,
  openPitchState,
  pitchCardText,
  pitchProblem,
  pitchReplyText,
  settlePitchState,
} from '../src/shared/pitch.js'

test('pitch_in is on the team tool list', () => {
  assert.ok(TEAM_TOOLS.includes(PITCH_TOOL))
})

test('pitchProblem allows a clear suggestion and refuses the rest', () => {
  const base = { work: 'Update the desktop shortcut to the new build.', isGroup: false, isBotChat: true }
  assert.equal(pitchProblem(base), undefined)
  assert.match(pitchProblem({ ...base, work: '   ' }), /one or two short sentences/)
  assert.match(pitchProblem({ ...base, work: 'x'.repeat(PITCH_WORK_MAX + 1) }), /400/)
  assert.match(pitchProblem({ ...base, why: 'y'.repeat(PITCH_WHY_MAX + 1) }), /200/)
  assert.match(pitchProblem({ ...base, isGroup: true }), /own chat/)
  assert.match(pitchProblem({ ...base, isBotChat: false }), /Only Bots/)
  assert.match(pitchProblem({ ...base, hiddenExchange: true }), /Bot-to-Bot/)
  assert.match(pitchProblem({ ...base, openQuestion: { id: 'q1' } }), /already waiting/)
  assert.match(pitchProblem({ ...base, pitchState: { pendingId: 'p1' } }), /already waiting/)
  assert.match(pitchProblem({ ...base, pitchState: { pitchedSinceUserMsg: true } }), /already made a suggestion/)
  assert.equal(pitchProblem({ ...base, pitchState: { lastOutcome: 'declined' } }), undefined)
})

test('buildPitchQuestion fills a question card the user can accept or decline', () => {
  const question = buildPitchQuestion({
    work: '  Draft the follow-up email.  ',
    why: ' You already asked for a draft after this. ',
    callId: 'call-1',
    hidden: false,
    id: 'p1',
    now: 10,
  })
  assert.equal(question.kind, 'pitch')
  assert.equal(question.work, 'Draft the follow-up email.')
  assert.equal(question.question, 'Draft the follow-up email.')
  assert.equal(question.detail, 'You already asked for a draft after this.')
  assert.equal(question.callId, 'call-1')
  assert.equal(question.allowCustom, true)
  assert.deepEqual(question.options.map(option => option.label), [PITCH_ACCEPT, PITCH_DECLINE])
  assert.equal(buildPitchQuestion({ work: 'Do it', callId: 'call-1', hidden: true, id: 'p2', now: 11 }).callId, undefined)
})

test('accept and decline are decided only from the card answer', () => {
  const question = buildPitchQuestion({ work: 'Do the follow-up.', id: 'p1', now: 1 })
  assert.equal(isPitchAccept(question, { selected: [PITCH_ACCEPT] }), true)
  assert.equal(isPitchDecline(question, { selected: [PITCH_DECLINE] }), true)
  assert.equal(isPitchAccept(question, { selected: [PITCH_DECLINE] }), false)
  assert.equal(isPitchDecline(question, { selected: [PITCH_ACCEPT] }), false)
  assert.equal(isPitchAccept(question, { selected: [], custom: 'Only write the outline.' }), true)
  assert.equal(isPitchDecline(question, { selected: [PITCH_DECLINE], custom: 'Only write the outline.' }), false)
  assert.equal(isPitchAccept({ kind: 'ask' }, { selected: [PITCH_ACCEPT] }), false)
})

test('pitch state keeps one suggestion until the user writes again', () => {
  const opened = openPitchState(undefined, 'p1', 'Do the follow-up.', 5)
  assert.equal(opened.pendingId, 'p1')
  assert.equal(opened.pitchedSinceUserMsg, true)
  const declined = settlePitchState(opened, 'declined', 6)
  assert.equal(declined.pendingId, undefined)
  assert.equal(declined.lastOutcome, 'declined')
  assert.equal(declined.pitchedSinceUserMsg, true)
  const spoke = noteUserSpokeState(declined, 7)
  assert.equal(spoke.pitchedSinceUserMsg, undefined)
  assert.equal(spoke.userSpokeAt, 7)
  const replied = settlePitchState(opened, 'replied', 8)
  assert.equal(replied.pitchedSinceUserMsg, undefined)
})

test('pitchCardText and pitchReplyText tell the model what was accepted', () => {
  assert.equal(pitchCardText({ work: 'Update the shortcut.' }), '[Suggestion] Update the shortcut.')
  assert.equal(pitchCardText({ work: 'Update the shortcut.', why: 'The current one is stale.' }), '[Suggestion] Update the shortcut. (The current one is stale.)')
  const question = buildPitchQuestion({ work: 'Update the shortcut.', id: 'p1', now: 1 })
  assert.match(pitchReplyText(question, { selected: [PITCH_ACCEPT] }), /only this work: Update the shortcut/)
  assert.match(pitchReplyText(question, { selected: [PITCH_ACCEPT] }), /not permission/)
  assert.match(pitchReplyText(question, { custom: 'Only update the icon.' }), /with this change: Only update the icon/)
  assert.equal(clipPitch('  trimmed  ', 10), 'trimmed')
})

test('history and reply text treat a pitch like a question card', () => {
  const entry = historyEntry({
    type: 'tool/call',
    data: { name: PITCH_TOOL, arguments: { work: 'Update the shortcut.', why: 'The current one is stale.' } },
  }, false)
  assert.equal(entry.answer, true)
  assert.equal(entry.text, '[Suggestion] Update the shortcut. (The current one is stale.)')
  const question = buildPitchQuestion({ work: 'Update the shortcut.', id: 'p1', now: 1 })
  const reply = questionReply(question, { selected: [PITCH_ACCEPT] })
  assert.equal(reply.source.kind, REPLY_KIND)
  const asked = JSON.parse(reply.text).questions[0]
  assert.equal(asked.kind, 'pitch')
  assert.equal(asked.work, 'Update the shortcut.')
  assert.match(replyText(reply.text), /Accepted suggestion/)
  assert.match(replyText(reply.text), /only this work: Update the shortcut/)
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 } },
  rooms: {
    r1: { id: 'r1', name: 'Team', members: ['m1'], sessions: { m1: 'room-m1' }, createdAt: 1 },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  pitches: {},
}

function start(team = TEAM) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-pitch-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const followups = []
  const created = []
  Object.assign(ctx, {
    sessions: { flush: async () => {} },
    sessionController: {
      create: async (options) => {
        created.push(options)
        return { sessionId: `s${created.length}` }
      },
      resolveAgent: async (sessionId) => ({
        agent: {
          session: { id: sessionId },
          followup(message) { followups.push(message) },
          ctx: {
            tools: { register: () => () => {}, restrict: () => () => {} },
            effect: execute => execute(),
          },
        },
      }),
      selectModel: async () => {},
      prompt: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async (path) => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const tool = name => rt.teamTools.find(item => item.name === name)
  const exec = (id = 'm1', extras = {}) => {
    const concluded = { on: false }
    return { agent: { id }, concludeTurn: () => { concluded.on = true }, concluded, ...extras }
  }
  const speak = (sessionId) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      listener({ id: sessionId }, { type: 'user/message', data: { source: { kind: 'user' } } })
    }
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, tool, exec, speak, followups, stop, home }
}

test('pitch_in shows one card and waits for the user', async (t) => {
  const { rt, tool, exec, followups, stop } = start()
  t.after(stop)
  const run = exec('m1', { callId: 'call-1' })
  const result = await tool(PITCH_TOOL).execute({ work: 'Update the desktop shortcut.', why: 'The current one still points at the old build.' }, run)
  assert.match(result, /suggestion is on screen/)
  assert.equal(run.concluded.on, true)
  const question = rt.state.questions.m1
  assert.equal(question.kind, 'pitch')
  assert.equal(question.work, 'Update the desktop shortcut.')
  assert.equal(question.callId, 'call-1')
  assert.equal(rt.state.pitches.m1.pendingId, question.id)
  assert.equal(followups.length, 0)

  const again = await tool(PITCH_TOOL).execute({ work: 'Also rewrite the README.' }, exec('m1'))
  assert.match(again, /already waiting/)

  const declined = await rt.answerQuestion('m1', question.id, { selected: [PITCH_DECLINE] })
  assert.equal(declined, true)
  assert.equal(rt.state.questions.m1, undefined)
  assert.equal(rt.state.pitches.m1.lastOutcome, 'declined')
  assert.equal(rt.state.pitches.m1.pendingId, undefined)
  assert.equal(followups.length, 0)
})

test('accepting a suggestion starts only that work; declining stays quiet', async (t) => {
  const { rt, tool, exec, speak, followups, stop } = start()
  t.after(stop)
  const first = exec('m1', { callId: 'call-2' })
  await tool(PITCH_TOOL).execute({ work: 'Update the desktop shortcut.' }, first)
  const id = rt.state.questions.m1.id
  const accepted = await rt.answerQuestion('m1', id, { selected: [PITCH_ACCEPT] })
  assert.equal(accepted, true)
  assert.equal(followups.length, 1)
  const payload = JSON.parse(followups[0].content[0].text)
  assert.equal(payload.questions[0].kind, 'pitch')
  assert.equal(rt.state.pitches.m1.lastOutcome, 'accepted')
  assert.equal(rt.state.pitches.m1.pitchedSinceUserMsg, true)
  assert.match(await tool(PITCH_TOOL).execute({ work: 'Write a short recap next.' }, exec('m1')), /already made a suggestion/)
  speak('m1')
  const next = await tool(PITCH_TOOL).execute({ work: 'Write a short recap next.' }, exec('m1', { callId: 'call-3' }))
  assert.match(next, /suggestion is on screen/)
})

test('pitch_in stays in the Bot\'s own chat and yields to an open card', async (t) => {
  const { rt, tool, exec, stop } = start()
  t.after(stop)
  assert.match(await tool(PITCH_TOOL).execute({ work: 'Ping the group.' }, exec('room-m1')), /own chat/)
  const ask = exec('m1', { callId: 'ask-1' })
  await tool('ask_user').execute({ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, ask)
  assert.equal(rt.state.questions.m1.kind, undefined)
  assert.match(await tool(PITCH_TOOL).execute({ work: 'Do the follow-up.' }, exec('m1')), /already waiting/)
  delete rt.state.questions.m1
  rt.live.set('m1', { turn: 4 })
  rt.state.exchangeTurns.m1 = [4]
  assert.match(await tool(PITCH_TOOL).execute({ work: 'Do the follow-up.' }, exec('m1')), /Bot-to-Bot/)
})

test('ask_user will not replace a waiting suggestion', async (t) => {
  const { rt, tool, exec, stop } = start()
  t.after(stop)
  await tool(PITCH_TOOL).execute({ work: 'Update the desktop shortcut.' }, exec('m1', { callId: 'call-4' }))
  const before = rt.state.questions.m1.id
  const result = await tool('ask_user').execute({ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }, exec('m1'))
  assert.match(result, /suggestion is already waiting/)
  assert.equal(rt.state.questions.m1.id, before)
})
