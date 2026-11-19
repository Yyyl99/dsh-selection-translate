/**
 * HTTP contract for `POST /api/selectionTranslate.lookup`.
 *
 * One request answers with the translation and, for a single English word, a
 * dictionary entry. The panel has nothing useful to show until the first of
 * those arrives, and a machine translation can take a second while the
 * dictionary answers in a quarter of one — so when the caller asks for
 * `application/x-ndjson` the answer streams: one JSON object per line, in the
 * order the pieces become available.
 *
 * The dictionary is best-effort: its failure never fails the translation.
 */

import { normalizeTarget, translateText, TranslateError } from './translate.js'
import { lookupWord, singleEnglishWord, splitIdentifier } from './dictionary.js'

export const MAX_TEXT_CHARS = 4000
const CACHE_LIMIT = 100
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_INFLIGHT = 4
const TRANSLATE_TIMEOUT_MS = 10_000
/** A single provider's timeout; the dictionary may call a fallback after it. */
const DICTIONARY_TIMEOUT_MS = 2_000
const DICTIONARY_BUDGET_MS = 4_000
/** Extra work on an echoed identifier must not stretch the panel's wait. */
const IDENTIFIER_BUDGET_MS = 3_000
/** Whole-request ceiling, including the dictionary fallback. */
const REQUEST_BUDGET_MS = 12_000
/** Media type that asks for the progressive answer. */
export const STREAM_TYPE = 'application/x-ndjson'

/**
 * Normalize text for "did the engine just echo the token back" checks.
 * @param {string} value - text.
 * @returns {string} lower-case alphanumeric form.
 */
function fingerprint(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Translate a code identifier such as `diagKey` by its parts.
 *
 * Machine translation echoes unknown tokens unchanged, which reads as a
 * failure to the user. Splitting `diagKey` into `diag key` gives the engine
 * something translatable, and the parts also make a useful glossary.
 *
 * @param {string} text - original selection.
 * @param {string} translation - what the engine returned for the token.
 * @param {string} target - target language.
 * @param {Function} translate - translation function.
 * @param {Function} lookup - dictionary function.
 * @param {AbortSignal} deadline - overall request deadline.
 * @returns {Promise<{translation: string, entries: {word: string, meaning: string|null}[]}|null>} enrichment or null.
 */
async function identifierParts(text, translation, target, translate, lookup, deadline) {
  if (target !== 'zh-CN' && target !== 'en') return null
  const split = splitIdentifier(text)
  if (split === null) return null
  if (fingerprint(translation) !== fingerprint(text)) return null
  const budget = AbortSignal.any([deadline, AbortSignal.timeout(IDENTIFIER_BUDGET_MS)])
  let next = translation
  try {
    const retry = await translate({ text: split.join(' '), target }, { signal: budget, timeoutMs: IDENTIFIER_BUDGET_MS })
    if (typeof retry.translation === 'string' && retry.translation.trim() !== '') next = retry.translation
  } catch {
    // Keep the echoed token; the part glossary below still helps.
  }
  const meanings = await Promise.allSettled(split.map(part => lookup(part, {
    signal: AbortSignal.any([budget, AbortSignal.timeout(DICTIONARY_TIMEOUT_MS)]),
    timeoutMs: DICTIONARY_TIMEOUT_MS,
  })))
  const entries = split.map((part, index) => {
    const settled = meanings[index]
    const entry = settled.status === 'fulfilled' ? settled.value : null
    const meaning = entry !== null && Array.isArray(entry.senses) && entry.senses.length > 0
      ? (Array.isArray(entry.senses[0].defs) ? entry.senses[0].defs[0] : null)
      : null
    return { word: part, meaning: typeof meaning === 'string' ? meaning : null }
  })
  return { translation: next, entries }
}

/**
 * Build a JSON response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - serializable payload.
 * @returns {Response} response with no-store caching.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * HTTP status for a failure code.
 * @param {string} code - failure code.
 * @returns {number} status.
 */
function statusFor(code) {
  if (code === 'TIMEOUT') return 504
  if (code === 'UNSUPPORTED_TARGET' || code === 'BAD_REQUEST') return 400
  if (code === 'CANCELLED') return 499
  return 502
}

/**
 * Turn a thrown value into a client-safe failure description.
 * @param {unknown} error - thrown value.
 * @returns {{code: string, message: string, status: number}} description.
 */
function failureOf(error) {
  if (error instanceof TranslateError) return { code: error.code, message: error.message, status: statusFor(error.code) }
  if (error?.name === 'TimeoutError') return { code: 'TIMEOUT', message: 'translation timed out', status: 504 }
  if (error?.name === 'AbortError') return { code: 'CANCELLED', message: 'caller went away', status: 499 }
  if (process.env.DST_DEBUG === '1') console.error('[route]', error)
  return { code: 'TRANSLATION_FAILED', message: 'translation failed', status: 502 }
}

/**
 * Read a fresh cache entry.
 * @param {Map<string, {at: number, payload: unknown}>} cache - process cache.
 * @param {string} key - cache key.
 * @returns {unknown|undefined} cached payload while it is fresh.
 */
function readCache(cache, key) {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.payload
}

/**
 * Store a cache entry, evicting the least recently used one.
 * @param {Map<string, {at: number, payload: unknown}>} cache - process cache.
 * @param {string} key - cache key.
 * @param {unknown} payload - response to reuse.
 * @returns {void}
 */
function writeCache(cache, key, payload) {
  cache.set(key, { at: Date.now(), payload })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/**
 * Serve one answer as newline-delimited JSON, one object per line.
 *
 * Each line is flushed as soon as it is produced, so the panel can paint the
 * dictionary while the translation is still in flight. The callback runs
 * exactly once, whether the stream finishes or the browser drops it.
 *
 * @param {AsyncIterable<object>} events - answers in arrival order.
 * @param {() => void} release - cleanup hook.
 * @returns {Response} streaming response.
 */
function ndjson(events, release) {
  const encoder = new TextEncoder()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    release()
  }
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', ...failureOf(error) })}\n`))
      } finally {
        finish()
        try {
          controller.close()
        } catch {
          // The browser already cancelled the stream.
        }
      }
    },
    cancel() {
      finish()
    },
  })
  return new Response(body, {
    headers: { 'content-type': `${STREAM_TYPE}; charset=utf-8`, 'cache-control': 'no-store' },
  })
}

/**
 * Strip fields the panel has no use for.
 *
 * The aligner needs the whole candidate pool, but shipping a dozen extra
 * sentences to the renderer — and into the cache — is waste.
 *
 * @param {object} word - dictionary entry.
 * @returns {object} entry without host-only fields.
 */
function publicWord(word) {
  if (word === null || typeof word !== 'object') return word
  const { candidates, ...rest } = word
  return rest
}

/**
 * Create the lookup request handler.
 * @param {{translate?: typeof translateText, lookup?: typeof lookupWord, cache?: Map, alignExamples?: (entry: object, context: {signal: AbortSignal}) => Promise<object[]>}} [deps] - injectable collaborators.
 * @returns {(request: Request) => Promise<Response>} handler.
 */
export function createLookupHandler(deps = {}) {
  const translate = deps.translate ?? translateText
  const lookup = deps.lookup ?? lookupWord
  const cache = deps.cache ?? new Map()
  const alignExamples = deps.alignExamples
  let inflight = 0

  return async function handleLookup(request) {
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED', message: 'use POST' })
    const accepts = request.headers.get('accept') ?? ''
    const wantsStream = accepts.includes(STREAM_TYPE)
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { code: 'BAD_REQUEST', message: 'request body must be JSON' })
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return json(400, { code: 'EMPTY_TEXT', message: 'text must not be empty' })
    if (text.length > MAX_TEXT_CHARS) {
      return json(400, { code: 'TEXT_LIMIT', message: `text exceeds ${MAX_TEXT_CHARS} characters` })
    }
    const target = normalizeTarget(body?.target)
    if (target === null) return json(400, { code: 'UNSUPPORTED_TARGET', message: 'target language is not supported' })
    const key = `${target}\u0000${text}`
    const cached = readCache(cache, key)
    if (cached !== undefined) {
      if (!wantsStream) return json(200, cached)
      return ndjson(replay(cached), () => {})
    }
    // The cache check comes first: a burst of slow requests must not turn a
    // repeat of an already-answered selection into a "busy" error.
    if (inflight >= MAX_INFLIGHT) return json(503, { code: 'BUSY', message: 'too many translations in flight' })

    const word = target === 'zh-CN' ? singleEnglishWord(text) : null
    inflight += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      inflight -= 1
    }

    // Follow the caller: when the panel closes, the browser drops this request
    // and the slot must be freed instead of waiting out the timeout.
    const deadline = AbortSignal.timeout(REQUEST_BUDGET_MS)
    const signal = AbortSignal.any([request.signal, deadline])

    /**
     * Produce the answer piece by piece, in whatever order it becomes ready.
     * @returns {AsyncGenerator<object>} events.
     */
    async function* events() {
      let settledTranslation = null
      let settledWord = null
      let identifier = null
      let failed = null
      const tasks = [{
        key: 'translation',
        promise: translate({ text, target }, { signal, timeoutMs: TRANSLATE_TIMEOUT_MS })
          .then(value => ({ key: 'translation', value }), error => ({ key: 'translation', error })),
      }]
      if (word !== null) {
        tasks.push({
          key: 'word',
          promise: lookup(word, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(DICTIONARY_BUDGET_MS)]),
            timeoutMs: DICTIONARY_TIMEOUT_MS,
          }).then(value => ({ key: 'word', value }), error => ({ key: 'word', error })),
        })
      }
      const open = new Set(tasks.map(task => task.key))
      while (open.size > 0) {
        const settled = await Promise.race(tasks.filter(task => open.has(task.key)).map(task => task.promise))
        open.delete(settled.key)
        if (settled.key === 'translation') {
          if (settled.error !== undefined) {
            failed = failureOf(settled.error)
            yield { type: 'error', ...failed }
            return
          }
          settledTranslation = settled.value
          yield { type: 'translation', translation: settled.value.translation, provider: settled.value.provider, target }
        } else if (settled.value !== undefined) {
          settledWord = settled.value
          yield { type: 'word', word: publicWord(settled.value) }
        }
      }

      // One example per sense, matched by meaning rather than by a lexical
      // part-of-speech guess. Best effort: a failure keeps the dictionary's own
      // candidate sentences.
      if (settledWord !== null && typeof alignExamples === 'function') {
        try {
          const aligned = await alignExamples(settledWord, { signal })
          if (Array.isArray(aligned) && aligned.length > 0) {
            settledWord = { ...settledWord, examples: aligned }
            yield { type: 'word', word: publicWord(settledWord) }
          }
        } catch {
          // The dictionary entry stands on its own.
        }
      }
      if (settledWord === null) {
        try {
          identifier = await identifierParts(text, settledTranslation.translation, target, translate, lookup, signal)
          if (identifier !== null) {
            yield { type: 'parts', parts: identifier.entries, translation: identifier.translation }
          }
        } catch {
          // The identifier glossary is a bonus; never lose the translation over it.
        }
      }

      const payload = {
        translation: identifier?.translation ?? settledTranslation.translation,
        provider: settledTranslation.provider,
        target,
        word: settledWord === null ? null : publicWord(settledWord),
      }
      if (identifier !== null) payload.parts = identifier.entries
      writeCache(cache, key, payload)
      yield { type: 'done', payload }
    }

    if (wantsStream) return ndjson(events(), release)
    try {
      let payload = null
      let failure = null
      for await (const event of events()) {
        if (event.type === 'error') failure = event
        if (event.type === 'done') payload = event.payload
      }
      if (failure !== null) return json(failure.status ?? statusFor(failure.code), { code: failure.code, message: failure.message })
      return json(200, payload)
    } catch (error) {
      return json(failureOf(error).status, { code: failureOf(error).code, message: failureOf(error).message })
    } finally {
      release()
    }
  }
}

/**
 * Replay a cached answer as stream events.
 * @param {{translation: string, provider: string, target: string, word: object|null, parts?: object[]}} payload - cached answer.
 * @returns {AsyncGenerator<object>} events.
 */
async function* replay(payload) {
  yield { type: 'translation', translation: payload.translation, provider: payload.provider, target: payload.target }
  if (payload.word !== null && payload.word !== undefined) yield { type: 'word', word: payload.word }
  if (Array.isArray(payload.parts)) yield { type: 'parts', parts: payload.parts, translation: payload.translation }
  yield { type: 'done', payload }
}
