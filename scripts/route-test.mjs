/**
 * Offline contract tests for the lookup route.
 *
 * Run with `node scripts/route-test.mjs`. The network is replaced by fakes, so
 * this checks the HTTP contract, not upstream availability.
 */

import assert from 'node:assert/strict'
import { createLookupHandler, MAX_TEXT_CHARS } from '../lib/route.js'
import { TranslateError } from '../lib/translate.js'

let translateCalls = 0
let lookupCalls = 0
let failTranslate = null
let failDictionary = null

const handler = createLookupHandler({
  translate: async (request) => {
    translateCalls += 1
    if (failTranslate !== null) throw failTranslate
    return { translation: `translated:${request.text}:${request.target}`, provider: 'bing', target: request.target }
  },
  lookup: async (word) => {
    lookupCalls += 1
    if (failDictionary !== null) throw failDictionary
    return {
      headword: word,
      phonetic: 'ˌtest',
      senses: [{ pos: 'n.', defs: ['测试'] }],
      examples: [{ en: `A ${word} example.`, zh: '一个例句。' }],
      source: 'youdao',
    }
  },
})

/**
 * Send one JSON request to the handler.
 * @param {object} body - request body.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{status: number, body: any}>} observed response.
 */
async function call(body, method = 'POST') {
  const request = new Request('http://127.0.0.1/api/selectionTranslate.lookup', {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  const response = await handler(request)
  return { status: response.status, body: await response.json() }
}

/**
 * Run one named check.
 * @param {string} name - check name.
 * @param {() => Promise<void>} run - body.
 * @returns {Promise<void>} resolves when the check passed.
 */
async function check(name, run) {
  await run()
  console.log(`ok - ${name}`)
}

await check('a sentence returns a translation and no dictionary entry', async () => {
  const result = await call({ text: 'Hello world, this is a test.', target: 'zh-CN' })
  assert.equal(result.status, 200)
  assert.equal(result.body.translation, 'translated:Hello world, this is a test.:zh-CN')
  assert.equal(result.body.provider, 'bing')
  assert.equal(result.body.word, null)
  assert.equal(lookupCalls, 0)
})

await check('a single English word also returns a dictionary entry', async () => {
  const result = await call({ text: 'serendipity', target: 'zh-CN' })
  assert.equal(result.status, 200)
  assert.equal(result.body.word.headword, 'serendipity')
  assert.equal(result.body.word.senses[0].defs[0], '测试')
  assert.equal(lookupCalls, 1)
})

await check('a dictionary failure keeps the translation', async () => {
  failDictionary = new Error('dictionary offline')
  const result = await call({ text: 'obfuscate', target: 'zh-CN' })
  failDictionary = null
  assert.equal(result.status, 200)
  assert.equal(result.body.word, null)
  assert.match(result.body.translation, /translated:obfuscate/)
})

await check('the same request is cached', async () => {
  const before = translateCalls
  await call({ text: 'cached sentence', target: 'en' })
  await call({ text: 'cached sentence', target: 'en' })
  assert.equal(translateCalls, before + 1)
})

await check('an empty selection is refused', async () => {
  const result = await call({ text: '   ', target: 'zh-CN' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'EMPTY_TEXT')
})

await check('an oversized selection is refused', async () => {
  const result = await call({ text: 'a'.repeat(MAX_TEXT_CHARS + 1), target: 'zh-CN' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'TEXT_LIMIT')
})

await check('an unsupported target is refused', async () => {
  const result = await call({ text: 'hello', target: 'de' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'UNSUPPORTED_TARGET')
})

await check('a non-POST request is refused', async () => {
  const result = await call({}, 'GET')
  assert.equal(result.status, 405)
})

await check('translation errors map to a reason', async () => {
  failTranslate = new TranslateError('HTTP_ERROR', 'bing answered 500')
  const result = await call({ text: 'bad upstream', target: 'zh-CN' })
  failTranslate = null
  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'HTTP_ERROR')
})

await check('a streamed answer paints whichever half is ready first', async () => {
  const slow = createLookupHandler({
    translate: async (request) => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { translation: `translated:${request.text}`, provider: 'bing', target: request.target }
    },
    lookup: async (word) => ({
      headword: word,
      phonetic: 'ˌfast',
      senses: [{ pos: 'n', defs: ['快'] }],
      examples: [{ en: `A ${word} example.`, zh: '例句。', pos: 'noun' }],
      source: 'youdao',
    }),
  })
  const response = await slow(new Request('http://127.0.0.1/api/selectionTranslate.lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ text: 'swift', target: 'zh-CN' }),
  }))
  assert.equal(response.headers.get('content-type')?.startsWith('application/x-ndjson'), true)
  const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines[0].type, 'word', 'the dictionary arrives first')
  assert.equal(lines[1].type, 'translation')
  assert.equal(lines.at(-1).type, 'done')
  assert.equal(lines.at(-1).payload.translation, 'translated:swift')
  assert.equal(lines.at(-1).payload.word.headword, 'swift')
})

await check('a streamed replay of a cached answer matches the live one', async () => {
  const request = () => new Request('http://127.0.0.1/api/selectionTranslate.lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ text: 'swift', target: 'zh-CN' }),
  })
  const first = (await (await handler(request())).text()).trim().split('\n').map(line => JSON.parse(line))
  const second = (await (await handler(request())).text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(second.map(item => item.type), first.map(item => item.type))
  assert.equal(second.at(-1).payload.translation, first.at(-1).payload.translation)
})

await check('a JSON caller still receives one object', async () => {
  const result = await call({ text: 'swift', target: 'zh-CN' })
  assert.equal(result.status, 200)
  assert.equal(result.body.translation, 'translated:swift:zh-CN')
  assert.equal(result.body.word.headword, 'swift')
})

console.log('all route checks passed')
