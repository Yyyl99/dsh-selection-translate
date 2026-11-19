/**
 * Host half of the selection translator.
 *
 * Three owner-only fetch routes serve the browser half: `lookup` translates a
 * selection (and looks up a single English word), `speak` reads text through
 * Windows SAPI when the window exposes no speech voices, and `debug` appends
 * one diagnostic line so a broken session can be inspected from the host.
 */

import { appendDebug, createDebugHandler } from './lib/debug.js'
import { createExampleWriter } from './lib/examples.js'
import { createLookupHandler } from './lib/route.js'
import { createSpeaker } from './lib/tts.js'

export const name = 'selection-translate'

export const inject = ['connection']

/**
 * Read an optional host service without failing when it is absent.
 * @param {object} ctx - host plugin context.
 * @param {string} name - service name.
 * @returns {object|undefined} service instance.
 */
function readService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Read the model selection this window currently runs on.
 * @param {object} ctx - host plugin context.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|undefined} selection.
 */
function readDefaultSelection(ctx) {
  try {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return undefined
    const selection = service.currentSelection()
    if (selection === undefined || selection === null) return undefined
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return selection
  } catch {
    return undefined
  }
}

/**
 * Register the fetch routes for the lifetime of the plugin.
 * @param {object} ctx - host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  // Dictionary sources rarely cover every sense of a word. When one is left
  // without an example, the window's own model writes it, using the same
  // provider and model this window already talks to.
  const align = createExampleWriter({
    llm: () => readService(ctx, 'llm'),
    selection: () => readDefaultSelection(ctx),
    report: (where, detail) => {
      void appendDebug({ where, detail }).catch(() => {})
    },
  })
  // One line per alignment keeps the whole chain observable from the log: the
  // panel shows the sentences, this says whether the model kept or wrote them.
  const alignExamples = async (entry, context) => {
    const aligned = await align(entry, context)
    if (aligned.length > 0) {
      void appendDebug({
        where: 'align',
        detail: {
          word: typeof entry?.headword === 'string' ? entry.headword : '',
          kept: aligned.filter(item => item.generated !== true).length,
          written: aligned.filter(item => item.generated === true).length,
        },
      }).catch(() => {})
    }
    return aligned
  }
  const selection = readDefaultSelection(ctx)
  void appendDebug({
    where: 'host:apply',
    detail: {
      llm: readService(ctx, 'llm') === undefined ? 'absent' : 'present',
      model: selection === undefined ? 'absent' : `${selection.provider}/${selection.model}`,
    },
  }).catch(() => {})
  const lookup = createLookupHandler({ alignExamples })
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/selectionTranslate.lookup',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: lookup,
    }),
    'selection-translate: lookup route',
  )
  ctx.effect(() => {
    const speaker = createSpeaker()
    const unregister = ctx.connection.fetch.register({
      path: '/api/selectionTranslate.speak',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: speaker.handler,
    })
    return async () => {
      await unregister()
      speaker.dispose()
    }
  }, 'selection-translate: speech route')
  const debug = createDebugHandler()
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: '/api/selectionTranslate.debug',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: debug,
    }),
    'selection-translate: debug route',
  )
}
