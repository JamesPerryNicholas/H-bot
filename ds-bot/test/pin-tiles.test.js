import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { pinnedEntriesOf, listedEntriesOf, flagsForPinDrop, flagsForListDrop } from '../src/client/pin-grid.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

test('pinned entries leave the wide list and stay in the rail list', () => {
  const order = [
    { kind: 'bot', item: { id: 'gpt', pinned: true } },
    { kind: 'bot', item: { id: 'notes', pinned: false } },
    { kind: 'room', item: { id: 'room-1', pinned: true } },
  ]
  assert.deepEqual(pinnedEntriesOf(order).map(e => e.item.id), ['gpt', 'room-1'])
  assert.deepEqual(listedEntriesOf(order, true).map(e => e.item.id), ['notes'])
  assert.deepEqual(listedEntriesOf(order, false).map(e => e.item.id), ['gpt', 'notes', 'room-1'])
})

test('dropping onto the pin grid pins a chat and ignores the main bot', () => {
  const loose = { item: { id: 'gpt', pinned: false } }
  assert.deepEqual(flagsForPinDrop({ id: 'gpt', mainBotId: 'chief', entry: loose }), { pinned: true })
  assert.equal(flagsForPinDrop({ id: 'chief', mainBotId: 'chief', entry: loose }), null)
  assert.equal(flagsForPinDrop({ id: 'gpt', mainBotId: 'chief', entry: { item: { id: 'gpt', pinned: true } } }), null)
  assert.equal(flagsForPinDrop({ id: null, mainBotId: 'chief', entry: loose }), null)
})

test('dropping a pinned tile back on the list unpins it and can set a section', () => {
  const pinned = { item: { id: 'gpt', pinned: true, sectionId: 'sec-1' } }
  assert.deepEqual(flagsForListDrop({ secId: null, entry: pinned }), { sectionId: null, pinned: false })
  assert.deepEqual(flagsForListDrop({ secId: 'sec-2', entry: pinned }), { sectionId: 'sec-2', pinned: false })
  assert.deepEqual(flagsForListDrop({ secId: 'sec-1', entry: { item: { id: 'notes' } } }), { sectionId: 'sec-1' })
})

const { outputFiles } = await build({
  stdin: {
    contents: "export { TeamSidebar } from './src/client/sidebar.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useLayoutEffect() {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useId: () => 'id',
}
const mod = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: mod,
  exports: mod.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
  window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  document: { body: {}, documentElement: { hasAttribute: () => false }, addEventListener() {}, removeEventListener() {} },
})
const { TeamSidebar } = mod.exports

test('TeamSidebar shows pinned chats as tiles in the top grid, not as pinned list rows', () => {
  const chief = { id: 'chief', name: 'Chief', role: 'Lead', createdAt: 1 }
  const gpt = { id: 'gpt', name: 'GPT', pinned: true, createdAt: 2 }
  const notes = { id: 'notes', name: 'Notes', createdAt: 3 }
  const room = { id: 'room-1', name: 'Design', pinned: true, members: ['gpt', 'notes'], createdAt: 4 }
  const roster = {
    mainBotId: 'chief',
    mainBotIds: ['chief'],
    bots: [chief, gpt, notes],
    rooms: [room],
    sections: [],
    byId: { chief, gpt, notes },
    roomsById: { 'room-1': room },
    agentsById: {},
    exchangeTurns: {},
    ready: true,
  }
  const tree = TeamSidebar({
    actions: { openSession: id => id, openAgent: id => id, openAgentSession: id => id, newAgentSession: id => id, reportError() {} },
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread: {} }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: ['chief', 'gpt', 'notes', 'room-1'], byId: {} }),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: (_id, pick) => pick({}),
    useActivity: pick => pick({}),
    useWork: pick => pick({}),
    useUpdate: () => ({}),
  })

  const tiles = []
  const rows = []
  let grid = false
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type !== react.Fragment) {
      walk(node.type(node.props ?? {}))
      return
    }
    const cls = node.props?.className
    if (cls === 'bt-pin-grid') grid = true
    const id = node.props?.['data-bot-id'] || node.props?.['data-room-id']
    if (id && (cls === 'bt-tile' || cls === 'bt-row')) {
      ;(cls === 'bt-tile' ? tiles : rows).push(id)
    }
    walk(node.props?.children)
  }
  walk(tree)
  assert.equal(grid, true)
  assert.deepEqual(tiles.slice().sort(), ['chief', 'gpt', 'room-1'])
  assert.deepEqual(rows.slice().sort(), ['notes'])
})

test('the wide list is a drop target so a pinned tile can be dragged back and unpinned', () => {
  const chief = { id: 'chief', name: 'Chief', createdAt: 1 }
  const gpt = { id: 'gpt', name: 'GPT', pinned: true, createdAt: 2 }
  const notes = { id: 'notes', name: 'Notes', createdAt: 3 }
  const roster = {
    mainBotId: 'chief',
    mainBotIds: ['chief'],
    bots: [chief, gpt, notes],
    rooms: [],
    sections: [],
    byId: { chief, gpt, notes },
    roomsById: {},
    agentsById: {},
    exchangeTurns: {},
    ready: true,
  }
  const flagged = []
  const tree = TeamSidebar({
    actions: {
      openSession: id => id, openAgent: id => id, openAgentSession: id => id, newAgentSession: id => id,
      reportError() {},
      setFlags: (id, patch) => flagged.push([id, patch]),
    },
    useRoster: pick => pick(roster),
    useUi: pick => pick({ unread: {} }),
    useRegistry: pick => pick({}),
    useSessions: pick => pick({ ids: ['chief', 'gpt', 'notes'], byId: {} }),
    useSessionStatus: pick => pick(new Map()),
    useSessionRetainInfo: (_id, pick) => pick({}),
    useActivity: pick => pick({}),
    useWork: pick => pick({}),
    useUpdate: () => ({}),
  })
  let zone = null
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'function' && node.type !== react.Fragment) {
      walk(node.type(node.props ?? {}))
      return
    }
    if (node.props?.className === 'bt-list-loose') zone = node
    walk(node.props?.children)
  }
  walk(tree)
  assert.ok(zone, 'wide list without sections must still be a drop zone')
  assert.equal(typeof zone.props.onDrop, 'function')
  assert.equal(typeof zone.props.onDragOver, 'function')
  const event = { preventDefault() {}, dataTransfer: { getData: () => 'gpt', dropEffect: 'move' } }
  zone.props.onDrop(event)
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0][0], 'gpt')
  assert.equal(flagged[0][1].pinned, false)
  assert.equal(flagged[0][1].sectionId, null)
})
