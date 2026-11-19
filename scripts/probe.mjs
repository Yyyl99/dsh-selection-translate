/**
 * Live probe for the translation and dictionary backends.
 *
 * Run with `node scripts/probe.mjs`. It prints what each upstream answered so a
 * failure can be told apart from a network problem.
 */

import { translateText, normalizeTarget } from '../lib/translate.js'
import { lookupWord } from '../lib/dictionary.js'

/**
 * Print one labelled block.
 * @param {string} label - section title.
 * @param {unknown} value - value to show.
 * @returns {void}
 */
function show(label, value) {
  console.log(`\n### ${label}`)
  console.log(JSON.stringify(value, null, 2))
}

/**
 * Run one probe and report failures instead of throwing.
 * @param {string} label - section title.
 * @param {() => Promise<unknown>} run - probe body.
 * @returns {Promise<void>} resolves when printed.
 */
async function probe(label, run) {
  try {
    show(label, await run())
  } catch (error) {
    show(label, { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
  }
}

console.log('targets:', normalizeTarget('zh'), normalizeTarget('en'), normalizeTarget('de'))

await probe('translate: English sentence to Chinese', () => translateText({ text: 'Serendipity often visits the prepared mind.', target: 'zh-CN' }))
await probe('translate: Chinese sentence to English', () => translateText({ text: '今天适合测试划词翻译。', target: 'en' }))
await probe('translate: code line', () => translateText({ text: 'const answer = () => 42', target: 'zh-CN' }))
await probe('dictionary: single word', () => lookupWord('serendipity'))
await probe('dictionary: phrasal verb', () => lookupWord('take off'))
await probe('dictionary: unknown word', () => lookupWord('notaword123x'))
