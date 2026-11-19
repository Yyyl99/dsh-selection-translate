/**
 * Host-side speech synthesis fallback for the renderer.
 *
 * The Desktop window normally reads text with `window.speechSynthesis`; when
 * Chromium exposes no voices, this route speaks through Windows SAPI instead.
 * The text travels through the environment, never through a command string, so
 * the static script below cannot be injected.
 */

import { spawn } from 'node:child_process'

export const MAX_SPEECH_CHARS = 4000
const MAX_UTTERANCE_MS = 90_000
const SPAWN_TIMEOUT_MS = 1500

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo($env:DST_LANG))
} catch {
  # Keep the default voice when the requested culture is unavailable.
}
$voice.Speak($env:DST_TEXT)
$voice.Dispose()
`

/**
 * Build a JSON response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - serializable payload.
 * @returns {Response} JSON response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Normalize a language tag to a Windows speech culture.
 * @param {unknown} tag - requested language.
 * @returns {string} `zh-CN` or `en-US`.
 */
export function speechLanguage(tag) {
  const value = typeof tag === 'string' ? tag.trim().toLowerCase() : ''
  if (value.startsWith('zh') || value.startsWith('ja') || value.startsWith('ko')) {
    return value.startsWith('zh') ? 'zh-CN' : 'en-US'
  }
  return 'en-US'
}

/**
 * Remove characters that a speech engine would choke on.
 * @param {string} text - raw text.
 * @returns {string} printable text.
 */
function sanitize(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
}

/**
 * Create the speech route handler and its child-process owner.
 * @param {{spawn?: typeof spawn, powershell?: string}} [options] - injectable process factory.
 * @returns {{handler: (request: Request) => Promise<Response>, dispose: () => void, speaking: () => boolean}} speaker.
 */
export function createSpeaker(options = {}) {
  const spawnProcess = options.spawn ?? spawn
  const powershell = options.powershell ?? 'powershell.exe'
  let child = null
  let timer = null
  let unavailable = false
  const cancelled = new Set()

  /**
   * Remember a cancelled session id, keeping the set small.
   * @param {string} id - client session id.
   * @returns {void}
   */
  function rememberCancelled(id) {
    cancelled.add(id)
    while (cancelled.size > 64) {
      const oldest = cancelled.values().next()
      if (oldest.done === true) break
      cancelled.delete(oldest.value)
    }
  }

  /**
   * Kill the current utterance and clear its watchdog.
   * @returns {void}
   */
  function stop() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const current = child
    child = null
    if (current !== null && current.exitCode === null && current.killed !== true) {
      try {
        current.kill()
      } catch {
        // The process already exited.
      }
    }
  }

  /**
   * Handle one speech request.
   * @param {Request} request - POST with `{action, text?, lang?}`.
   * @returns {Promise<Response>} JSON response.
   */
  const handler = async (request) => {
    if (request.method !== 'POST') return json(405, { code: 'METHOD_NOT_ALLOWED' })
    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { code: 'BAD_REQUEST', message: 'request body must be JSON' })
    }
    const action = typeof body?.action === 'string' ? body.action : 'speak'
    if (action === 'status') return json(200, { speaking: child !== null })
    if (action === 'stop') {
      if (typeof body?.id === 'string' && body.id !== '') rememberCancelled(body.id)
      stop()
      return json(200, { ok: true })
    }
    if (action !== 'speak') return json(400, { code: 'BAD_ACTION', message: 'action must be speak, status or stop' })
    if (unavailable) return json(501, { code: 'TTS_UNAVAILABLE', message: 'Windows speech synthesis is unavailable' })
    const text = typeof body?.text === 'string' ? sanitize(body.text) : ''
    if (text === '') return json(400, { code: 'EMPTY_TEXT', message: 'text must not be empty' })
    if (text.length > MAX_SPEECH_CHARS) {
      return json(400, { code: 'TEXT_LIMIT', message: `text exceeds ${MAX_SPEECH_CHARS} characters` })
    }
    const lang = speechLanguage(body?.lang)
    const sessionId = typeof body?.id === 'string' ? body.id : ''
    if (sessionId !== '' && cancelled.has(sessionId)) {
      return json(200, { ok: true, speaking: false })
    }
    stop()
    const next = spawnProcess(powershell, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', SCRIPT], {
      windowsHide: true,
      env: { ...process.env, DST_TEXT: text, DST_LANG: lang },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    // Claim the utterance before waiting for the spawn event: a stop that
    // arrives during that window must be able to kill this child instead of
    // leaving it to speak over the next one.
    child = next
    // The error listener stays attached for the whole life of the process: a
    // spawn failure that lands after the readiness race has already settled
    // would otherwise be an unhandled 'error' event and take the host down.
    let spawnFailed = false
    next.on('error', (error) => {
      if (error?.code === 'ENOENT') unavailable = true
      spawnFailed = true
      if (child === next) {
        child = null
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
    })
    const ready = await new Promise((resolve) => {
      const onSpawn = () => {
        clearTimeout(timeout)
        next.off('error', onEarlyError)
        resolve(true)
      }
      const onEarlyError = () => {
        clearTimeout(timeout)
        resolve(false)
      }
      const timeout = setTimeout(() => resolve(true), SPAWN_TIMEOUT_MS)
      next.once('spawn', onSpawn)
      next.once('error', onEarlyError)
    })
    if (ready !== true || spawnFailed === true || child !== next) {
      if (child === next) child = null
      try {
        next.kill()
      } catch {
        // Already gone.
      }
      return json(501, { code: 'TTS_UNAVAILABLE', message: 'Windows speech synthesis is unavailable' })
    }
    timer = setTimeout(() => stop(), MAX_UTTERANCE_MS)
    timer.unref?.()
    const finish = () => {
      if (child === next) {
        child = null
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
    }
    next.once('exit', finish)
    next.once('close', finish)
    return json(200, { ok: true })
  }

  return {
    handler,
    dispose: stop,
    speaking: () => child !== null,
  }
}
