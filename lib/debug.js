/**
 * Diagnostic sink for the selection-translate client.
 *
 * The Web client has no console feed a plugin can read back, so the client half
 * reports what it did to this route and the host appends one JSON line to a
 * small log file in the operating system's temporary directory.
 *
 * @module @local/selection-translate/lib/debug
 */

import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Log file kept small on purpose; it is a debugging aid, not a record. */
const MAX_BYTES = 512 * 1024
/** One report is a small object; anything larger is not a diagnostic. */
const MAX_BODY_CHARS = 8 * 1024
const MAX_STRING_CHARS = 400
const MAX_ARRAY_ITEMS = 20
const MAX_DEPTH = 4

/**
 * Shrink a report so a stray large payload cannot fill the log.
 * @param {unknown} value - parsed report.
 * @param {number} [depth] - current depth.
 * @returns {unknown} a bounded copy.
 */
function bound(value, depth = 0) {
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '…'
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(item => bound(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, MAX_ARRAY_ITEMS)) out[key] = bound(item, depth + 1)
  return out
}

/**
 * @typedef {object} DebugHandlerOptions
 * @property {string} [file] - log path, defaults to the OS temporary folder.
 */

/**
 * Build the fetch handler for `POST /api/selectionTranslate.debug`.
 * @param {DebugHandlerOptions} [options] - handler options.
 * @returns {(request: Request) => Promise<Response>} fetch handler.
 */
export function createDebugHandler(options = {}) {
  const file = options.file ?? join(tmpdir(), 'dsh-selection-translate.log')

  return async function handler(request) {
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
    }
    const raw = await request.text()
    if (raw.length > MAX_BODY_CHARS) return jsonResponse(413, { ok: false, code: 'TOO_LARGE' })
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = null
    }
    try {
      await appendDebug(body, { file })
    } catch (error) {
      return jsonResponse(500, { ok: false, code: 'WRITE_FAILED', message: String(error && error.message) })
    }
    return jsonResponse(200, { ok: true })
  }
}

/**
 * Append one bounded report to the diagnostic log.
 *
 * The fetch handler uses this, and the host half calls it directly to record
 * facts a page cannot report about itself, such as whether a host service was
 * reachable when the plugin applied.
 *
 * @param {unknown} entry - report body.
 * @param {{file?: string}} [options] - log path.
 * @returns {Promise<void>} resolves once the line is written.
 */
export async function appendDebug(entry, options = {}) {
  const file = options.file ?? join(tmpdir(), 'dsh-selection-translate.log')
  const line = `${new Date().toISOString()} ${JSON.stringify(bound(entry))}\n`
  await roll(file)
  await appendFile(file, line, 'utf8')
}

/**
 * Truncate the log once it grows past the cap.
 * @param {string} file - log path.
 * @returns {Promise<void>} resolves after the directory check.
 */
async function roll(file) {
  try {
    const info = await stat(file)
    if (info.size > MAX_BYTES) await writeFile(file, '')
  } catch {
    await mkdir(dirname(file), { recursive: true })
  }
}

/**
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON body.
 * @returns {Response} JSON response.
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
