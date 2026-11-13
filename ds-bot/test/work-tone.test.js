import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillPath = join(root, 'src/host/skills/goal-grill/SKILL.md')
const computerPath = join(root, 'src/host/computer/index.js')
const goalsPath = join(root, 'src/host/goals.js')

const TALK_RULES = [
  '## How you talk to the user',
  '- Match the size of the work in how you speak: a small change is a small change. Do not describe a minor fix as if it were a large project.',
  '- Use the same words the user used for the task (for example 爬视频 or 上传到自己账号). Do not swap in labels they did not use, such as 安全 or 台账, or other jargon that does not match what they asked for.',
  '- Still do any check the work actually needs. Describe it in the user\'s terms, not those mismatched labels.',
  '- Say where the work is happening in words the user can see: which window, which page, and what you are doing there. Do not use internal tool names, code names, or other labels they would not recognize on screen.',
]

const ALLOWED_SAFETY_ZH = [
  /账号与安全/,
  /安全设置/,
  /登录与安全/,
  /未能安全停止/,
  /安全码/,
]

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

function skillText() {
  return readFileSync(skillPath, 'utf8')
}

function goalsText() {
  return readFileSync(goalsPath, 'utf8')
}

function computerText() {
  return readFileSync(computerPath, 'utf8')
}

test('planning guidance advances complete stages and does not re-review small work', () => {
  const skill = skillText()
  const goals = goalsText()
  assert.match(skill, /each a complete slice of the outcome that can stand on its own/)
  assert.match(skill, /Do not break small work into many tiny stages, and do not add a review step for every small change/)
  assert.match(skill, /Do not pull ordinary small changes out for review again and again/)
  assert.match(skill, /Do not open extra review rounds for small changes/)
  assert.doesNotMatch(skill, /Give review work to a member who did not do the work/)
  assert.doesNotMatch(skill, /each small enough to check on its own/)
  assert.match(goals, /Advance by complete stages, not by splitting small work into many review rounds/)
  assert.match(goals, /Do not split small work into many tiny stages or repeated review steps/)
  assert.match(goals, /do not pull ordinary small changes out for review again and again/)
  assert.match(goals, /do not review ordinary small changes over and over/)
})

test('tone matches scale, uses the user\'s task language, and says where work is happening', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    const text = prompt(id)
    for (const rule of TALK_RULES) {
      assert.ok(text.split('\n').includes(rule), `${id} missing: ${rule}`)
      assert.equal(text.split(rule).length - 1, 1)
    }
    assert.match(text, /爬视频/)
    assert.match(text, /上传到自己账号/)
    assert.match(text, /台账/)
    assert.match(text, /安全/)
    assert.match(text, /which window, which page/)
  }
  assert.doesNotMatch(prompt('room'), /How you talk to the user|台账|爬视频/)
})

test('real checks for sending, paying, deleting and credentials stay', () => {
  const skill = skillText()
  const goals = goalsText()
  const computer = computerText()
  const check = /Still check before sending a message, paying, deleting something, or using someone else\\?'s account/
  assert.match(skill, /Still check before sending a message, paying, deleting something, or using someone else's account/)
  assert.match(goals, check)
  assert.match(goals, /check the results against the stage\\?'s "done when" yourself/)
  assert.match(goals, /Every stage passed\. Check the overall "done when"/)
  assert.match(goals, /Each stage is a complete slice of the outcome/)
  assert.match(computer, /Payments, typing passwords or one-time codes, and consequential actions \(sending, deleting, publishing, purchases\) go to the user/)
  assert.match(computer, /computer_handoff/)
})

test('Chinese UI copy does not use 台账, and 安全 only in genuine security contexts', () => {
  const badLedger = []
  const badSafety = []
  for (const [key, value] of Object.entries(DICTIONARY.zh)) {
    const text = String(value)
    if (text.includes('台账') || key.includes('台账')) badLedger.push(`${key}: ${text}`)
    if (text.includes('安全') && !ALLOWED_SAFETY_ZH.some(pattern => pattern.test(text))) {
      badSafety.push(`${key}: ${text}`)
    }
  }
  assert.deepEqual(badLedger, [])
  assert.deepEqual(badSafety, [])
})

test('crawl-and-upload guidance tells the Bot to keep the user\'s words and not invent 台账 or 安全', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const text = prompt('main')
  assert.match(text, /for example 爬视频 or 上传到自己账号/)
  assert.match(text, /Do not swap in labels they did not use, such as 安全 or 台账/)
  assert.match(text, /Still do any check the work actually needs/)
  // Goal templates must not inject those labels into a crawl-and-upload task.
  const goals = goalsText()
  const showAndDuty = [
    /function ledgerLines/,
    /function memberLines/,
    /const DUTY_ACTIVE/,
    /const DUTY_DRAFT/,
  ]
  for (const marker of showAndDuty) assert.match(goals, marker)
  assert.doesNotMatch(goals, /台账/)
  // 安全 must not appear as a canned goal label; the only 安全 in this change lives in the talk rules, not goals.js.
  assert.doesNotMatch(goals, /安全/)
})
