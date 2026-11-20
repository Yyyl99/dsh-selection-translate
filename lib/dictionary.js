/**
 * Dictionary lookup for a single English word.
 *
 * Youdao's public dictionary endpoint supplies phonetics, Chinese senses and
 * bilingual examples. When it has no entry, the open dictionary API supplies
 * English definitions that are machine translated here.
 */

import { readJsonResponse, translateText } from './translate.js'

const YOUDAO_ENDPOINT = 'https://dict.youdao.com/jsonapi'
const FREEDICT_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 2500
/** Budget for the open-dictionary fallback, which runs after the primary. */
const FALLBACK_TIMEOUT_MS = 1800
/** A fallback host that failed at the network level is skipped this long. */
const FALLBACK_COOLDOWN_MS = 10 * 60 * 1000
let fallbackDownUntil = 0
const MAX_SENSES = 3
const MAX_DEFS_PER_SENSE = 2
const MAX_EXAMPLES = 3
/** Enough alternatives for the aligner to reuse before asking a model. */
const MAX_CANDIDATES = 12
const MAX_DEF_CHARS = 120
const MAX_EXAMPLE_CHARS = 220
const POS_NAMES = { noun: 'noun', n: 'noun', verb: 'verb', v: 'verb', adjective: 'adjective', adj: 'adjective', adverb: 'adverb', adv: 'adverb' }

/**
 * Normalize a part of speech into its long name.
 * @param {unknown} pos - raw part of speech.
 * @returns {string|null} normalized name.
 */
export function normalizePos(pos) {
  if (typeof pos !== 'string') return null
  const key = pos.toLowerCase().trim().replace(/\.$/, '')
  return Object.prototype.hasOwnProperty.call(POS_NAMES, key) ? POS_NAMES[key] : null
}

const MAX_EXAMPLE_EN_CHARS = 104
const MAX_EXAMPLE_EN_WORDS = 18
// A sense without any example looks broken, so one longer sentence is accepted
// when it is the only way to illustrate that part of speech.
const MAX_EXAMPLE_RELAXED_CHARS = 150
const MAX_EXAMPLE_RELAXED_WORDS = 26
const POS_PATTERN = /^([a-z]{1,6})\.\s*/i
const POS_SHORT = { vt: 'v', vi: 'v', v: 'v', n: 'n', adj: 'adj', adv: 'adv', prep: 'prep', conj: 'conj', pron: 'pron', num: 'num', art: 'art', int: 'int', aux: 'aux' }

/** One English word with optional ASCII/latin punctuation, at most 32 characters. */
export const WORD_PATTERN = /^[A-Za-z][A-Za-z'’-]{0,31}$/

/**
 * Recognize a single English word worth a dictionary lookup.
 * @param {unknown} text - selected text.
 * @returns {string|null} the word, or null when the selection is not a single word.
 */
export function singleEnglishWord(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  return WORD_PATTERN.test(value) ? value : null
}

/**
 * Split a code identifier into the words it is built from.
 *
 * `diagKey` / `componentDidCatch` / `session_id` are common in a chat that
 * talks about code, and machine translation echoes them verbatim, which looks
 * like "this word cannot be translated". Splitting gives the engine something
 * it can actually translate.
 *
 * @param {unknown} text - selected text.
 * @returns {string[]|null} lower-case word list, or null when not an identifier.
 */
export function splitIdentifier(text) {
  if (typeof text !== 'string') return null
  const token = text.trim()
  if (!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/.test(token)) return null
  if (token.length < 4 || token.length > 48) return null
  const spaced = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim()
  const parts = spaced.split(/\s+/).filter(part => part !== '')
  if (parts.length < 2 || parts.length > 5) return null
  return parts
}

/**
 * Clamp text to a maximum length with an ellipsis.
 * @param {unknown} value - candidate text.
 * @param {number} limit - maximum characters.
 * @returns {string} trimmed text.
 */
function truncate(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Split a Youdao sense line such as `n. 意外发现…；机缘` into part of speech and definitions.
 * @param {string} line - raw sense line.
 * @returns {{pos: string, defs: string[]}} part of speech and cleaned definitions.
 */
export function splitSenseLine(line) {
  let rest = String(line ?? '').trim()
  let pos = ''
  const labeled = POS_PATTERN.exec(rest)
  if (labeled) {
    const raw = labeled[1].toLowerCase()
    pos = POS_SHORT[raw] ?? raw
    rest = rest.slice(labeled[0].length)
  } else {
    const bracketed = /^【([^】]{1,6})】\s*/.exec(rest)
    if (bracketed) {
      // Bracketed CJK labels mark proper nouns and transliterations ("【名】"),
      // which are dictionary padding rather than useful senses.
      pos = /^[\u3400-\u9fff]+$/.test(bracketed[1]) ? 'name' : bracketed[1]
      rest = rest.slice(bracketed[0].length)
    }
  }
  const defs = rest
    .split(/[；;]/)
    .map((part) => part.replace(/^[\s，,、]+|[\s，,、。]+$/g, ''))
    .filter((part) => part !== '')
    .map((part) => truncate(part, MAX_DEF_CHARS))
  return { pos, defs }
}

/**
 * Reduce one meaning to the single word a reader needs.
 *
 * A dictionary line lists every shade — `损坏，损失；损害，伤害` — and a panel
 * that shows all of them buries the meaning. The first term is the head of the
 * line, so it alone stands for the sense.
 *
 * @param {string} text - one meaning line.
 * @returns {string} the leading term.
 */
export function primaryDef(text) {
  const line = typeof text === 'string' ? text.trim() : ''
  if (line === '') return ''
  const cut = line.split(/[，,；;、]/)[0] ?? line
  return truncate(cut.trim(), MAX_DEF_CHARS)
}

/**
 * Keep one meaning per sense.
 * @param {string[]} defs - meanings split out of one dictionary line.
 * @returns {string[]} a single meaning.
 */
export function keepCommonDefs(defs) {
  const list = Array.isArray(defs) ? defs : []
  const first = primaryDef(list[0] ?? '')
  return first === '' ? [] : [first]
}

/**
 * Whether an example sentence is short and simple enough to help a reader.
 *
 * Dictionary corpora are full of literary sentences with quoted speech, names
 * and rare words. An example that needs its own translation table is worse
 * than no example, so keep only the easy ones.
 *
 * @param {unknown} sentence - English example.
 * @returns {boolean} true when the sentence is simple.
 */
export function isSimpleExample(sentence) {
  if (typeof sentence !== 'string') return false
  const text = sentence.trim()
  if (text.length < 12 || text.length > MAX_EXAMPLE_EN_CHARS) return false
  if (/["“”'‘’]/.test(text)) return false
  if (/\d/.test(text)) return false
  if (/[;:—]/.test(text)) return false
  const words = text.split(/\s+/).filter(part => part !== '')
  if (words.length < 3 || words.length > MAX_EXAMPLE_EN_WORDS) return false
  const capitalized = words.filter(part => /^[A-Z][A-Za-z-]+$/.test(part)).length
  return capitalized <= 2
}

const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'some', 'any', 'no', 'every', 'more', 'most', 'less', 'least', 'another', 'each', 'only'])
const COPULAS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'very', 'so', 'too', 'quite'])
const VERB_CUES = new Set(['let', 'can', 'could', 'will', 'would', 'should', 'must', 'may', 'might', 'do', 'does', 'did', 'not', 'please', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'who', 'us', 'them'])
// Words that end in "-ly" without being adverbs. "only detail" and "family
// dinner" would otherwise be read as verb phrases.
const NON_ADVERBS = new Set(['only', 'early', 'daily', 'weekly', 'monthly', 'yearly', 'holy', 'silly', 'lonely', 'likely', 'friendly', 'lovely', 'family', 'reply', 'apply', 'supply', 'belly', 'jelly', 'ally', 'rally', 'ugly', 'italy', 'july', 'assembly', 'monopoly', 'anomaly'])
const PREPOSITIONS = new Set(['in', 'on', 'at', 'from', 'into', 'onto', 'over', 'under', 'of', 'with', 'for', 'by', 'across', 'through'])
const OBJECT_PRONOUNS = new Set(['it', 'him', 'her', 'them', 'us', 'me', 'you'])
const AUXILIARIES = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'do', 'does', 'did'])

/**
 * Guess the part of speech a headword carries inside one example sentence.
 *
 * Youdao returns one flat example list per word, which reads as if every sense
 * shared the same sentences. The surrounding words are a decent clue: a
 * determiner in front means a noun, "-ed"/"-ing" or "to" in front means a verb,
 * a copula in front usually means an adjective.
 *
 * @param {string} sentence - English example.
 * @param {string} headword - dictionary headword.
 * @returns {'noun'|'verb'|'adjective'|null} guessed part of speech.
 */
export function attributeExample(sentence, headword) {
  if (typeof sentence !== 'string' || typeof headword !== 'string') return null
  const lower = sentence.toLowerCase()
  const head = headword.toLowerCase().trim()
  if (head === '') return null
  const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('\\b' + escaped + '(s|es|ed|d|ing|er|est)?\\b').exec(lower)
  if (match === null) return null
  const token = match[0]
  const before = lower.slice(0, match.index).trim().split(/\s+/).filter(part => part !== '')
  const after = lower.slice(match.index + token.length).trim().split(/\s+/).filter(part => part !== '')
  const clean = part => part.replace(/[^a-z']/g, '')
  const previous = before.length === 0 ? '' : clean(before[before.length - 1])
  const beforePrevious = before.length < 2 ? '' : clean(before[before.length - 2])
  const next = after.length === 0 ? '' : clean(after[0])
  const suffix = match[1] ?? ''
  // "Let her run wild": an object pronoun after a verb cue is the verb's object,
  // and the headword right after it acts as the verb.
  if (OBJECT_PRONOUNS.has(previous) && VERB_CUES.has(beforePrevious)) return 'verb'
  // "… are run by outside managers", "… have already run into": an auxiliary
  // nearby makes the headword part of the verb phrase, whatever follows it.
  if (AUXILIARIES.has(previous) || AUXILIARIES.has(beforePrevious)) return 'verb'
  // "The light was bright" heads the phrase as a noun; "A light breeze" does
  // not — there the headword modifies the noun that follows, and guessing noun
  // there is what put "A light breeze was blowing." under `n. 光`.
  if (DETERMINERS.has(previous)) {
    if (next === '' || PREPOSITIONS.has(next) || AUXILIARIES.has(next) || next === 'and' || next === 'or' || next === 'but') return 'noun'
    return null
  }
  if (suffix === 'ing' || suffix === 'ed' || suffix === 'd') return 'verb'
  if (VERB_CUES.has(previous)) return 'verb'
  // "attention to detail" is a noun after a preposition; "to detail the plan"
  // is the infinitive. The word after the headword tells them apart.
  if (previous === 'to') {
    // "attention to detail" — a noun precedes `to`, so the headword is its
    // object; "able to run", "promised to take" — the infinitive follows an
    // adjective or a verb, which `-able`/`-ed`/`-ing` marks well enough.
    if (/(?:able|ible|ed|ing)$/.test(beforePrevious)) return 'verb'
    if (VERB_CUES.has(beforePrevious)) return 'verb'
    if (next === '' || PREPOSITIONS.has(next) || next === 'and' || next === 'or' || next === 'that') return 'noun'
    return 'verb'
  }
  if (next === 'of' || next === 'that' || next === 'which') return 'noun'
  // "Water overflow in the top of the tank" — a noun followed by a preposition
  // is the noun use, not the verb the flat list would suggest.
  if (PREPOSITIONS.has(next) && !VERB_CUES.has(previous) && !AUXILIARIES.has(previous) && !AUXILIARIES.has(beforePrevious)) return 'noun'
  if (COPULAS.has(previous)) return 'adjective'
  // "…, because it will probably overflow." — an adverb in front almost always
  // modifies a verb, and the headword itself is the verb there.
  if (previous.endsWith('ly') && !NON_ADVERBS.has(previous)) return 'verb'
  return null
}

/**
 * Collect bilingual example pairs from a Youdao payload.
 *
 * Only simple sentences survive, shortest first, so the first card under a
 * definition is the easiest thing to read.
 *
 * @param {unknown} pairs - `blng_sents_part['sentence-pair']` value.
 * @param {string} headword - dictionary headword, used for part of speech guessing.
 * @returns {Array<{en: string, zh: string, pos: string|null}>} examples in reading order.
 */
export function parseExamples(pairs, headword = '', wanted = []) {
  if (!Array.isArray(pairs)) return []
  const seen = new Set()
  const strict = []
  const relaxed = []
  for (const pair of pairs) {
    const en = truncate(pair?.sentence, MAX_EXAMPLE_CHARS)
    if (en === '' || seen.has(en)) continue
    seen.add(en)
    const zh = truncate(pair?.['sentence-translation'], MAX_EXAMPLE_CHARS)
    const pos = attributeExample(en, headword)
    if (isSimpleExample(en)) strict.push({ en, zh, pos })
    else if (fitsRelaxed(en)) relaxed.push({ en, zh, pos })
  }
  strict.sort((left, right) => left.en.length - right.en.length)
  // One sentence per part of speech, and nothing else: these are candidates the
  // model aligns to senses afterwards, and a leftover pile of unattributed
  // sentences at the end of the card only confuses the reader.
  const chosen = []
  for (const pos of wanted) {
    if (pos === null || pos === '' || chosen.length >= MAX_EXAMPLES) continue
    if (chosen.some(item => item.pos === pos)) continue
    const candidate = strict.find(item => item.pos === pos)
      ?? relaxed.find(item => item.pos === pos)
    if (candidate !== undefined) chosen.push(candidate)
  }
  return chosen.slice(0, MAX_EXAMPLES)
}

/**
 * Every usable sentence for one headword, in reading order.
 *
 * The per-sense selection below keeps one sentence each, but the aligner also
 * needs the rejected ones: a sentence that does not fit the sense it was
 * guessed for often fits another, and reusing it costs no model tokens.
 *
 * @param {unknown} pairs - candidate pairs.
 * @param {string} headword - dictionary headword.
 * @returns {Array<{en: string, zh: string, pos: string|null}>} uncapped pool.
 */
export function candidatePool(pairs, headword = '') {
  if (!Array.isArray(pairs)) return []
  const seen = new Set()
  const pool = []
  for (const pair of pairs) {
    const en = truncate(pair?.sentence, MAX_EXAMPLE_CHARS)
    if (en === '' || seen.has(en)) continue
    seen.add(en)
    if (!isSimpleExample(en) && !fitsRelaxed(en)) continue
    const zh = truncate(pair?.['sentence-translation'], MAX_EXAMPLE_CHARS)
    pool.push({ en, zh, pos: attributeExample(en, headword) })
    if (pool.length >= MAX_CANDIDATES) break
  }
  return pool
}

/**
 * Whether a sentence is acceptable as a last-resort example.
 * @param {string} sentence - candidate sentence.
 * @returns {boolean} true when it is readable enough to show.
 */
function fitsRelaxed(sentence) {
  if (typeof sentence !== 'string') return false
  const text = sentence.trim()
  if (text.length < 12 || text.length > MAX_EXAMPLE_RELAXED_CHARS) return false
  if (/["“”'‘’]/.test(text)) return false
  const words = text.split(/\s+/).filter(part => part !== '')
  return words.length >= 3 && words.length <= MAX_EXAMPLE_RELAXED_WORDS
}

/**
 * Gather example candidates from every section Youdao returns.
 *
 * `blng_sents_part` carries bilingual pairs, `auth_sents_part` and
 * `media_sents_part` carry quotations and broadcast lines with the headword
 * wrapped in `<b>`; their translations are filled in later.
 *
 * @param {unknown} payload - parsed Youdao JSON.
 * @returns {Array<{sentence: string, 'sentence-translation': string}>} candidates.
 */
export function collectExampleCandidates(payload) {
  const out = []
  const push = (rawSentence, rawTranslation) => {
    const sentence = stripMarkup(rawSentence)
    if (sentence === '') return
    out.push({ sentence, 'sentence-translation': stripMarkup(rawTranslation) })
  }
  for (const pair of payload?.blng_sents_part?.['sentence-pair'] ?? []) {
    push(pair?.sentence, pair?.['sentence-translation'])
  }
  for (const item of payload?.auth_sents_part?.sent ?? []) {
    push(item?.foreign, item?.['sentence-translation'])
  }
  for (const item of payload?.media_sents_part?.sent ?? []) {
    push(item?.eng, item?.['sentence-translation'])
  }
  return out
}

/**
 * Drop inline markup from a Youdao sentence.
 * @param {unknown} value - raw text.
 * @returns {string} plain text.
 */
function stripMarkup(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Parse a Youdao response into the normalized entry shape.
 * @param {unknown} payload - parsed Youdao JSON.
 * @param {string} word - requested word.
 * @returns {{headword: string, phonetic: string, senses: Array<{pos: string, defs: string[]}>, examples: Array<{en: string, zh: string}>, source: 'youdao'}|null} entry or null.
 */
export function parseYoudao(payload, word) {
  const entry = payload?.ec?.word?.[0]
  if (entry === undefined || entry === null) return null
  const phrase = entry['return-phrase'] ?? entry.returnPhrase
  const rawHeadword = typeof phrase === 'string' ? phrase : phrase?.l?.i
  const headword = truncate(
    typeof rawHeadword === 'string' ? rawHeadword : Array.isArray(rawHeadword) ? rawHeadword[0] : '',
    64,
  ) || word
  const phonetic = truncate(entry.usphone ?? entry.ukphone ?? '', 64)
  const senses = []
  const groups = Array.isArray(entry.trs) ? entry.trs : []
  for (const group of groups) {
    const translations = Array.isArray(group?.tr) ? group.tr : []
    for (const translation of translations) {
      const raw = translation?.l?.i
      // Real payloads carry an array of lines; a lone string still has to work
      // without being indexed character by character.
      const line = Array.isArray(raw) ? raw[0] : raw
      if (typeof line !== 'string') continue
      const { pos, defs } = splitSenseLine(line)
      if (defs.length === 0 || pos === 'name') continue
      senses.push({ pos, defs: keepCommonDefs(defs) })
      if (senses.length >= MAX_SENSES * 2) break
    }
    if (senses.length >= MAX_SENSES * 2) break
  }
  if (senses.length === 0) return null
  const kept = senses.slice(0, MAX_SENSES).map((sense) => ({ pos: sense.pos, defs: keepCommonDefs(sense.defs) }))
  const wanted = kept.map((sense) => normalizePos(sense.pos)).filter((pos) => pos !== null)
  const pairs = collectExampleCandidates(payload)
  return {
    headword,
    phonetic,
    senses: kept,
    examples: parseExamples(pairs, word, wanted),
    candidates: candidatePool(pairs, word),
    source: 'youdao',
  }
}

/**
 * Add a Chinese line to examples that came without one.
 * @param {Array<{en: string, zh: string, pos: string|null}>} examples - examples.
 * @param {AbortSignal|undefined} signal - caller signal.
 * @param {typeof translateText} translate - translation entry point.
 * @returns {Promise<Array<object>>} examples with translations when possible.
 */
async function translateMissing(examples, signal, translate, limit = 2) {
  const pending = examples.filter(item => item.zh === '').slice(0, limit)
  if (pending.length === 0) return examples
  if (signal !== undefined && signal.aborted === true) return examples
  const budget = AbortSignal.timeout(limit > 2 ? 2500 : 1500)
  const scoped = signal === undefined ? budget : AbortSignal.any([signal, budget])
  const settled = await Promise.allSettled(pending.map(item => toChinese(item.en, scoped, translate)))
  for (const [index, item] of pending.entries()) {
    const result = settled[index]
    if (result.status === 'fulfilled' && result.value !== item.en) item.zh = truncate(result.value, MAX_EXAMPLE_CHARS)
  }
  return examples
}

/**
 * Fetch and parse the Youdao entry.
 * @param {string} word - requested word.
 * @param {AbortSignal} signal - lookup signal.
 * @returns {Promise<object|null>} normalized entry, or null when the word is not listed.
 */
async function youdaoLookup(word, signal) {
  const url = new URL(YOUDAO_ENDPOINT)
  url.searchParams.set('q', word)
  url.searchParams.set('dict', 'ec')
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
    redirect: 'error',
    credentials: 'omit',
    signal,
  })
  if (!response.ok) return null
  const payload = await readJsonResponse(response, 'youdao')
  return parseYoudao(payload, word)
}

/**
 * Translate a definition into Chinese, keeping the English text when translation fails.
 * @param {string} text - English definition or example.
 * @param {AbortSignal} signal - lookup signal.
 * @param {typeof translateText} translate - translation entry point.
 * @returns {Promise<string>} Chinese text, or the English text on failure.
 */
async function toChinese(text, signal, translate) {
  try {
    const result = await translate({ text, target: 'zh-CN' }, { signal, timeoutMs: 1200 })
    return typeof result?.translation === 'string' && result.translation !== '' ? result.translation : text
  } catch {
    return text
  }
}

/**
 * Fetch an entry from the open dictionary API and translate its definitions.
 * @param {string} word - requested word.
 * @param {AbortSignal} signal - lookup signal.
 * @param {typeof translateText} translate - translation entry point.
 * @returns {Promise<object|null>} normalized entry, or null.
 */
async function freeDictionaryLookup(word, signal, translate) {
  let response
  try {
    response = await fetch(`${FREEDICT_ENDPOINT}${encodeURIComponent(word)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit',
      signal,
    })
  } catch (error) {
    // A host that cannot be reached once usually stays unreachable for a
    // while; remember that so later words do not wait for the same timeout.
    if (signal === undefined || signal.aborted !== true) fallbackDownUntil = Date.now() + FALLBACK_COOLDOWN_MS
    throw error
  }
  if (!response.ok) return null
  const payload = await readJsonResponse(response, 'dictionaryapi.dev')
  const entry = Array.isArray(payload) ? payload[0] : undefined
  if (entry === undefined || entry === null) return null
  const meanings = Array.isArray(entry.meanings) ? entry.meanings.slice(0, MAX_SENSES) : []
  const pending = []
  for (const meaning of meanings) {
    const definitions = Array.isArray(meaning?.definitions) ? meaning.definitions.slice(0, 1) : []
    for (const definition of definitions) {
      const english = truncate(definition?.definition, MAX_DEF_CHARS)
      if (english === '') continue
      pending.push({ pos: truncate(meaning?.partOfSpeech, 16), english, example: truncate(definition?.example, MAX_EXAMPLE_CHARS) })
    }
  }
  if (pending.length === 0) return null
  const translatedDefs = await Promise.allSettled(pending.map((item) => toChinese(item.english, signal, translate)))
  const senseMap = new Map()
  for (const [index, item] of pending.entries()) {
    const settled = translatedDefs[index]
    const text = settled.status === 'fulfilled' ? settled.value : item.english
    const key = item.pos !== '' ? item.pos : '—'
    const bucket = senseMap.get(key) ?? []
    bucket.push(text)
    senseMap.set(key, bucket)
  }
  const exampleSources = pending.filter((item) => item.example !== '' && isSimpleExample(item.example))
  const exampleTranslations = await Promise.allSettled(
    exampleSources.map((item) => toChinese(item.example, signal, translate)),
  )
  const phonetic = truncate(entry.phonetic ?? entry.phonetics?.find?.((item) => typeof item?.text === 'string')?.text ?? '', 64)
  return {
    headword: truncate(entry.word ?? word, 64) || word,
    phonetic,
    senses: Array.from(senseMap, ([pos, defs]) => ({ pos, defs: keepCommonDefs(defs) })).slice(0, MAX_SENSES),
    examples: exampleSources.slice(0, MAX_EXAMPLES).map((item, index) => {
      const settled = exampleTranslations[index]
      return { en: item.example, zh: settled?.status === 'fulfilled' ? settled.value : '', pos: normalizePos(item.pos) }
    }),
    source: 'freedict',
  }
}

/**
 * Look up a single English word, preferring Youdao.
 * @param {string} word - word to look up.
 * @param {{signal?: AbortSignal, timeoutMs?: number, translate?: typeof translateText}} [options] - cancellation and translation hook.
 * @returns {Promise<object|null>} normalized entry, or null when nothing was found.
 */
export async function lookupWord(word, options = {}) {
  const normalized = singleEnglishWord(word)
  if (normalized === null) return null
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const translate = options.translate ?? translateText
  const primaryDeadline = AbortSignal.timeout(timeoutMs)
  const primarySignal = options.signal ? AbortSignal.any([options.signal, primaryDeadline]) : primaryDeadline
  let primary = null
  try {
    primary = await youdaoLookup(normalized, primarySignal)
  } catch {
    // Fall through to the open dictionary API.
  }
  if (primary !== null && primary.examples.length > 0) {
    // Quotation and broadcast examples arrive without a translation; fill at
    // most two of them, and never let that stall the answer.
    primary.examples = await translateMissing(primary.examples, options.signal, translate)
    // The aligner matches sentences to senses by their Chinese line, so the
    // pool needs translations too — a translated corpus sentence is far cheaper
    // than asking the model to write one.
    if (Array.isArray(primary.candidates) && primary.candidates.length > 0) {
      primary.candidates = await translateMissing(primary.candidates, options.signal, translate, 4)
    }
    return primary
  }
  if (Date.now() < fallbackDownUntil) return primary
  // The fallback gets its own budget: the primary lookup usually spends most
  // of the caller's deadline, and a shared clock would abort the second request
  // before it left the machine, leaving such words without any example.
  const fallbackDeadline = AbortSignal.timeout(FALLBACK_TIMEOUT_MS)
  const fallbackSignal = options.signal ? AbortSignal.any([options.signal, fallbackDeadline]) : fallbackDeadline
  let fallback = null
  try {
    fallback = await freeDictionaryLookup(normalized, fallbackSignal, translate)
  } catch {
    fallback = null
  }
  if (primary !== null) {
    if (fallback !== null && fallback.examples.length > 0) primary.examples = fallback.examples.slice(0, MAX_EXAMPLES)
    return primary
  }
  return fallback
}
