/**
 * Align the example sentences of a dictionary entry with its senses.
 *
 * Dictionary sentence lists are flat: Youdao returns a handful of bilingual
 * pairs with no indication of which sense each one illustrates, and its own
 * part-of-speech guess is lexical, not semantic. The result reads wrong — the
 * "光，光线" sense of `light` ending up with "A light breeze was blowing".
 *
 * So the host asks the window's own model to do the alignment: it receives the
 * senses (part of speech plus the two Chinese definitions shown in the panel)
 * and the candidate dictionary sentences, and returns exactly one sentence per
 * sense, reusing a candidate verbatim when it fits and writing one when it does
 * not. Sentences written by the model are marked, and nothing is cached to disk.
 */

import { normalizePos } from './dictionary.js'

/** Wall-clock budget for one alignment round, inside the lookup deadline. */
const ALIGN_BUDGET_MS = 9_000
/** A handful of short sentences plus JSON runs well under this. */
const MAX_TOKENS = 1_200
/** Looking up the model's reasoning options must not eat the budget. */
const EFFORT_LOOKUP_MS = 1_500
/** Results are reused while the host stays up, never written to disk. */
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_LIMIT = 300
/** One sentence per sense; longer than this is a paragraph, not an example. */
const MAX_SENTENCE_CHARS = 150

const SYSTEM = 'You align dictionary example sentences with the senses they illustrate.'
  + ' Follow the requested JSON format exactly, with no prose before or after it.'

const PART_NAMES = {
  noun: 'noun',
  verb: 'verb',
  adjective: 'adjective',
  adverb: 'adverb',
}

/**
 * Human readable label for a part of speech.
 * @param {string} pos - normalized part of speech.
 * @returns {string} label.
 */
export function partLabel(pos) {
  return PART_NAMES[pos] ?? pos
}

/**
 * Build the user prompt for one entry.
 * @param {string} word - headword.
 * @param {Array<{pos: string, defs: string[]}>} senses - senses as shown in the panel.
 * @param {Array<{en: string, zh: string, pos: string|null}>} candidates - dictionary sentences.
 * @returns {string} prompt.
 */
export function buildPrompt(word, senses, candidates) {
  const senseLines = senses.map((sense, index) => {
    const label = partLabel(normalizePos(sense.pos) ?? sense.pos)
    const gloss = (Array.isArray(sense.defs) ? sense.defs : []).join('；')
    return `${index + 1}. ${label} — ${gloss}`
  })
  const candidateLines = candidates.length === 0
    ? '(none)'
    : candidates.map(item => `- [${item.pos ?? 'unknown'}] ${item.en} | ${item.zh}`).join('\n')
  return `Word: "${word}"

Senses, in the order they are shown to the reader:
${senseLines.join('\n')}

Candidate sentences from the dictionary:
${candidateLines}

For every sense above, give the one example sentence that illustrates exactly that sense.
A sense may list two Chinese definitions separated by "；": the sentence must fit
the first one, which is the sense as the reader understands it.
Rules:
- reuse a candidate verbatim (same "en") only when it illustrates this sense;
  never reuse a sentence that illustrates a different sense;
- otherwise write a new one that fits the sense in the panel, at most 90 characters;
- the word "${word}" appears exactly as written, in the requested part of speech;
- simple present or simple past, no quotes, no semicolons, no numbers, everyday vocabulary;
- give a natural Chinese translation in "zh".
Return a JSON array only, one item per sense, in the same order, using exactly
the part of speech written in the list above ("noun", "verb", "adjective"):
[{"pos":"noun","en":"...","zh":"..."}]`
}

/**
 * Extract and validate the sentences a model returned.
 * @param {string} text - raw model output.
 * @param {string} word - headword the sentences must contain.
 * @param {Array<{pos: string}>} senses - senses in panel order.
 * @param {Set<string>} candidates - sentences the dictionary already had.
 * @returns {Array<{en: string, zh: string, pos: string, generated?: true}>} one sentence per sense, in order.
 */
export function parseAligned(text, word, senses, candidates = new Set()) {
  if (typeof text !== 'string') return []
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let payload
  try {
    payload = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(payload)) return []
  const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const form = new RegExp('\\b' + escaped + '(s|es|ed|d|ing)?\\b', 'i')
  const accepted = []
  for (const sense of senses) {
    const pos = normalizePos(sense?.pos)
    const item = payload.find(entry => normalizePos(entry?.pos) === pos && !accepted.some(done => done.en === entry?.en))
    if (item === undefined) continue
    const en = typeof item.en === 'string' ? item.en.replace(/\s+/g, ' ').trim() : ''
    const zh = typeof item.zh === 'string' ? item.zh.replace(/\s+/g, ' ').trim() : ''
    if (en === '' || zh === '' || en.length > MAX_SENTENCE_CHARS) continue
    if (!form.test(en)) continue
    const example = { en, zh: zh.slice(0, MAX_SENTENCE_CHARS), pos }
    if (!candidates.has(en)) example.generated = true
    accepted.push(example)
  }
  return accepted
}

/**
 * Read a cached alignment.
 * @param {Map<string, {at: number, items: object[]}>} cache - cache.
 * @param {string} key - cache key.
 * @returns {object[]|undefined} fresh items.
 */
function readCache(cache, key) {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit.items
}

/**
 * Store an alignment, trimmed to the newest entries.
 * @param {Map<string, {at: number, items: object[]}>} cache - cache.
 * @param {string} key - cache key.
 * @param {object[]} items - aligned examples.
 * @returns {void}
 */
function writeCache(cache, key, items) {
  cache.set(key, { at: Date.now(), items })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/** Chinese particles carry no meaning for matching a sentence to a sense. */
const NEUTRAL_CHARS = new Set('的了是在和与或就都也这个们有不无会能要可以对把被从到给如但而且所以还又再更很太地得着过吗呢吧啊哦一二三四五六七八九十'.split(''))

/**
 * Meaningful Chinese characters of a definition.
 * @param {string} text - definition line.
 * @returns {string[]} distinct characters.
 */
function glossChars(text) {
  const seen = new Set()
  for (const char of typeof text === 'string' ? text : '') {
    if (/[\u4e00-\u9fff]/.test(char) && !NEUTRAL_CHARS.has(char)) seen.add(char)
  }
  return [...seen]
}

/**
 * How well one candidate sentence illustrates one sense.
 *
 * The dictionary's own part-of-speech guess is lexical and unreliable — a light
 * breeze is an adjective, not the "light" of a lamp — so the meaning decides:
 * the sense's Chinese gloss has to appear in the sentence's Chinese line. That
 * costs nothing and reuses a real corpus sentence instead of a model call.
 *
 * @param {{en: string, zh: string, pos: string|null}} candidate - candidate sentence.
 * @param {{pos: string, defs: string[]}} sense - sense shown in the panel.
 * @returns {number} score; zero when the sentence does not fit.
 */
export function fitScore(candidate, sense) {
  const pos = normalizePos(sense?.pos)
  const samePos = pos !== null && normalizePos(candidate?.pos) === pos
  const gloss = glossChars((sense?.defs ?? [])[0] ?? '')
  const zh = typeof candidate?.zh === 'string' ? candidate.zh : ''
  if (gloss.length === 0 || zh === '') return samePos ? 1 : 0
  let hits = 0
  for (const char of gloss) if (zh.includes(char)) hits += 1
  // A one-character gloss ("光") is satisfied by that character; a longer one
  // needs most of its characters, so `浅色的` cannot ride on 色 alone.
  const need = gloss.length === 1 ? 1 : Math.max(2, Math.ceil(gloss.length * 0.5))
  if (hits < need) return 0
  return 2 + hits + (samePos ? 1 : 0)
}

/**
 * Assign dictionary sentences to senses by meaning, without a model.
 * @param {Array<{pos: string, defs: string[]}>} senses - senses in panel order.
 * @param {Array<{en: string, zh: string, pos: string|null}>} pool - candidate sentences.
 * @returns {{examples: Array<object|null>, missing: number[]}} fits in sense order, and the senses left over.
 */
export function fitCandidates(senses, pool) {
  const examples = senses.map(() => null)
  const used = new Set()
  const scores = senses.map(sense => pool.map(candidate => fitScore(candidate, sense)))
  /**
   * Give the best unused sentence to every sense the filter accepts.
   * @param {(slot: number, index: number) => boolean} allow - extra condition.
   * @returns {void}
   */
  const assign = (allow) => {
    for (let index = 0; index < senses.length; index += 1) {
      if (examples[index] !== null) continue
      let best = -1
      let bestScore = 0
      for (let slot = 0; slot < pool.length; slot += 1) {
        if (used.has(slot) || !allow(slot, index)) continue
        const score = scores[index][slot]
        if (score > bestScore) {
          bestScore = score
          best = slot
        }
      }
      if (best === -1) continue
      used.add(best)
      const candidate = pool[best]
      examples[index] = {
        en: candidate.en,
        zh: candidate.zh,
        pos: normalizePos(senses[index].pos) ?? senses[index].pos,
      }
    }
  }
  // A gloss shared by two senses (`record` as a noun and as a verb are both
  // 记录) cannot decide between them, so those senses go to the model. For the
  // rest, a sentence whose part of speech agrees gets first refusal; only then
  // may a meaning-only match fill what is left.
  const counts = new Map()
  for (const sense of senses) {
    const gloss = (sense?.defs ?? [])[0] ?? ''
    counts.set(gloss, (counts.get(gloss) ?? 0) + 1)
  }
  const unique = index => counts.get((senses[index]?.defs ?? [])[0] ?? '') === 1
  assign((slot, index) => unique(index) && normalizePos(pool[slot]?.pos) === normalizePos(senses[index].pos))
  assign((slot, index) => unique(index))
  const missing = examples.map((item, index) => item === null ? index : -1).filter(index => index !== -1)
  return { examples, missing }
}

/**
 * Pick a reasoning effort that leaves room for the sentences themselves.
 *
 * A short JSON reply is not worth minutes of reasoning, so prefer the model's
 * `off` option when it advertises one, and otherwise keep whatever the window
 * is set to. The lookup is bounded: a slow adapter must not consume the
 * alignment budget.
 *
 * @param {object} service - host llm service.
 * @param {{provider: string, model: string, reasoningEffort?: string}} chosen - window selection.
 * @param {AbortSignal} signal - alignment budget.
 * @returns {Promise<string|undefined>} effort id to request.
 */
async function pickEffort(service, chosen, signal) {
  if (typeof service.resolveModelInfo === 'function') {
    const lookup = AbortSignal.timeout(EFFORT_LOOKUP_MS)
    try {
      const info = await service.resolveModelInfo(chosen.provider, chosen.model, AbortSignal.any([signal, lookup]))
      const efforts = info?.reasoning?.efforts
      if (Array.isArray(efforts) && efforts.some(entry => entry?.id === 'off')) return 'off'
    } catch {
      // Fall back to the window's own selection.
    }
  }
  return chosen.reasoningEffort
}

/**
 * Shortlist the candidates worth showing to the model.
 *
 * The prompt is the expensive half of a call, and most of a word's sentences
 * are irrelevant to the senses still open — a `light` noun sentence does not
 * help the verb. Keep the ones that share a part of speech or a gloss, and cap
 * the list so the prompt stays small.
 *
 * @param {Array<{pos: string, defs: string[]}>} senses - senses still open.
 * @param {Array<{en: string, zh: string, pos: string|null}>} pool - candidates.
 * @returns {Array<object>} at most six candidates.
 */
export function selectCandidates(senses, pool) {
  const ranked = pool.map((candidate, index) => {
    let rank = 0
    for (const sense of senses) {
      if (normalizePos(candidate.pos) === normalizePos(sense.pos)) rank += 2
      if (fitScore(candidate, sense) > 0) rank += 1
    }
    return { candidate, index, rank }
  })
  return ranked
    .filter(entry => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .slice(0, 6)
    .map(entry => entry.candidate)
}

/**
 * Run one prepared call and return its text.
 * @param {object} prepared - prepared call from the llm service.
 * @param {string} prompt - user prompt.
 * @param {AbortSignal} signal - budget signal.
 * @returns {Promise<string>} model text.
 */
async function requestText(prepared, prompt, signal) {
  const options = {
    ...prepared.config,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal,
  }
  let text = ''
  const kinds = []
  let finish = ''
  for await (const chunk of prepared.stream(options)) {
    if (typeof chunk?.type === 'string' && kinds.length < 12) kinds.push(chunk.type)
    if (chunk?.type === 'finish') finish = JSON.stringify(chunk.reason ?? null)
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (text.length > 8_000) break
  }
  if (text === '') requestText.last = { kinds, finish }
  return text
}

/**
 * Create the aligner used by the lookup route.
 *
 * @param {object} [options] - dependencies.
 * @param {() => object|undefined} [options.llm] - reads the host `llm` service.
 * @param {() => {provider: string, model: string, reasoningEffort?: string}|undefined} [options.selection] - reads the window's current model.
 * @returns {(entry: object, context?: {signal?: AbortSignal}) => Promise<object[]>} aligner.
 */
export function createExampleWriter(options = {}) {
  const readLlm = typeof options.llm === 'function' ? options.llm : () => undefined
  const readSelection = typeof options.selection === 'function' ? options.selection : () => undefined
  const report = typeof options.report === 'function' ? options.report : () => {}
  const cache = new Map()
  const pending = new Map()

  /**
   * Ask the model for one sentence per sense.
   * @param {string} word - headword.
   * @param {Array<{pos: string, defs: string[]}>} senses - senses.
   * @param {Array<{en: string, zh: string, pos: string|null}>} candidates - dictionary sentences.
   * @param {AbortSignal|undefined} signal - caller signal.
   * @returns {Promise<object[]>} aligned sentences.
   */
  async function align(word, senses, candidates, signal) {
    const service = readLlm()
    const chosen = readSelection()
    if (service === undefined || service === null || chosen === undefined || chosen === null) {
      report('align:no-model', {})
      return []
    }
    if (typeof service.prepareCall !== 'function') return []
    if (signal !== undefined && signal.aborted === true) return []
    const budget = AbortSignal.timeout(ALIGN_BUDGET_MS)
    const scoped = signal === undefined ? budget : AbortSignal.any([signal, budget])
    try {
      const effort = await pickEffort(service, chosen, scoped)
      const prepared = await service.prepareCall({
        provider: chosen.provider,
        model: chosen.model,
        ...effort === undefined ? {} : { reasoningEffort: effort },
        maxTokens: MAX_TOKENS,
      }, scoped)
      const text = await requestText(prepared, buildPrompt(word, senses, selectCandidates(senses, candidates)), scoped)
      const known = new Set(candidates.map(item => item.en))
      const aligned = parseAligned(text, word, senses, known)
      if (aligned.length === 0) report('align:unusable', { word, chars: text.length, head: text.slice(0, 160), stream: requestText.last ?? null })
      return aligned
    } catch (error) {
      report('align:error', { word, message: error instanceof Error ? error.message : String(error), stream: requestText.last ?? null })
      return []
    }
  }

  /**
   * Align one entry's examples with its senses.
   * @param {object} entry - dictionary entry.
   * @param {{signal?: AbortSignal}} [context] - request context.
   * @returns {Promise<object[]>} one example per sense, best effort.
   */
  return async function alignExamples(entry, context = {}) {
    if (entry === null || typeof entry !== 'object') return []
    const word = typeof entry.headword === 'string' && entry.headword !== '' ? entry.headword : ''
    const senses = Array.isArray(entry.senses) ? entry.senses.filter(sense => normalizePos(sense?.pos) !== null) : []
    if (word === '' || senses.length === 0) return Array.isArray(entry.examples) ? entry.examples : []
    const candidates = Array.isArray(entry.candidates) && entry.candidates.length > 0
      ? entry.candidates
      : Array.isArray(entry.examples) ? entry.examples : []
    const key = `${word}|${senses.map(sense => `${sense.pos}:${(sense.defs ?? []).join(',')}`).join('|')}|${candidates.map(item => item.en).join('~')}`
    const cached = readCache(cache, key)
    if (cached !== undefined) return cached
    const running = pending.get(key)
    if (running !== undefined) return running
    // Sentences the corpus already illustrates, matched by meaning: free.
    const local = fitCandidates(senses, candidates)
    if (local.missing.length === 0) {
      report('align:local', { word, kept: local.examples.length })
      return local.examples.filter(Boolean)
    }
    const asked = local.missing.map(index => senses[index])
    const work = align(word, asked, candidates, context.signal).then((written) => {
      for (const [slot, index] of local.missing.entries()) {
        const item = written[slot]
        if (item !== undefined && normalizePos(item.pos) === normalizePos(senses[index].pos)) local.examples[index] = item
      }
      return local.examples.filter(Boolean)
    })
    pending.set(key, work)
    try {
      const aligned = await work
      report('align:merged', { word, local: senses.length - local.missing.length, asked: asked.length, filled: aligned.filter(Boolean).length })
      if (aligned.some(Boolean)) writeCache(cache, key, aligned)
      return aligned
    } finally {
      pending.delete(key)
    }
  }
}
