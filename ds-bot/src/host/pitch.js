// Pitch-in: a Bot suggests one piece of follow-up work as a question card and
// waits for the user to accept. The suggestion is not permission to start the work.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'
import { questionReply } from './parts.js'
import {
  PITCH_TOOL,
  buildPitchQuestion,
  isPitchAccept,
  isPitchDecline,
  noteUserSpokeState,
  openPitchState,
  pitchProblem,
  settlePitchState,
} from '../shared/pitch.js'

export function install(rt) {
  const { ctx, state } = rt

  const pitchesOf = () => {
    if (state.pitches === null || typeof state.pitches !== 'object' || Array.isArray(state.pitches)) state.pitches = {}
    return state.pitches
  }
  const pitchOf = sessionId => (Object.hasOwn(pitchesOf(), sessionId) ? state.pitches[sessionId] : undefined)
  const writePitch = (sessionId, entry) => {
    const table = pitchesOf()
    if (entry === undefined) delete table[sessionId]
    else table[sessionId] = entry
  }

  const hiddenTurn = (id) => {
    const turn = rt.live?.get(id)?.turn
    return turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn)
  }

  rt.teamTools.push(defineTool({
    name: PITCH_TOOL,
    description: 'Suggest one piece of follow-up work and wait for the user to accept. Use this only when a next step is genuinely useful: an obvious next step after finishing something, a follow-up the user already implied, or a stuck or incomplete task. Calling it shows a card and ends your turn. Do not start the work, send messages, spend money, or delete anything until they accept. At most one suggestion until the user sends a new message. If nothing is clearly useful, do not call this.',
    parameters: {
      work: { type: 'string', required: true, description: 'What you would do, in one or two short sentences' },
      why: { type: 'string', description: 'Optional one sentence on why this is useful now' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const problem = pitchProblem({
        work: args.work,
        why: args.why,
        isGroup: rt.groupOwners.has(id),
        isBotChat: rt.chatOwners.has(id),
        hiddenExchange: hiddenTurn(id),
        openQuestion: rt.own(state.questions, id),
        pitchState: pitchOf(id),
      })
      if (problem !== undefined) return problem
      const question = buildPitchQuestion({
        work: args.work,
        why: args.why,
        callId: exec.callId,
        hidden: false,
        id: randomUUID(),
        now: Date.now(),
      })
      state.questions[id] = question
      writePitch(id, openPitchState(pitchOf(id), question.id, question.work, question.askedAt))
      await rt.save()
      exec.concludeTurn?.()
      return 'The suggestion is on screen. Do not start the work until the user accepts. Their answer arrives as their next message.'
    },
  }))

  const closeCard = rt.closeCard
  if (typeof closeCard === 'function') {
    rt.closeCard = (sessionId, card, outcome) => {
      const pending = pitchOf(sessionId)
      if (card?.kind === 'pitch' && pending?.pendingId === card.id) {
        writePitch(sessionId, settlePitchState(pending, outcome === 'replied' ? 'replied' : 'dismissed'))
      }
      return closeCard(sessionId, card, outcome)
    }
  }

  const answerQuestion = rt.answerQuestion
  if (typeof answerQuestion === 'function') {
    rt.answerQuestion = async (sessionRef, questionId, answer) => {
      await rt.load()
      const past = rt.pastOwners.get(sessionRef)
      const sessionId = rt.botOf(sessionRef) ? rt.chatOf(sessionRef) : past && past.roomId === undefined ? rt.chatOf(past.botId) : sessionRef
      const question = rt.own(state.questions, sessionId)
      if (question?.kind === 'pitch' && question.id === questionId) {
        if (questionReply(question, answer) === undefined) {
          throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
        }
        if (isPitchDecline(question, answer)) {
          delete state.questions[sessionId]
          writePitch(sessionId, settlePitchState(pitchOf(sessionId), 'declined'))
          closeCard(sessionId, question, 'dismissed')
          await rt.save()
          return true
        }
        const result = await answerQuestion(sessionRef, questionId, answer)
        if (isPitchAccept(question, answer)) {
          writePitch(sessionId, settlePitchState(pitchOf(sessionId), 'accepted'))
          await rt.save()
        }
        return result
      }
      return answerQuestion(sessionRef, questionId, answer)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    const source = event.data?.source
    if (source?.kind !== 'user') return
    const id = session?.id ?? session
    if (typeof id !== 'string') return
    writePitch(id, noteUserSpokeState(pitchOf(id)))
  })

  Object.assign(rt, { pitchesOf, pitchOf })
}
