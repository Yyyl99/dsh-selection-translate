/**
 * Offline checks for the modules that talk to the network and to child
 * processes. `fetch` and `spawn` are replaced, so nothing here leaves the
 * machine; the assertions pin down the behaviours that broke before.
 *
 * Run: node scripts/lib-test.mjs
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lookupWord, primaryDef } from '../lib/dictionary.js'
import { createExampleWriter, fitCandidates, parseAligned } from '../lib/examples.js'
import { createLookupHandler } from '../lib/route.js'
import { createSpeaker } from '../lib/tts.js'
import { createDebugHandler } from '../lib/debug.js'

let failures = 0
let count = 0

/**
 * Record one assertion.
 * @param {boolean} condition - assertion result.
 * @param {string} label - what was checked.
 * @returns {void}
 */
function check(condition, label) {
  count += 1
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures += 1
    console.log(`not ok - ${label}`)
  }
}

/**
 * Substitute the global fetch for the duration of one callback.
 * @param {(url: URL, init: RequestInit) => Response} handler - replacement.
 * @param {() => Promise<void>} run - body to execute.
 * @returns {Promise<void>} resolves after the original fetch is restored.
 */
async function withFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => handler(input instanceof URL ? input : new URL(String(input)), init ?? {})
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Build the Youdao payload that has senses but no usable example.
 * @returns {object} payload.
 */
function youdaoWithoutExamples() {
  return {
    ec: {
      word: [
        {
          'return-phrase': 'abseil',
          usphone: 'ˈæpzaɪl',
          trs: [{ tr: [{ l: { i: 'v. 沿绳下降' } }] }],
          blng_sents_part: { 'sentence-pair': [] },
        },
      ],
    },
  }
}

/**
 * Build the open-dictionary payload with one short example.
 * @returns {object[]} payload.
 */
function freedictWithExample() {
  return [
    {
      word: 'abseil',
      phonetic: '/ˈæpzaɪl/',
      meanings: [
        {
          partOfSpeech: 'verb',
          definitions: [
            { definition: 'descend a cliff by rope', example: 'They abseil down the cliff.' },
          ],
        },
      ],
    },
  ]
}

const translate = async (request) => ({ translation: `译:${request.text}`, provider: 'bing', target: request.target })

// 1. The fallback runs on its own clock, so a slow primary cannot starve it.
await withFetch((url) => {
  if (String(url).includes('youdao')) {
    return new Response(JSON.stringify(youdaoWithoutExamples()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify(freedictWithExample()), { status: 200, headers: { 'content-type': 'application/json' } })
}, async () => {
  const entry = await lookupWord('abseil', { translate, timeoutMs: 2500 })
  check(entry !== null && entry.examples.length === 1, 'a word without primary examples borrows the fallback example')
  check(entry !== null && entry.senses.length === 1 && entry.senses[0].defs[0] === '沿绳下降', 'primary senses survive the merge')
})

// 2. A dead primary still yields a dictionary entry.
await withFetch((url) => {
  if (String(url).includes('youdao')) return new Response('nope', { status: 500 })
  return new Response(JSON.stringify(freedictWithExample()), { status: 200, headers: { 'content-type': 'application/json' } })
}, async () => {
  const entry = await lookupWord('abseil', { translate, timeoutMs: 800 })
  check(entry !== null && entry.source === 'freedict', 'a failed primary falls back to the open dictionary')
})

// 3. A cached selection still answers while the routes are saturated.
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const handler = createLookupHandler({
    translate: async (request) => {
      calls += 1
      if (calls > 1) await gate
      return { translation: `t:${request.text}`, provider: 'bing', target: request.target }
    },
    lookup: async () => null,
  })
  const post = (body) => handler(new Request('http://local/api/selectionTranslate.lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const first = await post({ text: 'warm cache', target: 'zh-CN' })
  check(first.status === 200, 'first request populates the cache')
  const pending = []
  for (let index = 0; index < 4; index += 1) pending.push(post({ text: `slow ${index}`, target: 'zh-CN' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cached = await post({ text: 'warm cache', target: 'zh-CN' })
  check(cached.status === 200, 'a cached selection is served while four lookups are in flight')
  const busy = await post({ text: 'brand new', target: 'zh-CN' })
  check(busy.status === 503, 'a fresh selection is refused while four lookups are in flight')
  release()
  await Promise.all(pending)
}

// 4. Stopping during the spawn window kills the child instead of orphaning it.
{
  const created = []
  class FakeChild extends EventEmitter {
    constructor() {
      super()
      this.exitCode = null
      this.killed = false
      created.push(this)
    }

    kill() {
      if (this.killed) return
      this.killed = true
      this.exitCode = 0
      this.emit('exit')
      this.emit('close')
    }
  }
  const speaker = createSpeaker({ spawn: () => new FakeChild() })
  const post = (body) => speaker.handler(new Request('http://local/api/selectionTranslate.speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const speaking = post({ action: 'speak', text: 'hello', lang: 'en', id: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await post({ action: 'stop', id: 'a' })
  check(created.length === 1 && created[0].killed === true, 'a stop during the spawn window kills the new child')
  const spoken = await speaking
  check(spoken.status === 200 || spoken.status === 501, 'the interrupted speak still answers')
  speaker.dispose()
}

// 5. Oversized diagnostic bodies are refused and long strings are trimmed.
{
  const dir = await mkdtemp(join(tmpdir(), 'dst-debug-'))
  const file = join(dir, 'log.jsonl')
  const debug = createDebugHandler({ file })
  const post = (body) => debug(new Request('http://local/api/selectionTranslate.debug', { method: 'POST', body }))
  const huge = await post(JSON.stringify({ where: 'x', detail: 'y'.repeat(9000) }))
  check(huge.status === 413, 'an oversized diagnostic body is refused')
  const trimmed = await post(JSON.stringify({ where: 'styles', detail: { note: 'z'.repeat(900) } }))
  check(trimmed.status === 200, 'a normal diagnostic body is written')
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  check(lines.length === 1 && lines[0].length < 700, 'a long field is truncated in the log line')
  await rm(dir, { recursive: true, force: true })
}

// 6. The window's model aligns one sentence per sense.
{
  const prompts = []
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream(options) {
          prompts.push({ provider: config.provider, model: config.model, text: options.messages[0].content[0].text })
          yield { type: 'text-delta', index: 0, text: '[{"pos":"v","en":"I run every morning.","zh":"我每天早晨跑步。"},{"pos":"n","en":"The run left her breathless.","zh":"那一段奔跑让她喘不过气。"}]' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const writer = createExampleWriter({ llm: () => llm, selection: () => ({ provider: 'p', model: 'm' }) })
  const entry = {
    headword: 'run',
    senses: [{ pos: 'v', defs: ['跑，奔跑'] }, { pos: 'n', defs: ['奔跑，跑'] }],
    examples: [{ en: 'I run every morning.', zh: '我每天早晨跑步。', pos: 'verb' }],
    source: 'youdao',
  }
  const aligned = await writer(entry, {})
  check(aligned.length === 2, 'one sentence per sense is kept')
  check(aligned[0].generated !== true, 'a sentence the dictionary already had is not marked generated')
  check(aligned[1].generated === true && aligned[1].pos === 'noun', 'a written sentence is marked generated')
  check(prompts.length === 1 && prompts[0].text.includes('奔跑'), 'the prompt carries the shown definitions')
  const again = await writer(entry, {})
  check(again.length === 2 && prompts.length === 1, 'a repeated lookup reuses the aligned answer')
  check(entry.examples.length === 1, 'the write does not mutate the caller entry')
}

// 7. A failing or absent model leaves the entry untouched.
{
  const bad = createExampleWriter({ llm: () => ({ prepareCall: async () => { throw new Error('no route') } }), selection: () => ({ provider: 'p', model: 'm' }) })
  const entry = { headword: 'run', senses: [{ pos: 'n', defs: ['奔跑'] }], examples: [] }
  check((await bad(entry, {})).length === 0, 'a failing model yields no alignment')

  let asked = 0
  const none = createExampleWriter({ llm: () => { asked += 1; return undefined }, selection: () => ({ provider: 'p', model: 'm' }) })
  check((await none(entry, {})).length === 0 && asked === 1, 'an absent llm service is tolerated')
}

// 8. Aligned sentences are validated before they reach the panel.
{
  const senses = [{ pos: 'n', defs: ['奔跑'] }]
  const good = parseAligned('[{"pos":"n","en":"A long run helps.","zh":"长跑有帮助。"}]', 'run', senses)
  check(good.length === 1 && good[0].generated === true, 'a well formed sentence is accepted')
  check(parseAligned('[{"pos":"v","en":"They run daily.","zh":"他们每天跑。"}]', 'run', senses).length === 0, 'an unrequested sense is dropped')
  check(parseAligned('[{"pos":"n","en":"Something else entirely.","zh":"别的东西。"}]', 'run', senses).length === 0, 'a sentence without the headword is dropped')
  check(parseAligned('no json here', 'run', senses).length === 0, 'prose without a JSON array is ignored')
  check(parseAligned('[{"pos":"n","en":"A long run helps.","zh":"长跑有帮助。"},{"pos":"n","en":"A long run helps.","zh":"重复。"}]', 'run', senses).length === 1, 'duplicate sentences are collapsed')
  const known = new Set(['A long run helps.'])
  check(parseAligned('[{"pos":"n","en":"A long run helps.","zh":"长跑有帮助。"}]', 'run', senses, known)[0].generated !== true, 'a candidate sentence is not marked generated')
}

// 9. One meaning per sense, reduced to the term a reader needs.
{
  check(primaryDef('损坏，损失；损害，伤害') === '损坏', 'a meaning line keeps its leading term')
  check(primaryDef('（有形的）损坏') === '（有形的）损坏', 'a parenthetical qualifier survives')
  check(primaryDef('  光线; 灯  ') === '光线', 'whitespace and ascii separators are handled')
  check(primaryDef('') === '', 'an empty line stays empty')
}

// 10. The corpus answers first; the model is only asked for what is left.
{
  const pool = [
    { en: 'A light breeze was blowing.', zh: '轻风习习。', pos: null },
    { en: 'All plants need light and water.', zh: '一切植物都需要阳光和水。', pos: null },
  ]
  const fit = fitCandidates([{ pos: 'n', defs: ['光'] }], pool)
  check(fit.examples[0].en === 'All plants need light and water.', 'the sentence that matches the meaning wins')
  check(fit.missing.length === 0, 'a meaning match leaves nothing for the model')

  const shared = fitCandidates([{ pos: 'n', defs: ['记录'] }, { pos: 'v', defs: ['记录'] }], pool)
  check(shared.missing.length === 2, 'a gloss shared by two senses is left to the model')

  let asked = 0
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream() {
          asked += 1
          yield { type: 'text-delta', index: 0, text: '[]' }
        },
      }
    },
  }
  const writer = createExampleWriter({ llm: () => llm, selection: () => ({ provider: 'p', model: 'm' }) })
  const free = await writer({ headword: 'light', senses: [{ pos: 'n', defs: ['光'] }], candidates: pool }, {})
  check(free.length === 1 && asked === 0, 'a corpus sentence costs no tokens')

  // A sense the corpus cannot carry is the only one sent to the model.
  asked = 0
  const partial = await writer({ headword: 'light', senses: [{ pos: 'n', defs: ['光'] }, { pos: 'v', defs: ['照亮'] }], candidates: pool }, {})
  check(partial.length <= 2 && asked === 1, 'only the sense without a sentence is sent to the model')
}

if (failures > 0) {
  console.log(`${failures} of ${count} checks failed`)
  process.exit(1)
}
console.log(`all ${count} library checks passed`)
