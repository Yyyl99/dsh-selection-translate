/**
 * Offline render smoke test for the selection-translate browser half.
 *
 * The desktop client cannot be driven from a shell, so this test loads the real
 * `client.js` inside a tiny CommonJS shim with a fake React and a fake DOM,
 * drives the plugin store into each surface state, and calls the panel
 * component. A render crash (the kind that makes the card vanish and never
 * come back) fails the run instead of disappearing into the browser console.
 *
 * Run with: node scripts/render-test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const FRAGMENT = Symbol('fragment')

const React = {
  Fragment: FRAGMENT,
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useRef(value) {
    return { current: value }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  useLayoutEffect() {},
  useEffect() {},
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState() {}
  },
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag
    this.dataset = {}
    this.style = {}
    this.children = []
    this.textContent = ''
    this.isConnected = false
  }

  append(child) {
    this.children.push(child)
    child.isConnected = true
  }

  remove() {
    this.isConnected = false
  }

  closest() {
    return null
  }
}

const head = new FakeElement('head')
const document = {
  head,
  documentElement: new FakeElement('html'),
  body: new FakeElement('body'),
  createElement: tag => new FakeElement(tag),
  getElementById() {
    return null
  },
  addEventListener() {},
  removeEventListener() {},
  querySelector() {
    return null
  },
  elementFromPoint() {
    return null
  },
}

const storage = new Map()
const localStorage = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
}

let definition = null
const window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
  innerWidth: 1280,
  innerHeight: 900,
  devicePixelRatio: 1,
  localStorage,
  document,
  addEventListener() {},
  removeEventListener() {},
  getSelection() {
    return null
  },
  requestAnimationFrame() {
    return 0
  },
  cancelAnimationFrame() {},
  setTimeout,
  clearTimeout,
  getComputedStyle() {
    return { getPropertyValue: () => '' }
  },
}

const sandbox = {
  window,
  document,
  localStorage,
  React,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  AbortController,
  AbortSignal,
  Element: FakeElement,
  Node: FakeElement,
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: window.requestAnimationFrame,
  cancelAnimationFrame: window.cancelAnimationFrame,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

if (definition === null) throw new Error('client.js did not call __ModuleLoader__.load')
if (typeof definition.factory !== 'function') throw new Error('bundle has no factory')

const api = definition.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(name)})`)
})

const test = api.__test
if (test === undefined) throw new Error('bundle has no __test handles')

const t = key => key
const Surface = test.SelectionTranslateSlot

/** Render the slot surface and expand nested components (function or class). */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand).flat()
  if (typeof node !== 'object' || node.type === undefined) return node
  const { type, props, children } = node
  if (type === FRAGMENT) return children.map(expand).flat()
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.render) {
      const instance = new type({ ...props, children })
      instance.props = { ...props, children }
      return expand(instance.render())
    }
    return expand(type({ ...props, children }))
  }
  return { ...node, children: children.map(expand).flat() }
}

function render() {
  return expand(Surface({ t }))
}

/** Walk an element tree and collect every element. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node === 'object' && node.type !== undefined) {
    out.push(node)
    for (const child of node.children) walk(child, out)
  }
  return out
}

const classes = nodes => nodes.flatMap(node => (typeof node.props.className === 'string' ? node.props.className.split(/\s+/) : []))
const text = nodes => nodes.flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok - ${label}`)
    return
  }
  failures += 1
  console.log(`not ok - ${label}${detail === undefined ? '' : ` (${detail})`}`)
}

const base = { phase: 'idle', dot: null, targetMode: 'auto', target: 'zh-CN', text: '', loading: false, error: null, data: null, speaking: false, speakingText: null, voiceError: false }

// 1. idle renders nothing.
test.store.set(base)
check('idle surface renders nothing', walk(render()).length === 0)

// 2. dot surface.
test.store.set({ ...base, phase: 'dot', dot: { x: 200, y: 300 }, text: 'hello world' })
let nodes = walk(render())
check('dot surface has the round button', classes(nodes).includes('dst-dot'), classes(nodes).join(','))

// 3. panel while loading.
test.store.set({ ...base, phase: 'panel', dot: { x: 200, y: 300 }, text: 'hello world', loading: true })
nodes = walk(render())
check('loading panel renders the skeleton', classes(nodes).includes('dst-skel'), classes(nodes).join(','))
check('loading panel keeps the header', classes(nodes).includes('dst-head'))

// 3b. the first streamed half paints while the other is still running.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'Good morning',
  loading: true,
  data: { translation: '', provider: '', target: 'zh-CN', word: null },
})
nodes = walk(render())
check('a half answer shows the source immediately', text(nodes).includes('Good morning'), text(nodes))
check('a half answer keeps a shimmer where the translation will be', classes(nodes).includes('dst-skel'))

// 4. translated sentence panel.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'Good morning',
  data: { translation: '早上好', provider: 'bing', target: 'zh-CN', word: null },
})
nodes = walk(render())
check('sentence panel shows the translation', text(nodes).includes('早上好'), text(nodes))
check('sentence panel shows the provider', text(nodes).includes('Bing'), text(nodes))
check('sentence panel has no dictionary section', !classes(nodes).includes('dst-word-head'))

// 5. dictionary panel.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'serendipity',
  data: {
    translation: '机缘巧合',
    provider: 'bing',
    target: 'zh-CN',
    word: {
      headword: 'serendipity',
      phonetic: 'ˌserənˈdɪpəti',
      source: 'youdao',
      senses: [{ pos: 'n', defs: ['意外发现美好事物的运气', '机缘巧合'] }],
      examples: [{ en: 'Serendipity often visits the prepared mind.', zh: '机缘巧合常常降临有准备的人。', pos: 'noun' }],
    },
  },
})
nodes = walk(render())
check('dictionary panel shows the headword', text(nodes).includes('serendipity'), text(nodes))
check('dictionary panel shows the phonetic', text(nodes).includes('ˌserənˈdɪpəti'))
check('dictionary panel shows a sense', text(nodes).includes('意外发现美好事物的运气'))
check('dictionary panel shows an example', text(nodes).includes('有准备的人'))
check('dictionary panel shows the dictionary tag', text(nodes).includes('selectionTranslate.dictionary'))
check('a dictionary example carries no AI tag', !classes(nodes).includes('dst-ai'), classes(nodes).join(','))

test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'run',
  data: {
    translation: '跑；奔跑',
    provider: 'bing',
    target: 'zh-CN',
    word: {
      headword: 'run',
      phonetic: 'rʌn',
      source: 'youdao',
      senses: [{ pos: 'v', defs: ['跑'] }, { pos: 'n', defs: ['奔跑'] }],
      examples: [
        { en: 'I run every morning.', zh: '我每天早晨跑步。', pos: 'verb' },
        { en: 'He makes a run for the bus.', zh: '他跑着去赶公交车。', pos: 'noun', generated: true },
      ],
    },
  },
})
nodes = walk(render())
check('a model-written example is marked', classes(nodes).includes('dst-ai'), classes(nodes).join(','))
check('the generated sentence sits under its sense', text(nodes).includes('跑着去赶公交车'))
check('the dictionary example keeps its own line', text(nodes).includes('我每天早晨跑步'))

// 6. error panel.
test.store.set({ ...base, phase: 'panel', dot: { x: 200, y: 300 }, text: 'hello', error: 'NETWORK' })
nodes = walk(render())
check('error panel renders the alert', nodes.some(node => node.props.role === 'alert'))
check('error panel localizes the code', text(nodes).includes('selectionTranslate.errorNetwork'), text(nodes))

// 7. a word in a language pair without a dictionary target still renders.
test.store.set({
  ...base,
  phase: 'panel',
  target: 'en',
  targetMode: 'en',
  dot: { x: 10, y: 10 },
  text: '你好',
  data: { translation: 'Hello', provider: 'bing', target: 'en', word: null },
})
nodes = walk(render())
check('reverse direction panel renders', text(nodes).includes('Hello'))

// 8. a dot hidden by a scroll while the panel is open keeps the panel mounted.
test.store.set({
  ...base,
  phase: 'panel',
  dot: null,
  text: 'hello',
  data: { translation: '你好', provider: 'bing', target: 'zh-CN', word: null },
})
check('panel without dot renders nothing instead of crashing', walk(render()).length === 0)


// 9. English source row offers reading, the Chinese translation does not.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'Good morning',
  data: { translation: '早上好', provider: 'bing', target: 'zh-CN', word: null },
})
nodes = walk(render())
let says = nodes.filter(node => node.props.className === 'dst-say')
check('english source gets one speaker', says.length === 1, `says=${says.length}`)
check('sentence mode shows source and translation', text(nodes).includes('Good morning') && text(nodes).includes('早上好'), text(nodes))
check('sentence panel is titled', text(nodes).includes('selectionTranslate.panelTitle'), text(nodes))

// 10. Chinese source with an English translation speaks the translation.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: '早上好',
  target: 'en',
  data: { translation: 'Good morning', provider: 'bing', target: 'en', word: null },
})
nodes = walk(render())
says = nodes.filter(node => node.props.className === 'dst-say')
check('english translation gets one speaker', says.length === 1, `says=${says.length}`)
check('speaker is not pressed while idle', says[0].props['aria-pressed'] === false)

// 11. the active speaker switches to the stop icon.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: '早上好',
  target: 'en',
  speaking: true,
  speakingText: 'Good morning',
  data: { translation: 'Good morning', provider: 'bing', target: 'en', word: null },
})
nodes = walk(render())
says = nodes.filter(node => node.props.className === 'dst-say')
check('active speaker is pressed', says.length === 1 && says[0].props['aria-pressed'] === true)
check('active speaker shows the stop glyph', classes(nodes).includes('dst-square'), classes(nodes).join(','))

// 12. the card is an opaque panel with a caret pointing at the dot.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'Good morning',
  data: { translation: '早上好', provider: 'bing', target: 'zh-CN', word: null },
})
nodes = walk(render())
const panel = nodes.find(node => typeof node.props.className === 'string' && node.props.className.startsWith('dst-panel'))
check('panel renders with the caret offset', panel !== undefined && typeof panel.props.style['--dst-caret-x'] === 'string', JSON.stringify(panel === undefined ? null : panel.props.style))
check('panel has no header speaker', !classes(nodes).includes('dst-icon'), classes(nodes).join(','))
check('panel keeps a close button', classes(nodes).includes('dst-close'))
// The stylesheet lives outside the component tree; assert it on the module export.
check('stylesheet declares an opaque card', test.css.includes('background-color:var(--dsw-alias-bg-base'), 'css missing')
check('stylesheet draws the caret', test.css.includes('.dst-panel::before'), 'css missing')
check('examples sit in one grouped block', /\.dst-examples{[^}]*background:/.test(test.css) && /\.dst-ex\+\.dst-ex{border-top/.test(test.css), 'css missing')
check('panel content has its own padded body', test.css.includes('.dst-body{padding:'), 'css missing')
check('part of speech sits inline with its sense', /.dst-sense{display:flex/.test(test.css), 'css missing')

// 13. a word keeps both the dictionary entry and the translation.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'serendipity',
  data: {
    translation: '意外发现美好事物的运气',
    provider: 'bing',
    target: 'zh-CN',
    word: {
      headword: 'serendipity',
      phonetic: 'ˌserənˈdɪpəti',
      source: 'youdao',
      senses: [{ pos: 'n', defs: ['意外发现美好事物的运气'] }],
      examples: [],
    },
  },
})
nodes = walk(render())
check('word panel drops the machine gloss once senses exist', !classes(nodes).includes('dst-gloss'), classes(nodes).join(','))
check('word senses render as blocks', classes(nodes).includes('dst-sense-block'), classes(nodes).join(','))
check('word head keeps its speaker', nodes.filter(node => node.props.className === 'dst-say').length === 1)

// 13b. an example carrying a part of speech sits under that sense.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'serendipity',
  data: {
    translation: '意外发现美好事物的运气',
    provider: 'bing',
    target: 'zh-CN',
    word: {
      headword: 'serendipity',
      phonetic: 'ˌserənˈdɪpəti',
      source: 'youdao',
      senses: [{ pos: 'n', defs: ['意外发现美好事物的运气'] }],
      examples: [{ en: 'This is the kind of serendipity you want!', zh: '这正是你想要的机缘巧合！', pos: 'noun' }],
    },
  },
})
nodes = walk(render())
check('examples attach to the sense they illustrate', nodes.filter(node => node.props.className === 'dst-examples dst-examples--inline').length === 1, classes(nodes).join(','))
check('attached examples keep their translation', nodes.some(node => node.props.className === 'dst-ex-zh'))

// 13c. a word the dictionary only translates keeps the gloss line.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'diagKey',
  data: {
    translation: '诊断键',
    provider: 'bing',
    target: 'zh-CN',
    word: { headword: 'diagKey', phonetic: '', source: 'youdao', senses: [], examples: [] },
  },
})
nodes = walk(render())
check('word without senses falls back to the machine gloss', classes(nodes).includes('dst-gloss'), classes(nodes).join(','))


// 14. code identifiers fall back to a part glossary.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'diagKey',
  data: {
    translation: '诊断键',
    provider: 'bing',
    target: 'zh-CN',
    word: null,
    parts: [{ word: 'diag', meaning: '诊断，判断' }, { word: 'key', meaning: '钥匙' }],
  },
})
nodes = walk(render())
check('identifier shows part chips', nodes.filter(node => node.props.className === 'dst-chip').length === 2, classes(nodes).join(','))
check('identifier chips are labelled', text(nodes).includes('selectionTranslate.parts'), text(nodes))

// 15. examples highlight the headword and the card never clips its caret.
test.store.set({
  ...base,
  phase: 'panel',
  dot: { x: 200, y: 300 },
  text: 'cordis',
  data: {
    translation: '',
    provider: 'bing',
    target: 'zh-CN',
    word: {
      headword: 'cordis',
      phonetic: 'ˈkɔːrdɪs',
      source: 'youdao',
      senses: [{ pos: 'n', defs: ['虚构的运行时环境'] }],
      examples: [{ en: 'The Cordis runtime runs plugins.', zh: 'Cordis 运行时运行插件。', pos: 'noun' }],
    },
  },
})
nodes = walk(render())
check('examples highlight the headword', nodes.some(node => node.props.className === 'dst-hl'), classes(nodes).join(','))
check('caret is not clipped by the panel', !/\.dst-panel\{[^}]*overflow:hidden/.test(test.css), 'panel clips the caret')
if (failures > 0) {
  console.log(`\n${failures} render check(s) failed`)
  process.exit(1)
}
console.log('\nall render checks passed')
