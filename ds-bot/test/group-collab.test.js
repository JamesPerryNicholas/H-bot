import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignedIn, calledIn, isGroupWideAsk, isSelfClaim, isStatusReport, shouldStayOut } from '../src/host/group-collab.js'

const members = [
  { id: 'chief', name: 'Chief' },
  { id: 'writer', name: 'Writer' },
  { id: 'editor', name: 'Editor' },
  { id: 'h', name: 'H bot' },
  { id: 'h2', name: 'H bot2' },
  { id: 'h3', name: 'H bot3' },
]
const names = ({ all, found }) => ({ all, found: found.map(member => member.name) })

test('assignedIn finds a bare-name assignment at the start of a sentence', () => {
  assert.deepEqual(names(assignedIn('Writer, please update the README', members)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(assignedIn('Writer：改一下文档', members)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(assignedIn('H bot3 请把现有群聊做扎实。', members)), { all: false, found: ['H bot3'] })
  assert.deepEqual(names(assignedIn('请 Editor 改测试', members)), { all: false, found: ['Editor'] })
  assert.deepEqual(names(assignedIn('交给 Writer 来处理文档', members)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(assignedIn('have Writer handle the docs', members)), { all: false, found: ['Writer'] })
})

test('assignedIn finds more than one assignee in one message', () => {
  assert.deepEqual(names(assignedIn('Writer 来改文档，Editor 来写测试', members)), { all: false, found: ['Writer', 'Editor'] })
  assert.deepEqual(names(assignedIn('H bot2 请做「越用越熟」。H bot3 请做群聊协作。', members)), { all: false, found: ['H bot2', 'H bot3'] })
})

test('assignedIn does not treat a passing mention as an assignment', () => {
  assert.deepEqual(names(assignedIn('I agree with Writer', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('don\'t change what Writer did', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('Writer already posted the same status', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('Count off', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('hello everyone', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('like Writer said yesterday', members)), { all: false, found: [] })
})

test('assignedIn skips @mentions, code, and reference labels', () => {
  assert.deepEqual(names(assignedIn('@Writer please update the README', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('see `Writer please fix` in the log', members)), { all: false, found: [] })
  assert.deepEqual(names(assignedIn('Read @Writer notes. Editor 来写测试', members, [{ labels: ['Writer notes'] }])), { all: false, found: ['Editor'] })
})

test('calledIn unions @mentions with bare-name assignments', () => {
  assert.deepEqual(names(calledIn('@Writer please update, Editor 来写测试', members)), { all: false, found: ['Writer', 'Editor'] })
  assert.deepEqual(names(calledIn('@all count off', members)), { all: true, found: [] })
  assert.deepEqual(names(calledIn('@H bot3 请做群聊', members)), { all: false, found: ['H bot3'] })
  assert.deepEqual(names(calledIn('H bot3 请做群聊', members)), { all: false, found: ['H bot3'] })
})

test('isSelfClaim detects a member taking the work', () => {
  assert.equal(isSelfClaim('我来改文档'), true)
  assert.equal(isSelfClaim('我先核对一下桌面版。'), true)
  assert.equal(isSelfClaim('仓库这边我来合。'), true)
  assert.equal(isSelfClaim("I'll take the group-chat work."), true)
  assert.equal(isSelfClaim('I will handle the docs.'), true)
  assert.equal(isSelfClaim('I got this.'), true)
  assert.equal(isSelfClaim('one'), false)
  assert.equal(isSelfClaim('I like Orion'), false)
  assert.equal(isSelfClaim('我来了，稍等。'), false)
  assert.equal(isSelfClaim('Writer here.'), false)
})

test('isStatusReport detects a finished-work or already-checked status', () => {
  assert.equal(isStatusReport('品牌替换已经合进 main。'), true)
  assert.equal(isStatusReport('我核对过了：默认已经改成 medium。'), true)
  assert.equal(isStatusReport("It's done, already on main."), true)
  assert.equal(isStatusReport('I checked the desktop install.'), true)
  assert.equal(isStatusReport('one'), false)
  assert.equal(isStatusReport('I think blue is better.'), false)
})

test('shouldStayOut auto-passes later ordered speakers after a claim or status report', () => {
  const writer = { id: 'writer', name: 'Writer', ordered: true, status: 'waiting' }
  const editor = { id: 'editor', name: 'Editor', ordered: true, status: 'waiting' }
  assert.equal(shouldStayOut(writer, { replies: [], everyone: members, openingText: '改一下文档' }), false)
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: '我来改文档' }],
    everyone: members,
    openingText: '改一下文档',
  }), true)
  assert.equal(shouldStayOut(editor, {
    replies: [{ name: 'Chief', text: '已经合进 main 了。' }],
    everyone: members,
    openingText: '仓库地址改成我的',
  }), true)
})

test('shouldStayOut keeps a count-off or discussion going', () => {
  const writer = { id: 'writer', name: 'Writer', ordered: true, status: 'waiting' }
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: 'one' }],
    everyone: members,
    openingText: 'Count off',
  }), false)
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: 'I like Orion' }],
    everyone: members,
    openingText: 'What should we name this?',
  }), false)
})

test('shouldStayOut still lets a named or handed-off member answer', () => {
  const writer = { id: 'writer', name: 'Writer', ordered: true, status: 'waiting' }
  const editor = { id: 'editor', name: 'Editor', ordered: true, status: 'waiting' }
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: '我先看一下' }],
    everyone: members,
    openingText: 'Writer, please update the README',
  }), false)
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: '@Writer 请改文档' }],
    everyone: members,
    openingText: '改一下文档',
  }), false)
  assert.equal(shouldStayOut(editor, {
    replies: [{ name: 'Chief', text: '@Writer 请改文档' }],
    everyone: members,
    openingText: '改一下文档',
  }), true)
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: 'one' }],
    everyone: members,
    openingText: '@all count off',
  }), false)
})

test('shouldStayOut ignores non-waiting slots', () => {
  assert.equal(shouldStayOut({ id: 'writer', name: 'Writer', ordered: true, status: 'speaking' }, {
    replies: [{ text: '我来改文档' }],
    everyone: members,
    openingText: '改一下文档',
  }), false)
  assert.equal(shouldStayOut({ id: 'writer', name: 'Writer', ordered: false, status: 'waiting' }, {
    replies: [{ text: '我来改文档' }],
    everyone: members,
    openingText: '改一下文档',
  }), false)
})


test('isGroupWideAsk detects a count-off or group check-in', () => {
  for (const text of ['都说收到', '在的扣1', '在的扣 1', '在的打1', '大家都说说', '各位都回一下', '全员报到', '报数', 'Count off', 'count-off', 'everyone check in', 'Check in', 'say received']) {
    assert.equal(isGroupWideAsk(text), true, text)
  }
})

test('isGroupWideAsk detects a question that addresses the group in the second-person plural', () => {
  for (const text of [
    '你们知道是先有鸡还是先有蛋吗？',
    '你们觉得呢？',
    '你们怎么看？',
    '各位怎么看？',
    '大家觉得呢？',
    '你们谁知道这是怎么回事',
    'do you all know which came first?',
    'what do you all think about this?',
  ]) {
    assert.equal(isGroupWideAsk(text), true, text)
  }
})

test('isGroupWideAsk ignores ordinary questions and passing mentions of everyone', () => {
  for (const text of ['这个怎么用？', '你看你的api还剩多少钱', 'What is the status of the docs?', 'Writer, what do you think?', 'Search it, all of you', 'hello everyone', 'please check in the repo', 'Start', '改一下文档', 'What should we name this?']) {
    assert.equal(isGroupWideAsk(text), false, text)
  }
})

test('shouldStayOut does not auto-pass later members on a group-wide check-in', () => {
  const writer = { id: 'writer', name: 'Writer', ordered: true, status: 'waiting' }
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: '收到' }],
    everyone: members,
    openingText: '都说收到',
  }), false)
  assert.equal(shouldStayOut(writer, {
    replies: [{ name: 'Chief', text: '我来改文档' }],
    everyone: members,
    openingText: '在的扣1',
  }), false)
})
