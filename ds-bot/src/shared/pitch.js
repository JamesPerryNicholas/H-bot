// Pitch-in: a Bot may suggest one piece of follow-up work and must wait for the
// user to accept before starting it. Shared by the host tool and the question card.
export const PITCH_TOOL = 'pitch_in'
export const PITCH_ACCEPT = 'Go ahead'
export const PITCH_DECLINE = 'Not this time'
export const PITCH_WORK_MAX = 400
export const PITCH_WHY_MAX = 200

export const clipPitch = (value, max) => String(value ?? '').trim().slice(0, max)

export const isPitchAccept = (question, answer) => {
  if (question?.kind !== 'pitch') return false
  const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  if (custom !== '') return true
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  return selected.includes(PITCH_ACCEPT) && !selected.includes(PITCH_DECLINE)
}

export const isPitchDecline = (question, answer) => {
  if (question?.kind !== 'pitch') return false
  const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  if (custom !== '') return false
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  return selected.includes(PITCH_DECLINE) && !selected.includes(PITCH_ACCEPT)
}

export function pitchProblem({ work, why, isGroup, isBotChat, hiddenExchange, openQuestion, pitchState } = {}) {
  if (isGroup) return 'Pitch-in only works in your own chat. In a group, suggest it in your message instead.'
  if (!isBotChat) return 'Only Bots on the team can use pitch_in.'
  if (hiddenExchange) return 'Pitch-in is for the user. Do not suggest work in a Bot-to-Bot turn.'
  const trimmed = clipPitch(work, PITCH_WORK_MAX)
  if (trimmed === '') return 'Say what you would do, in one or two short sentences.'
  if (String(work ?? '').trim().length > PITCH_WORK_MAX) return `Keep the work to ${PITCH_WORK_MAX} characters.`
  if (why !== undefined && why !== null && String(why).trim().length > PITCH_WHY_MAX) return `Keep the reason to ${PITCH_WHY_MAX} characters.`
  if (openQuestion !== undefined) return 'A card is already waiting in this chat. Wait for the user to answer it first.'
  if (pitchState?.pendingId) return 'A suggestion is already waiting in this chat.'
  if (pitchState?.pitchedSinceUserMsg) {
    return 'You already made a suggestion since the user last wrote. Wait until they send a new message before suggesting again.'
  }
  return undefined
}

export function buildPitchQuestion({ work, why, callId, hidden, id, now } = {}) {
  const trimmed = clipPitch(work, PITCH_WORK_MAX)
  const reason = clipPitch(why, PITCH_WHY_MAX)
  return {
    id,
    kind: 'pitch',
    work: trimmed,
    question: trimmed,
    ...(reason ? { why: reason, detail: reason } : {}),
    options: [
      { label: PITCH_ACCEPT, description: 'Start this work now.' },
      { label: PITCH_DECLINE, description: 'Leave it until the user asks.' },
    ],
    allowCustom: true,
    askedAt: now,
    ...(callId && !hidden ? { callId } : {}),
  }
}

export function pitchCardText(args) {
  const work = clipPitch(args?.work ?? args?.question, PITCH_WORK_MAX)
  if (work === '') return ''
  const why = clipPitch(args?.why ?? args?.detail, PITCH_WHY_MAX)
  return why ? `[Suggestion] ${work} (${why})` : `[Suggestion] ${work}`
}

export function pitchReplyText(question, answer) {
  const work = clipPitch(question?.work ?? question?.question, PITCH_WORK_MAX)
  const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  const task = custom !== '' ? custom : work
  if (task === '') return '[Accepted suggestion] The user accepted. Do only the work you suggested, and nothing else that would send messages, spend money, or delete things unless that work already needs it.'
  if (custom !== '') {
    return `[Accepted suggestion] The user accepted, with this change: ${custom}\nDo this work now, and only this work. A suggestion is not permission to send messages, spend money, or delete things beyond what this work needs.`
  }
  return `[Accepted suggestion] The user accepted.\nDo this work now, and only this work: ${work}. A suggestion is not permission to send messages, spend money, or delete things beyond what this work needs.`
}

export function askedPitchOf(question, args) {
  const work = clipPitch(question?.work ?? question?.question ?? args?.work ?? args?.question, PITCH_WORK_MAX)
  const why = clipPitch(question?.why ?? question?.detail ?? args?.why ?? args?.detail, PITCH_WHY_MAX)
  return {
    kind: 'pitch',
    question: work,
    work,
    ...(why ? { detail: why, why } : {}),
    options: [
      { label: PITCH_ACCEPT, description: 'Start this work now.' },
      { label: PITCH_DECLINE, description: 'Leave it until the user asks.' },
    ],
    allowCustom: true,
  }
}

export function settlePitchState(current, outcome, now = Date.now()) {
  const next = { ...current }
  delete next.pendingId
  next.lastOutcome = outcome
  next.lastAt = now
  if (outcome === 'replied') delete next.pitchedSinceUserMsg
  return next
}

export function noteUserSpokeState(current, now = Date.now()) {
  const next = { ...current }
  delete next.pitchedSinceUserMsg
  next.userSpokeAt = now
  return next
}

export function openPitchState(current, pendingId, work, now = Date.now()) {
  return {
    ...current,
    pendingId,
    lastWork: work,
    lastAt: now,
    pitchedSinceUserMsg: true,
  }
}
