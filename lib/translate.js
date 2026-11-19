/**
 * Anonymous machine translation with a primary and a fallback provider.
 *
 * Bing's Edge endpoint is the primary route on this machine; Google's public
 * endpoint is only attempted when Bing fails, and its failure never masks the
 * Bing error. Both protocols mirror the ones the Harness translator uses.
 */

const BING_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const CHUNK_CHARS = 1800
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

const TARGET_ALIASES = new Map([
  ['zh', 'zh-CN'],
  ['zh-cn', 'zh-CN'],
  ['zh-sg', 'zh-CN'],
  ['zh-hans', 'zh-CN'],
  ['zh-tw', 'zh-TW'],
  ['zh-hk', 'zh-TW'],
  ['zh-mo', 'zh-TW'],
  ['zh-hant', 'zh-TW'],
  ['en', 'en'],
  ['en-us', 'en'],
  ['en-gb', 'en'],
])

const BING_LANGS = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en' }
const GOOGLE_LANGS = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en' }

/** Failure raised by this module; `code` is stable and safe to surface. */
export class TranslateError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'TranslateError'
    this.code = code
  }
}

/**
 * Normalize a BCP-47-ish tag to a supported target.
 * @param {unknown} tag - caller supplied tag.
 * @returns {'zh-CN'|'zh-TW'|'en'|null} supported target, or null.
 */
export function normalizeTarget(tag) {
  if (typeof tag !== 'string') return null
  return TARGET_ALIASES.get(tag.trim().toLowerCase()) ?? null
}

/**
 * Split long text on sentence boundaries without breaking surrogate pairs.
 * @param {string} text - raw text.
 * @param {number} [limit] - maximum characters per chunk.
 * @returns {string[]} non-empty chunks in reading order.
 */
export function chunkText(text, limit = CHUNK_CHARS) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (normalized === '') return []
  if (normalized.length <= limit) return [normalized]
  const parts = normalized.split(/(?<=[.!?。！？；;])\s+/u)
  const chunks = []
  let current = ''
  for (const part of parts) {
    if (part.length > limit) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      chunks.push(...hardSplit(part, limit))
      continue
    }
    if (current !== '' && current.length + 1 + part.length > limit) {
      chunks.push(current)
      current = part
    } else {
      current = current === '' ? part : `${current} ${part}`
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Cut an oversized fragment at a fixed width without splitting a surrogate pair.
 * @param {string} text - fragment longer than `limit`.
 * @param {number} limit - maximum characters per piece.
 * @returns {string[]} consecutive pieces.
 */
function hardSplit(text, limit) {
  const pieces = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

/**
 * Read a JSON body while refusing oversized payloads.
 *
 * The length is counted as the body streams in, so a hostile or broken
 * upstream cannot make the host buffer an unbounded response before the size
 * check runs.
 *
 * @param {Response} response - upstream response.
 * @param {string} provider - provider label for error messages.
 * @param {number} [maxBytes] - byte ceiling.
 * @returns {Promise<unknown>} parsed JSON.
 */
export async function readJsonResponse(response, provider, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new TranslateError('RESPONSE_LIMIT', `${provider} response exceeds ${maxBytes} bytes`)
  }
  let raw = ''
  if (response.body === null) {
    raw = await response.text()
  } else {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new TranslateError('RESPONSE_LIMIT', `${provider} response exceeds ${maxBytes} bytes`)
      }
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new TranslateError('INVALID_RESPONSE', `${provider} returned invalid JSON`)
  }
}

/**
 * Translate one chunk with Bing.
 * @param {string} text - chunk text.
 * @param {string} target - normalized target.
 * @param {AbortSignal} signal - combined caller and deadline signal.
 * @returns {Promise<string>} translated text.
 */
async function bingChunk(text, target, signal) {
  const url = new URL(BING_ENDPOINT)
  url.searchParams.set('to', BING_LANGS[target] ?? target)
  url.searchParams.set('isEnterpriseClient', 'false')
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([text]),
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
  if (!response.ok) throw new TranslateError('HTTP_ERROR', `bing responded ${response.status}`)
  const payload = await readJsonResponse(response, 'bing')
  const entry = Array.isArray(payload) ? payload[0] : undefined
  const translated = entry?.translations?.[0]?.text
  if (typeof translated !== 'string') throw new TranslateError('INVALID_RESPONSE', 'bing returned an unexpected shape')
  return translated
}

/**
 * Translate one chunk with Google's public endpoint.
 * @param {string} text - chunk text.
 * @param {string} target - normalized target.
 * @param {AbortSignal} signal - combined caller and deadline signal.
 * @returns {Promise<string>} translated text.
 */
async function googleChunk(text, target, signal) {
  const form = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: GOOGLE_LANGS[target] ?? target,
    dt: 't',
    q: text,
  })
  const response = await fetch(GOOGLE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
  if (!response.ok) throw new TranslateError('HTTP_ERROR', `google responded ${response.status}`)
  const payload = await readJsonResponse(response, 'google')
  const segments = Array.isArray(payload) ? payload[0] : undefined
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new TranslateError('INVALID_RESPONSE', 'google returned an unexpected shape')
  }
  return segments.map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')).join('')
}

/**
 * Run every chunk through one provider.
 * @param {'bing'|'google'} provider - route to use.
 * @param {string[]} chunks - text chunks.
 * @param {string} target - normalized target.
 * @param {AbortSignal} signal - combined signal.
 * @returns {Promise<string>} joined translation.
 */
async function translateChunks(provider, chunks, target, signal) {
  const translateChunk = provider === 'bing' ? bingChunk : googleChunk
  const out = []
  for (const chunk of chunks) {
    out.push(await translateChunk(chunk, target, signal))
  }
  return out.join('\n')
}

/**
 * Translate text, preferring Bing and falling back to Google.
 * @param {{text: string, target: string, source?: string}} request - translation input.
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cancellation and deadline.
 * @returns {Promise<{translation: string, provider: 'bing'|'google', target: string}>} translation result.
 */
export async function translateText(request, options = {}) {
  const target = normalizeTarget(request?.target)
  if (target === null) {
    throw new TranslateError('UNSUPPORTED_TARGET', `unsupported target ${String(request?.target)}`)
  }
  const text = String(request?.text ?? '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return { translation: '', provider: 'bing', target }
  const chunks = chunkText(text)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  try {
    const translation = await translateChunks('bing', chunks, target, signal)
    return { translation, provider: 'bing', target }
  } catch (error) {
    if (options.signal?.aborted) {
      throw new TranslateError('REQUEST_FAILED', 'translation request was cancelled', { cause: error })
    }
    if (deadline.aborted) {
      throw new TranslateError('TIMEOUT', 'translation request timed out', { cause: error })
    }
    try {
      const translation = await translateChunks('google', chunks, target, signal)
      return { translation, provider: 'google', target }
    } catch (fallbackError) {
      if (options.signal?.aborted) {
        throw new TranslateError('REQUEST_FAILED', 'translation request was cancelled', { cause: fallbackError })
      }
      if (deadline.aborted) {
        throw new TranslateError('TIMEOUT', 'translation request timed out', { cause: fallbackError })
      }
      throw new TranslateError('TRANSLATION_FAILED', 'both translation providers failed', { cause: error })
    }
  }
}
