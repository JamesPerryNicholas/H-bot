// Group collaboration helpers: who a message assigns work to (even without "@"),
// and when a later member in an ordered round should stay silent because
// someone already claimed the work, handed it off, or reported the same status.
import { mentionSpans, referenceSpans } from '../shared/mentions.js'

const LITERAL = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i
const ADDRESS_BEFORE = /[a-z0-9_./]/i
const SENTENCE_BEFORE = /(?:^|[.。!！?？;；,，、\n])[\s"'“”‘’]*$/
const ASSIGN_BEFORE = /(?:^|[^\u3400-\u9fff])(?:请让|请|让|交给|由|派给|assign(?:ed|ing)?(?:\s+this)?\s+to|hand(?:ing)?\s+(?:this\s+)?(?:off\s+)?to|give\s+(?:this\s+)?to|please\s+(?:have\s+)?)\s*$/i
const WEAK_BEFORE = /(?:have)\s*$/i
const ASSIGN_AFTER = /^\s*(?:[,，:：]\s*)?(?:你来|来(?:做|改|合|处理|负责|核对|看|查|接手|写|干)?|去(?:做|改|处理|写)|负责|接手|请(?:把|来|做|改)?|把\S+|please\b|should\b|shall\b|can you\b|could you\b|would you\b|take\b|handle\b|do\b|work on\b|own this\b|you(?:'re| are) on\b|update\b|fix\b|check\b|write\b|review\b|look\b|search\b|merge\b|改|做|核对|处理|合|看一下|查一下)/i
const SELF_CLAIM = /(?:这[个项份]?我来|交给我|让我来|我来(?!了|晚)(?:做|改|合|处理|负责|核对|看|查|接手|写|干|办|吧)?|我(?:先)?(?:来)?(?:负责|接手|去(?:做|改|处理)|核对|看一下|查一下)|(?:^|[\s。.!！,，])(?:I(?:['’]ll| will| can)\s+(?:do|take|handle|check|fix|update|look|work|own)|I(?:['’]m| am)(?:\s+going\s+to|\s+gonna)\s+(?:do|take|handle|check)|I(?:['’]ve)?\s+got\s+this|leave(?:ing)?\s+(?:this|it|that)\s+to\s+me)\b)/i
const STATUS_REPORT = /已经(?:写进|写好|改好|改成|合进|合到|完成|处理好|核对过|更新|做好)|核对过了|我核对过了?|已经在.{0,24}(?:写|改|合)|(?:it['’]s|it is)\s+done\b|already\s+(?:on\s+)?(?:main|done|fixed|updated|merged)\b|I(?:['’]ve| have)\s+(?:already\s+)?(?:checked|verified|confirmed|fixed|updated|merged|done|written)\b|I\s+checked\b/i

const labelList = references => (references ?? []).flatMap(reference => reference.labels ?? [])

const skippedSpans = (text, references) => [
  ...[...text.matchAll(LITERAL)].map(match => ({ start: match.index, end: match.index + match[0].length })),
  ...referenceSpans(text, labelList(references)),
]

const overlaps = (spans, start, end) => spans.some(span => start < span.end && span.start < end)

const whoOf = bot => bot.id ?? bot.name

export function mentionsOfText(text, members, references = []) {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: labelList(references) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

// Bare-name assignments: "Writer, please fix this", "请 Editor 改文档", "H bot3 来做群聊".
// "@Name" is a call, not a bare assignment; calledIn unions both.
export function assignedIn(text, members, references = []) {
  const value = String(text ?? '')
  const skip = skippedSpans(value, references)
  const byLength = members.filter(bot => bot?.name).sort((a, b) => b.name.length - a.name.length)
  const hits = []
  const lower = value.toLowerCase()
  for (const bot of byLength) {
    const needle = bot.name.toLowerCase()
    let at = 0
    while (at < lower.length) {
      const start = lower.indexOf(needle, at)
      if (start === -1) break
      const end = start + bot.name.length
      const before = start > 0 ? value[start - 1] : ''
      if (
        (start > 0 && (before === '@' || ADDRESS_BEFORE.test(before) || /[a-z0-9_\-]/i.test(before)))
        || NAME_GOES_ON.test(value.slice(end))
        || overlaps(skip, start, end)
        || overlaps(hits, start, end)
      ) {
        at = start + 1
        continue
      }
      hits.push({ start, end, bot })
      at = end
    }
  }
  const found = []
  for (const hit of hits.sort((a, b) => a.start - b.start)) {
    const prefix = value.slice(0, hit.start)
    const suffix = value.slice(hit.end)
    if (ASSIGN_BEFORE.test(prefix) || ((SENTENCE_BEFORE.test(prefix) || WEAK_BEFORE.test(prefix)) && ASSIGN_AFTER.test(suffix))) {
      if (!found.includes(hit.bot)) found.push(hit.bot)
    }
  }
  return { all: false, found }
}

// A cheap, no-model check for a plain message that clearly wants more than one
// voice: a count-off, a group check-in, or a request that addresses every member
// in the second-person plural (你们, 各位怎么看, do you all…). A lone singular 你
// is not group-wide. @all is handled separately by calledIn / openingCall.
const GROUP_WIDE = [
  /都说收到|都[回说]收到|收到请(?:回|回复)|请(?:大家|各位|全员)(?:都)?(?:回|说|回复)/,
  /在的[扣打＋+加]\s*1|在的\s*扣\s*1/,
  /大家都|各位都|每个人都|每人都|全员/,
  /报数|点名(?:回|答|报)?|都来(?:说|回|答|报|讲|发言)|都回(?:一?下|复)|都发言/,
  /你们/,
  /各位(?:觉得|怎么看|怎么想|认为|知道|谁|有谁|看法)/,
  /大家(?:觉得|怎么看|怎么想|认为|知道|谁|有谁|看法)/,
  /\bdo you all\b/i,
  /\bwhat do you all\b/i,
  /\bhow do you all\b/i,
  /\bdo you guys\b/i,
  /\bwhat do you guys\b/i,
  /\bhow do you guys\b/i,
  /\bcount[-\s]?off\b/i,
  /\broll[-\s]?call\b/i,
  /\b(?:everyone|everybody)\s+(?:say|check\s*in|chime\s*in|report\s*in|answer|speak|reply)\b/i,
  /\ball\s+(?:say|check\s*in|chime\s*in|report\s*in)\b/i,
  /^(?:please\s+)?(?:everyone\s+|everybody\s+|all\s+)?(?:check\s*in|chime\s*in|say\s+(?:received|here|present))\s*[.。!！]?$/i,
]

export function isGroupWideAsk(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  return GROUP_WIDE.some(pattern => pattern.test(value))
}

export function calledIn(text, members, references = []) {
  const mentioned = mentionsOfText(text, members, references)
  const assigned = assignedIn(text, members, references)
  const found = [...mentioned.found]
  for (const bot of assigned.found) if (!found.includes(bot)) found.push(bot)
  return { all: mentioned.all, found }
}

export const isSelfClaim = text => SELF_CLAIM.test(` ${String(text ?? '').trim()}`)
export const isStatusReport = text => STATUS_REPORT.test(String(text ?? ''))

function isDirectedHandoff(text, members, self) {
  const called = calledIn(text, members)
  if (called.all) return false
  return called.found.some(bot => whoOf(bot) !== self)
}

function addresses(text, members, self) {
  const called = calledIn(text, members)
  if (called.all) return true
  return called.found.some(bot => whoOf(bot) === self)
}

// A waiting ordered slot stays out when earlier posts in this round already claimed
// the work, reported the same status, or handed the work to someone else. A member
// the opening message or a later post called by name (or @all) still answers.
export function shouldStayOut(slot, { replies = [], everyone = [], openingText = '' } = {}) {
  if (!slot?.ordered || (slot.status !== undefined && slot.status !== 'waiting')) return false
  const self = whoOf(slot)
  if (addresses(openingText, everyone, self) || isGroupWideAsk(openingText)) return false
  for (const reply of replies) {
    if (reply.kind !== undefined && reply.kind !== 'user') continue
    if (addresses(reply.text ?? '', everyone, self)) return false
  }
  const posts = replies.filter(reply => reply.kind === undefined && String(reply.text ?? '').trim() !== '')
  return posts.some(reply => isSelfClaim(reply.text) || isStatusReport(reply.text) || isDirectedHandoff(reply.text, everyone, self))
}
