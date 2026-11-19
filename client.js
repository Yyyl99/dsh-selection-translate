/**
 * Browser half of the selection translator.
 *
 * Selecting text in a settled message shows a dot at the bottom-right of the
 * selection. Opening the dot renders a floating panel below it with the
 * translation and, for a single English word, a dictionary entry.
 */

window.__ModuleLoader__.load({
  id: '@local/selection-translate',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    const NS = 'selectionTranslate'
    const BUILD = '0.1.5+2026-11-21b'
    /** Set while this bundle instance owns the document-level hooks. */
    let applied = false
    const LOOKUP_PATH = '/api/selectionTranslate.lookup'
    const SPEAK_PATH = '/api/selectionTranslate.speak'
    const DEBUG_PATH = '/api/selectionTranslate.debug'
    const JOURNAL_KEY = 'dsh-selection-translate.events'
    const MAX_TEXT = 4000
    const TARGET_KEY = 'dsh-selection-translate.target'
    const DOT_SIZE = 24
    const GAP = 6
    /** A dismissed selection stays dismissed only briefly: the pointerup that
     * closes a card must not re-open it, but re-selecting the same sentence a
     * moment later is a fresh intent and should show the dot again. */
    const DISMISS_MS = 800
    /** Give up on a lookup the host never answers. */
    const LOOKUP_TIMEOUT_MS = 20_000
    /** Streamed answers: one JSON event per line, drawn as they arrive. */
    const STREAM_TYPE = 'application/x-ndjson'

    const en = {
      'selectionTranslate.action': 'Translate selection',
      'selectionTranslate.direction': 'Translation direction',
      'selectionTranslate.auto': 'Auto',
      'selectionTranslate.autoHint': 'Detect the direction from the selected text',
      'selectionTranslate.toChinese': '中文',
      'selectionTranslate.toEnglish': 'English',
      'selectionTranslate.speak': 'Read the original text',
      'selectionTranslate.stopSpeech': 'Stop reading',
      'selectionTranslate.close': 'Close',
      'selectionTranslate.original': 'Original',
      'selectionTranslate.speakOriginal': 'Read the original text',
      'selectionTranslate.speakTranslation': 'Read the translation',
      'selectionTranslate.translation': 'Translation',
      'selectionTranslate.examples': 'Examples',
      'selectionTranslate.loading': 'Translating…',
      'selectionTranslate.pending': 'Still loading…',
      'selectionTranslate.error': 'Translation failed',
      'selectionTranslate.errorGeneric': 'The request was rejected. Try a shorter selection.',
      'selectionTranslate.errorEmpty': 'Nothing to translate — select a sentence first.',
      'selectionTranslate.errorTooLong': 'That selection is longer than 4000 characters.',
      'selectionTranslate.errorTarget': 'This translation direction is not supported.',
      'selectionTranslate.errorBusy': 'Too many translations at once. Try again in a moment.',
      'selectionTranslate.errorTimeout': 'The translation service timed out.',
      'selectionTranslate.errorUpstream': 'The translation service refused the request.',
      'selectionTranslate.errorNetwork': 'Could not reach the translation service.',
      'selectionTranslate.retry': 'Retry',
      'selectionTranslate.voiceUnavailable': 'Reading is unavailable on this device',
      'selectionTranslate.dictionary': 'Dictionary',
      'selectionTranslate.glyph': 'A',
      'selectionTranslate.panelTitle': 'Translation',
      'selectionTranslate.parts': 'Word parts',
      'selectionTranslate.generated': 'AI',
      'selectionTranslate.generatedTitle': 'Written by the model for a sense the dictionary left empty',
    }

    const zh = {
      'selectionTranslate.action': '翻译所选内容',
      'selectionTranslate.direction': '翻译方向',
      'selectionTranslate.auto': '自动',
      'selectionTranslate.autoHint': '按所选文本自动判断翻译方向',
      'selectionTranslate.toChinese': '中文',
      'selectionTranslate.toEnglish': 'English',
      'selectionTranslate.speak': '朗读原文',
      'selectionTranslate.stopSpeech': '停止朗读',
      'selectionTranslate.close': '关闭',
      'selectionTranslate.original': '原文',
      'selectionTranslate.speakOriginal': '朗读原文',
      'selectionTranslate.speakTranslation': '朗读译文',
      'selectionTranslate.translation': '译文',
      'selectionTranslate.examples': '例句',
      'selectionTranslate.loading': '正在翻译…',
      'selectionTranslate.pending': '还在加载…',
      'selectionTranslate.error': '翻译失败',
      'selectionTranslate.errorGeneric': '请求被拒绝，请缩短所选内容后再试。',
      'selectionTranslate.errorEmpty': '没有可翻译的内容，请先框选一句话。',
      'selectionTranslate.errorTooLong': '所选内容超过 4000 个字符。',
      'selectionTranslate.errorTarget': '不支持这个翻译方向。',
      'selectionTranslate.errorBusy': '同时翻译的请求过多，请稍后再试。',
      'selectionTranslate.errorTimeout': '翻译服务响应超时。',
      'selectionTranslate.errorUpstream': '翻译服务拒绝了本次请求。',
      'selectionTranslate.errorNetwork': '无法连接翻译服务。',
      'selectionTranslate.retry': '重试',
      'selectionTranslate.voiceUnavailable': '当前设备无法朗读',
      'selectionTranslate.dictionary': '词典',
      'selectionTranslate.glyph': '译',
      'selectionTranslate.panelTitle': '翻译',
      'selectionTranslate.parts': '拆词',
      'selectionTranslate.generated': 'AI',
      'selectionTranslate.generatedTitle': '词典缺这一词性的例句，由窗口内的模型补写',
    }

    const CSS = `
.dst-layer{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:inherit}
.dst-dot{position:absolute;width:${DOT_SIZE}px;height:${DOT_SIZE}px;border-radius:50%;border:none;padding:0;
display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-brand-primary,#3b7cff);color:#fff;
font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;
box-shadow:0 1px 5px rgba(0,0,0,.28);transition:transform .12s ease}
.dst-dot:hover{transform:scale(1.08)}
.dst-dot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b7cff);outline-offset:2px}
.dst-dot-glyph{pointer-events:none;font-weight:600}
.dst-panel{position:absolute;pointer-events:auto;display:flex;flex-direction:column;
background-color:var(--dsw-alias-bg-base,#fff);
background-image:linear-gradient(var(--dsw-alias-bg-layer-1,rgba(255,255,255,0)),var(--dsw-alias-bg-layer-1,rgba(255,255,255,0)));
color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));
border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.22),0 2px 10px rgba(0,0,0,.10);
font-size:13px;line-height:1.5}
.dst-panel::before{content:'';position:absolute;top:-7px;left:var(--dst-caret-x,24px);width:14px;height:7px;
background-color:var(--dsw-alias-bg-base,#fff);
background-image:linear-gradient(var(--dsw-alias-bg-layer-1,rgba(255,255,255,0)),var(--dsw-alias-bg-layer-1,rgba(255,255,255,0)));
clip-path:polygon(50% 0,100% 100%,0 100%);
filter:drop-shadow(0 -1px 0 var(--dsw-alias-border-l1,rgba(0,0,0,.14)))}
.dst-panel--above::before{top:auto;bottom:-7px;clip-path:polygon(0 0,100% 0,50% 100%);
filter:drop-shadow(0 1px 0 var(--dsw-alias-border-l1,rgba(0,0,0,.14)))}
.dst-head{display:flex;align-items:center;gap:8px;padding:11px 10px 11px 18px;
border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));border-radius:14px 14px 0 0}
.dst-head-main{display:flex;align-items:baseline;gap:8px;flex:1 1 auto;min-width:0}
.dst-head-word{font-size:17px;font-weight:660;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-head-label{font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-secondary,#8a8a8a);
text-transform:uppercase;white-space:nowrap}
.dst-head-phonetic{font-size:12px;color:var(--dsw-alias-label-secondary,#8a8a8a);white-space:nowrap;
overflow:hidden;text-overflow:ellipsis}
.dst-close{flex:0 0 auto;width:26px;height:26px;border:none;border-radius:7px;background:transparent;
color:var(--dsw-alias-label-secondary,#777);font-size:17px;line-height:1;display:flex;align-items:center;
justify-content:center;cursor:pointer;padding:0;font-family:inherit}
.dst-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,#111)}
.dst-panel button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b7cff);outline-offset:1px}
.dst-square{width:9px;height:9px;border-radius:2px;background:currentColor;display:block}
.dst-body{padding:13px 18px 15px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;
scrollbar-gutter:stable;overscroll-behavior:contain}
.dst-live{display:contents}
.dst-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dst-text--source{color:var(--dsw-alias-label-secondary,#5b5b5b);font-size:13.5px;line-height:1.75}
.dst-text--result{color:var(--dsw-alias-label-primary,#111);font-size:14.5px;line-height:1.75}
.dst-rule{margin:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.dst-say{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:6px;
border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;
padding:0;vertical-align:-6px;font-family:inherit}
.dst-say:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));color:var(--dsw-alias-brand-primary,#3b7cff)}
.dst-say[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-brand-primary,#3b7cff)}
.dst-word-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.dst-headword{font-size:20px;font-weight:650;letter-spacing:-.015em;word-break:break-word}
.dst-phonetic{font-size:12.5px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.dst-sense-block{margin-top:9px}
.dst-sense-block:first-child{margin-top:0}
.dst-sense{display:flex;gap:8px;align-items:baseline}
.dst-pos{flex:none;font-size:11.5px;font-weight:700;line-height:1.75;color:var(--dsw-alias-brand-primary,#3b7cff)}
.dst-defs{font-size:13.5px;line-height:1.65;overflow-wrap:anywhere}
.dst-examples{margin-top:11px;padding:2px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.035))}
.dst-examples--inline{margin:6px 0 0 34px;padding:0 0 0 10px;border-radius:0;background:none;
border-left:2px solid var(--dsw-alias-border-l1,rgba(0,0,0,.09))}
.dst-examples--inline .dst-ex{padding:5px 0}
.dst-ex{padding:8px 0}
.dst-ex+.dst-ex{border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.dst-ex-en{font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.dst-ai{margin-left:6px;padding:0 4px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.02em;vertical-align:1px;
  color:var(--dsw-alias-brand-primary,#3b7cff);background:color-mix(in srgb, var(--dsw-alias-brand-primary,#3b7cff) 12%, transparent)}
.dst-ex-zh{margin-top:3px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#777);overflow-wrap:anywhere}
.dst-hl{color:var(--dsw-alias-brand-primary,#3b7cff);font-weight:600;background:none}
.dst-gloss{margin:0 0 9px;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5f6368)}
.dst-parts{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.dst-parts-label{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
color:var(--dsw-alias-label-secondary,#9a9a9a)}
.dst-chips{display:flex;flex-wrap:wrap;gap:6px}
.dst-chip{display:inline-flex;align-items:baseline;gap:6px;max-width:100%;padding:4px 9px;border-radius:999px;
background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));font-size:12px;line-height:1.5}
.dst-chip-w{font-weight:600}
.dst-chip-m{color:var(--dsw-alias-label-secondary,#777)}
.dst-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 12px 8px 15px;
border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));border-radius:0 0 14px 14px;
font-size:11px;color:var(--dsw-alias-label-secondary,#8a8a8a)}
.dst-engine{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-seg{display:flex;gap:2px;padding:2px;border-radius:8px;flex:0 1 auto;min-width:0;
background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
.dst-seg-btn{flex:0 1 auto;min-width:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#777);
font-size:11.5px;line-height:1;padding:5px 9px;border-radius:6px;cursor:pointer;font-family:inherit;white-space:nowrap}
.dst-seg-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);
box-shadow:0 1px 2px rgba(0,0,0,.14),0 0 0 1px var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dst-error-body{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.dst-error{margin:0;color:var(--dsw-alias-state-error-primary,#d33);font-weight:600}
.dst-error-detail{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#666);word-break:break-word}
.dst-note{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dst-retry{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;
color:var(--dsw-alias-label-primary,#111);font-family:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}
.dst-retry:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.dst-progress{position:relative;height:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
.dst-progress::after{content:'';position:absolute;top:0;bottom:0;left:0;width:38%;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary,#3b7cff),transparent);animation:dst-slide 1.15s linear infinite}
@keyframes dst-slide{from{transform:translateX(-100%)}to{transform:translateX(360%)}}
.dst-skel{height:10px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));
animation:dst-pulse 1.2s ease-in-out infinite}
.dst-skel+.dst-skel{margin-top:8px}
@keyframes dst-pulse{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dst-dot{transition:none}.dst-skel{animation:none}.dst-progress::after{animation:none;width:100%;opacity:.5}}
`
    const STYLE_ID = 'dsh-selection-translate-css'

    /**
     * Add the plugin stylesheet once.
     * @returns {() => void} disposer that removes it.
     */
    function injectStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        if (existing.getAttribute('data-css-build') !== BUILD) {
          existing.textContent = CSS
          existing.setAttribute('data-css-build', BUILD)
        }
        report('styles', { build: BUILD, reused: true })
        return () => {}
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = '@local/selection-translate'
      style.dataset.pluginCss = '@local/selection-translate/client.js'
      style.setAttribute('data-css-build', BUILD)
      style.textContent = CSS
      document.head.append(style)
      report('styles', { build: BUILD, reused: false })
      return () => {
        if (style.getAttribute('data-css-build') === BUILD) style.remove()
      }
    }

    /**
     * Clamp a number into a range.
     * @param {number} value - candidate.
     * @param {number} min - lower bound.
     * @param {number} max - upper bound.
     * @returns {number} clamped value.
     */
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    /**
     * Minimal external store for the dot and panel state.
     * @param {object} initial - initial snapshot.
     * @returns {{get: () => object, set: (next: object) => void, patch: (part: object) => void, subscribe: (fn: () => void) => () => void}} store.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      const store = {
        get: () => snapshot,
        set(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
        patch(part) {
          store.set({ ...snapshot, ...part })
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
      return store
    }

    /**
     * Read the stored target language.
     * @returns {'zh-CN'|'en'} target.
     */
    function readTarget() {
      try {
        const stored = window.localStorage.getItem(TARGET_KEY)
        return stored === 'en' || stored === 'zh-CN' ? stored : 'auto'
      } catch {
        return 'auto'
      }
    }

    /**
     * Persist the chosen target language.
     * @param {'zh-CN'|'en'} target - target.
     * @returns {void}
     */
    function writeTarget(target) {
      try {
        window.localStorage.setItem(TARGET_KEY, target)
      } catch {
        // Storage is optional.
      }
    }

    /**
     * Count Chinese characters in a string.
     * @param {string} text - input.
     * @returns {number} count.
     */
    function cjkCount(text) {
      const match = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)
      return match === null ? 0 : match.length
    }

    /**
     * Pick the target language for one selection.
     * @param {string} text - selected text.
     * @returns {'zh-CN'|'en'} target.
     */
    function chooseTarget(text) {
      const stored = readTarget()
      if (stored !== 'auto') return stored
      return cjkCount(text) > 0 ? 'en' : 'zh-CN'
    }

    /**
     * Project a range to readable text, dropping math and hidden duplicates.
     * @param {Range} range - selection range.
     * @returns {string} normalized text.
     */
    function projectText(range) {
      const holder = document.createElement('div')
      holder.append(range.cloneContents())
      for (const node of holder.querySelectorAll('.katex-mathml, .sr-only, [aria-hidden="true"], button, script, style')) {
        node.remove()
      }
      const blocks = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIGCAPTION',
        'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
        'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'])
      const parts = []
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            parts.push(child.nodeValue.replace(/\s+/g, ' '))
            continue
          }
          if (child.nodeType !== 1) continue
          if (child.tagName === 'BR') {
            parts.push('\n')
            continue
          }
          const isBlock = blocks.has(child.tagName)
          if (isBlock) parts.push('\n')
          walk(child)
          if (isBlock) parts.push('\n')
        }
      }
      walk(holder)
      return parts
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim()
    }

    /**
     * Keep only client rects the viewport can show.
     * @param {Range} range - selection range.
     * @returns {DOMRect[]} visible rects.
     */
    function visibleRects(range) {
      const rects = []
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue
        if (rect.right < 0 || rect.left > window.innerWidth) continue
        rects.push(rect)
      }
      return rects
    }

    /**
     * Place the dot at the bottom-right of the last visible line.
     * @param {DOMRect} rect - last line rect.
     * @returns {{x: number, y: number}} top-left corner in viewport coordinates.
     */
    function dotPosition(rect) {
      const maxX = window.innerWidth - DOT_SIZE - 4
      const maxY = window.innerHeight - DOT_SIZE - 4
      const right = rect.right + GAP
      const bottom = rect.bottom + GAP
      const x = right <= maxX ? right : Math.max(4, rect.right - DOT_SIZE)
      const y = bottom <= maxY ? bottom : Math.max(4, rect.bottom - DOT_SIZE - GAP)
      return { x, y }
    }

    /**
     * Detect whether an event target belongs to this plugin's own UI.
     * @param {EventTarget|null} target - event target.
     * @returns {boolean} true when the target is inside the panel or dot.
     */
    let reported = 0

    /** Ring buffer of interaction steps, mirrored into localStorage so the
     * trace can be read from disk when the host route is unavailable. */
    const journalEntries = []

    /**
     * Append one step to the local journal.
     * @param {string} where - short step name.
     * @param {object} [detail] - small JSON payload.
     * @returns {void}
     */
    function journal(where, detail) {
      try {
        const last = journalEntries[journalEntries.length - 1]
        const at = Date.now()
        if (last !== undefined && last.where === where && at - last.at < 300) return
        journalEntries.push({ where, detail: detail === undefined ? null : detail, at })
        if (journalEntries.length > 120) journalEntries.shift()
        window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(journalEntries))
      } catch {
        // A missing or full storage area must not break the interaction.
      }
    }

    /**
     * Report one diagnostic step to the host log. Fire-and-forget: a failure to
     * report must never disturb the interaction.
     * @param {string} where - short step name.
     * @param {object} [detail] - small JSON payload.
     * @returns {void}
     */
    function report(where, detail) {
      journal(where, detail)
      if (reported > 500) return
      reported += 1
      try {
        const body = JSON.stringify({ where, detail: detail === undefined ? null : detail, at: Date.now() })
        void fetch(DEBUG_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {})
      } catch {
        // Diagnostics are best effort.
      }
    }

    /**
     * Run one interaction step, reporting instead of throwing.
     * @param {string} where - step name.
     * @param {() => void} run - the step.
     * @returns {void}
     */
    function guarded(where, run) {
      try {
        run()
      } catch (error) {
        report('crash', {
          where,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack) : '',
        })
      }
    }

    function isOwnUi(target) {
      return target instanceof Element && target.closest('[data-selection-translate-ui]') !== null
    }

    /**
     * Tell whether a keyboard event belongs to an editable control.
     * @param {EventTarget|null} target - event target.
     * @returns {boolean} true for inputs, editors and our own UI.
     */
    function isEditable(target) {
      if (!(target instanceof Element)) return false
      if (target.closest('[data-selection-translate-ui]') !== null) return true
      return target.closest('input, textarea, select, [contenteditable=""]') !== null ||
        target.closest('[contenteditable="true"]') !== null ||
        target.closest('[contenteditable="plaintext-only"]') !== null
    }

    /**
     * Split text into speech-friendly pieces.
     * @param {string} text - original text.
     * @param {number} [limit] - soft limit per piece.
     * @returns {string[]} pieces.
     */
    function splitSpeech(text, limit = 180) {
      const sentences = []
      let buffer = ''
      for (const character of text) {
        buffer += character
        if ('。！？；;!?'.includes(character)) {
          sentences.push(buffer)
          buffer = ''
        }
      }
      if (buffer.trim() !== '') sentences.push(buffer)
      const pieces = []
      let current = ''
      for (const sentence of sentences) {
        if (sentence.length > limit) {
          if (current.trim() !== '') pieces.push(current)
          current = ''
          for (let index = 0; index < sentence.length; index += limit) pieces.push(sentence.slice(index, index + limit))
          continue
        }
        if (current.length + sentence.length > limit && current.trim() !== '') {
          pieces.push(current)
          current = ''
        }
        current += sentence
      }
      if (current.trim() !== '') pieces.push(current)
      return pieces.map(piece => piece.trim()).filter(piece => piece !== '')
    }

    /**
     * Speech language tag for the original text.
     * @param {string} text - text to read.
     * @returns {string} BCP-47 tag.
     */
    function speechLang(text) {
      return cjkCount(text) > 0 ? 'zh-CN' : 'en-US'
    }

    /**
     * Whether a text is English enough to offer reading aloud.
     * @param {string} value - text.
     * @returns {boolean} true when it holds Latin letters and no CJK.
     */
    function isEnglish(value) {
      if (typeof value !== 'string' || value === '') return false
      if (cjkCount(value) > 0) return false
      return /[A-Za-z]/.test(value)
    }

    /**
     * Voice facade: renderer speech synthesis first, host SAPI as fallback.
     * @param {(event: {type: 'end'|'unavailable'}) => void} notify - completion callback.
     * @returns {{speak: (text: string, lang: string) => Promise<void>, stop: () => void}} voice.
     */
    function createVoice(notify) {
      const synth = 'speechSynthesis' in window ? window.speechSynthesis : null
      const Utterance = typeof window.SpeechSynthesisUtterance === 'function' ? window.SpeechSynthesisUtterance : null
      let session = 0
      let pieces = []
      let index = 0
      let hostSpeaking = false
      let hostPoll = 0
      let watchdog = 0
      let voice = null
      let lang = 'en-US'

      const clearTimers = () => {
        if (watchdog !== 0) {
          clearTimeout(watchdog)
          watchdog = 0
        }
        if (hostPoll !== 0) {
          clearInterval(hostPoll)
          hostPoll = 0
        }
      }

      const cancelSynth = () => {
        if (synth === null) return
        try {
          synth.cancel()
        } catch {
          // Ignore a broken synthesizer.
        }
      }

      /**
       * Settle one speech session.
       * @param {boolean} unavailable - whether reading could not start.
       * @param {number} mine - session that owns the work.
       * @returns {void}
       */
      const settle = (unavailable, mine) => {
        if (mine !== session) return
        clearTimers()
        cancelSynth()
        if (hostSpeaking) {
          hostSpeaking = false
          void post({ action: 'stop', id: String(mine) })
        }
        notify({ type: unavailable === true ? 'unavailable' : 'end' })
      }

      /**
       * Invalidate the running session and silence both engines.
       * @returns {void}
       */
      const stopInternal = () => {
        const previous = session
        session += 1
        clearTimers()
        cancelSynth()
        if (hostSpeaking) {
          hostSpeaking = false
          void post({ action: 'stop', id: String(previous) })
        }
      }

      /**
       * POST to the speech route.
       * @param {object} body - request body.
       * @returns {Promise<Response|null>} response, or null when the request failed.
       */
      async function post(body) {
        try {
          return await fetch(SPEAK_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          return null
        }
      }

      /**
       * Read the available voices, waiting briefly for a late population.
       * @returns {Promise<SpeechSynthesisVoice[]>} voices.
       */
      async function readVoices() {
        if (synth === null) return []
        const immediate = synth.getVoices()
        if (immediate.length > 0) return immediate
        return await new Promise((resolve) => {
          let done = false
          const settleRead = (list) => {
            if (done) return
            done = true
            clearTimeout(timer)
            if (typeof synth.removeEventListener === 'function') synth.removeEventListener('voiceschanged', onChanged)
            resolve(list)
          }
          const onChanged = () => settleRead(synth.getVoices())
          const timer = setTimeout(() => settleRead(synth.getVoices()), 800)
          if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', onChanged)
        })
      }

      /**
       * Choose a voice for a language tag.
       * @param {SpeechSynthesisVoice[]} list - voices.
       * @param {string} tag - language tag.
       * @returns {SpeechSynthesisVoice|null} voice.
       */
      function pick(list, tag) {
        const wanted = tag.toLowerCase().replace('_', '-')
        const short = wanted.split('-')[0]
        return list.find(item => typeof item.lang === 'string' && item.lang.toLowerCase().replace('_', '-') === wanted)
          ?? list.find(item => typeof item.lang === 'string' && item.lang.toLowerCase().startsWith(short))
          ?? null
      }

      const armWatchdog = (mine) => {
        if (watchdog !== 0) clearTimeout(watchdog)
        watchdog = setTimeout(() => settle(false, mine), 60_000)
      }

      const speakNext = (mine) => {
        if (mine !== session) return
        if (index >= pieces.length) {
          settle(false, mine)
          return
        }
        const utterance = new Utterance(pieces[index])
        if (voice !== null) utterance.voice = voice
        utterance.lang = (voice !== null && typeof voice.lang === 'string' && voice.lang !== '') ? voice.lang : lang
        utterance.rate = 1
        utterance.onend = () => {
          if (mine !== session) return
          index += 1
          speakNext(mine)
        }
        utterance.onerror = () => settle(false, mine)
        armWatchdog(mine)
        try {
          synth.speak(utterance)
        } catch {
          settle(false, mine)
        }
      }

      const speakHost = async (text, tag, mine) => {
        hostSpeaking = true
        const response = await post({ action: 'speak', text, lang: tag, id: String(mine) })
        if (mine !== session) return
        if (response === null || response.ok !== true) {
          hostSpeaking = false
          settle(true, mine)
          return
        }
        const started = Date.now()
        hostPoll = setInterval(async () => {
          if (mine !== session) return
          if (Date.now() - started > 120_000) {
            settle(false, mine)
            return
          }
          const status = await post({ action: 'status' })
          if (status === null || status.ok !== true) return
          const data = await status.json().catch(() => null)
          if (data !== null && data.speaking === false) settle(false, mine)
        }, 600)
      }

      return {
        async speak(text, tag) {
          stopInternal()
          const mine = session
          lang = tag
          const list = await readVoices()
          if (mine !== session) return
          const chosen = pick(list, tag)
          if (synth !== null && Utterance !== null && chosen !== null) {
            voice = chosen
            pieces = splitSpeech(text)
            index = 0
            speakNext(mine)
            return
          }
          await speakHost(text, tag, mine)
        },
        stop() {
          stopInternal()
        },
      }
    }

    /**
     * Parse one streamed line into an event.
     * @param {string} line - raw line from the body.
     * @returns {object|null} event, or null for padding and broken lines.
     */
    function parseEvent(line) {
      const trimmed = typeof line === 'string' ? line.trim() : ''
      if (trimmed === '') return null
      try {
        const value = JSON.parse(trimmed)
        return value !== null && typeof value === 'object' && typeof value.type === 'string' ? value : null
      } catch {
        return null
      }
    }

    /**
     * Read a streamed lookup answer as a sequence of events.
     * @param {Response} response - NDJSON response from the host.
     * @returns {AsyncGenerator<object>} events, ending after `done`.
     */
    async function* readEvents(response) {
      const body = response.body
      if (body === null || body === undefined || typeof body.getReader !== 'function') {
        const text = await response.text().catch(() => '')
        for (const line of text.split('\n')) {
          const event = parseEvent(line)
          if (event === null) continue
          yield event
          if (event.type === 'done') return
        }
        return
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let raw = ''
      let seen = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done === true) break
          const piece = decoder.decode(chunk.value, { stream: true })
          raw += piece
          buffer += piece
          let cut = buffer.indexOf('\n')
          while (cut !== -1) {
            const event = parseEvent(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 1)
            if (event !== null) {
              seen += 1
              yield event
              if (event.type === 'done') return
            }
            cut = buffer.indexOf('\n')
          }
        }
        const tail = buffer + decoder.decode()
        raw += ''
        const last = parseEvent(tail)
        if (last !== null) {
          seen += 1
          yield last
          return
        }
        // A host that predates the streamed contract answers with one JSON
        // object and no line break; treat it as a finished answer so a client
        // that loaded ahead of its host still works.
        if (seen === 0) {
          const whole = (raw + tail).trim()
          if (whole.startsWith('{')) {
            try {
              const payload = JSON.parse(whole)
              if (payload !== null && typeof payload === 'object') yield { type: 'done', payload }
            } catch {
              // Broken answers are reported by the caller as a bad body.
            }
          }
        }
      } finally {
        void Promise.resolve(reader.cancel()).catch(() => {})
      }
    }

    /**
     * Read the current selection and build one selection record.
     * @returns {{text: string, range: Range, rects: DOMRect[]}|null} selection.
     */
    function readSelection() {
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const container = range.commonAncestorContainer
      if (isOwnUi(container.nodeType === 1 ? container : container.parentElement)) return null
      const text = projectText(range)
      if (text === '') return null
      const rects = visibleRects(range)
      if (rects.length === 0) return null
      return { text: text.slice(0, MAX_TEXT), range: range.cloneRange(), rects }
    }

    // The stored direction is read in `start` rather than here: this factory
    // runs at module evaluation, and touching localStorage there would make
    // merely loading the bundle a side effect.
    const store = createStore({ phase: 'idle', dot: null, targetMode: 'auto', target: 'zh-CN', text: '', loading: false, pending: false, error: null, data: null, speaking: false, speakingText: null, voiceError: false })

    const controller = {
      ctx: null,
      anchor: null,
      request: null,
      voice: null,
      /** Text the user dismissed, so a stray pointerup cannot re-open it. */
      dismissed: null,
      /** When that dismissal happened, so it can expire. */
      dismissedAt: 0,

      /**
       * Attach document listeners and create the voice facade.
       * @param {object} ctx - client plugin context.
       * @returns {() => void} disposer.
       */
      start(ctx) {
        if (this.connected) return () => {}
        this.connected = true
        this.ctx = ctx
        this.voice = createVoice((event) => {
          if (event.type === 'unavailable') store.patch({ speaking: false, speakingText: null, voiceError: true })
          else store.patch({ speaking: false, speakingText: null })
        })
        let frame = 0
        let pressing = false
        report('boot', { build: BUILD })
        store.patch({ targetMode: readTarget() })
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            this.evaluate()
          })
        }
        const onPointerUp = (event) => guarded('pointerup', () => {
          const own = isOwnUi(event.target)
          pressing = false
          if (own) return
          schedule()
        })
        const onPointerDown = (event) => guarded('pointerdown', () => {
          if (isOwnUi(event.target)) {
            pressing = false
            return
          }
          const snapshot = store.get()
          // Forgive a click that lands just beside the dot: a 24px circle is a
          // small target, and closing on a near miss reads as a lost click.
          if (snapshot.phase === 'dot' && snapshot.dot !== null) {
            const dx = event.clientX - (snapshot.dot.x + DOT_SIZE / 2)
            const dy = event.clientY - (snapshot.dot.y + DOT_SIZE / 2)
            if (Math.hypot(dx, dy) <= DOT_SIZE) {
              pressing = false
              return
            }
          }
          pressing = true
          if (snapshot.phase !== 'idle') this.close('pointer-outside')
        })
        const onKeyDown = (event) => guarded('keydown', () => {
          if (event.key === 'Escape' && store.get().phase !== 'idle') {
            this.close('escape')
            return
          }
          if (isEditable(event.target)) return
          if (event.shiftKey || event.key.startsWith('Arrow') || event.key === 'a' || event.key === 'A') schedule()
        })
        const onScroll = () => guarded('scroll', () => this.reposition())
        const onResize = () => guarded('resize', () => this.reposition())
        const onSelectionChange = () => guarded('selectionchange', () => {
          const selection = window.getSelection()
          const empty = selection === null || selection.isCollapsed
          if (empty) {
            if (store.get().phase === 'dot') this.close('collapsed')
            return
          }
          // A drag released outside the chat column, or a programmatic range,
          // can miss pointerup. Refresh from the selection event so the dot
          // stays reachable instead of waiting for a click we never receive.
          if (!pressing && store.get().phase === 'idle') schedule()
        })
        document.addEventListener('pointerup', onPointerUp, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('selectionchange', onSelectionChange)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onResize)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          document.removeEventListener('pointerup', onPointerUp, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('selectionchange', onSelectionChange)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onResize)
          this.connected = false
          this.abort()
          this.voice.stop()
        }
      },

      /**
       * Refresh the dot from the current selection.
       * @returns {void}
       */
      evaluate() {
        const phase = store.get().phase
        const selection = readSelection()
        if (selection === null) {
          // Reporting every empty click floods the log with noise; the state
          // machine only needs to hear about emptiness when it changes something.
          if (phase !== 'idle') {
            const live = window.getSelection()
            report('evaluate:empty', {
              phase,
              rangeCount: live === null ? -1 : live.rangeCount,
              collapsed: live === null ? true : live.isCollapsed,
            })
          }
          if (phase === 'dot') this.close('empty-selection')
          return
        }
        if (this.dismissed !== null) {
          if (selection.text === this.dismissed && Date.now() - this.dismissedAt < DISMISS_MS) return
          this.dismissed = null
        }
        if (phase === 'panel' && selection.text === store.get().text) return
        if (phase === 'panel') {
          this.abort()
          if (this.voice !== null) this.voice.stop()
        }
        this.anchor = selection.range
        const last = selection.rects[selection.rects.length - 1]
        store.set({
          phase: 'dot',
          dot: dotPosition(last),
          targetMode: readTarget(),
          target: chooseTarget(selection.text),
          text: selection.text,
          loading: false,
          error: null,
          data: null,
          speaking: false,
          speakingText: null,
          voiceError: false,
        })
        report('evaluate:dot', { phase, chars: selection.text.length, rects: selection.rects.length })
      },

      /**
       * Reposition open UI after a scroll or resize.
       * @returns {void}
       */
      reposition() {
        const phase = store.get().phase
        if (phase === 'idle') return
        const anchor = this.anchor
        if (anchor === null) return
        const rects = visibleRects(anchor)
        if (rects.length === 0) {
          report('reposition:offscreen', { phase })
          if (phase === 'dot') store.patch({ dot: null })
          return
        }
        store.patch({ dot: dotPosition(rects[rects.length - 1]) })
      },

      /**
       * Open the panel for the current selection and run the lookup.
       * @returns {void}
       */
      open() {
        if (store.get().phase !== 'dot') return
        report('open', { chars: store.get().text.length, target: store.get().target })
        store.patch({ phase: 'panel', loading: true, pending: true, error: null, data: null, speaking: false, speakingText: null, voiceError: false })
        void this.lookup()
      },

      /**
       * Close the dot and the panel.
       * @returns {void}
       */
      /**
       * Drop the dot and the panel.
       * @param {string} [reason] - why the surface closed, for the host log.
       * @returns {void}
       */
      close(reason) {
        const phase = store.get().phase
        if (phase === 'idle') return
        report('close', { reason: reason === undefined ? 'unspecified' : reason, phase })
        const label = reason === undefined ? 'unspecified' : reason
        // Keep the dismissed text so the pointerup that follows a click-away
        // does not immediately put the dot back over the same selection.
        this.dismissed = label === 'collapsed' || label === 'empty-selection' || store.get().text === '' ? null : store.get().text
        this.dismissedAt = Date.now()
        this.abort()
        if (this.voice !== null) this.voice.stop()
        this.anchor = null
        store.set({ phase: 'idle', dot: null, targetMode: readTarget(), target: 'zh-CN', text: '', loading: false, pending: false, error: null, data: null, speaking: false, speakingText: null, voiceError: false })
      },

      /**
       * Cancel the in-flight lookup.
       * @returns {void}
       */
      abort() {
        if (this.request !== null) {
          this.request.abort()
          this.request = null
        }
      },

      /**
       * Run the lookup for the current text and target.
       * @returns {Promise<void>} resolves once the panel state settled.
       */
      async lookup() {
        const state = store.get()
        const text = state.text
        const target = state.target
        this.abort()
        const request = new AbortController()
        this.request = request
        let timedOut = false
        const timer = window.setTimeout(() => {
          if (this.request !== request) return
          timedOut = true
          request.abort()
        }, LOOKUP_TIMEOUT_MS)
        report('lookup:start', { chars: text.length, target })
        try {
          const response = await fetch(LOOKUP_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: STREAM_TYPE },
            body: JSON.stringify({ text, target }),
            signal: request.signal,
          })
          if (this.request !== request) return
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            if (this.request !== request) return
            const code = payload !== null && typeof payload.code === 'string' ? payload.code : 'BAD_REQUEST'
            report('lookup:http-error', { status: response.status, code })
            store.patch({ loading: false, pending: false, error: code, data: null })
            return
          }
          const partial = { translation: '', provider: '', target, word: null, parts: null }
          let failure = null
          for await (const event of readEvents(response)) {
            if (this.request !== request) return
            if (event.type === 'error') {
              failure = typeof event.code === 'string' ? event.code : 'TRANSLATION_FAILED'
              continue
            }
            if (event.type === 'done' && event.payload !== null && typeof event.payload === 'object') {
              const payload = event.payload
              store.patch({
                loading: false,
                pending: false,
                error: null,
                data: {
                  translation: typeof payload.translation === 'string' ? payload.translation : partial.translation,
                  provider: typeof payload.provider === 'string' ? payload.provider : partial.provider,
                  target,
                  word: payload.word !== null && typeof payload.word === 'object' ? payload.word : partial.word,
                  parts: Array.isArray(payload.parts) ? payload.parts : partial.parts,
                },
              })
              continue
            }
            if (event.type === 'translation' || event.type === 'word' || event.type === 'parts') {
              if (typeof event.translation === 'string') partial.translation = event.translation
              if (typeof event.provider === 'string') partial.provider = event.provider
              if (event.type === 'word' && event.word !== null && typeof event.word === 'object') partial.word = event.word
              if (event.type === 'parts' && Array.isArray(event.parts)) partial.parts = event.parts
              // Paint what arrived: the dictionary answers long before a slow
              // machine translation, and the reader should not stare at a
              // skeleton while one half is already known.
              store.patch({ loading: false, pending: false, error: null, data: { ...partial } })
            }
          }
          if (this.request !== request) return
          if (failure !== null) {
            report('lookup:http-error', { status: response.status, code: failure })
            store.patch({ loading: false, pending: false, error: failure, data: null })
            return
          }
          if (partial.translation === '') {
            report('lookup:bad-body', { status: response.status })
            store.patch({ loading: false, pending: false, error: 'BAD_RESPONSE', data: null })
            return
          }
          report('lookup:ok', { provider: partial.provider, chars: partial.translation.length, word: partial.word !== null })
          store.patch({ loading: false, pending: false, error: null, data: { ...partial } })
        } catch (error) {
          if (request.signal.aborted) {
            if (timedOut === true) {
              report('lookup:timeout', { chars: text.length })
              store.patch({ loading: false, pending: false, error: 'TIMEOUT', data: null })
            }
            return
          }
          report('lookup:network', { message: error instanceof Error ? error.message : String(error) })
          store.patch({ loading: false, pending: false, error: 'NETWORK', data: null })
        } finally {
          window.clearTimeout(timer)
          if (this.request === request) this.request = null
        }
      },

      /**
       * Switch the translation direction and translate again.
       * @param {'auto'|'zh-CN'|'en'} mode - stored direction preference.
       * @returns {void}
       */
      setTarget(mode) {
        const stored = mode === 'auto' || mode === 'en' || mode === 'zh-CN' ? mode : 'auto'
        writeTarget(stored)
        const resolved = stored === 'auto' ? chooseTarget(store.get().text) : stored
        store.patch({ targetMode: stored, target: resolved })
        if (store.get().phase === 'panel') {
          store.patch({ loading: true, pending: true, error: null, data: null })
          void this.lookup()
        }
      },

      /**
       * Read one text of the open panel aloud, or stop it when it already runs.
       * @param {string} [value] - text to read; the selection when omitted.
       * @returns {void}
       */
      toggleSpeak(value) {
        const state = store.get()
        if (state.phase !== 'panel') return
        const text = typeof value === 'string' && value !== '' ? value : state.text
        if (text === '') return
        if (state.speaking === true && state.speakingText === text) {
          this.voice.stop()
          store.patch({ speaking: false, speakingText: null })
          return
        }
        store.patch({ speaking: true, speakingText: text, voiceError: false })
        void this.voice.speak(text, speechLang(text))
      },
    }

    /**
     * Speaker icon.
     * @returns {object} React element.
     */
    function speakIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M8.2 2.4 5 5.1H2.6v5.8H5l3.2 2.7z', fill: 'currentColor' }),
        h('path', { d: 'M10.6 5.4a3.4 3.4 0 0 1 0 5.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    /**
     * Stop icon.
     * @returns {object} React element.
     */
    function stopIcon() {
      return h('span', { className: 'dst-square', 'aria-hidden': 'true' })
    }

    /**
     * Dot that opens the panel.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @returns {object} React element.
     */
    function renderDot(state, t) {
      const label = t('selectionTranslate.action')
      return h('div', { className: 'dst-layer', 'data-selection-translate-ui': '' },
        h('button', {
          type: 'button',
          className: 'dst-dot',
          style: { left: `${state.dot.x}px`, top: `${state.dot.y}px` },
          title: label,
          'aria-label': label,
          'aria-expanded': state.phase === 'panel',
          'aria-haspopup': 'dialog',
          onPointerDown: event => {
            event.preventDefault()
            event.stopPropagation()
          },
          onClick: event => {
            event.preventDefault()
            event.stopPropagation()
            controller.open()
          },
        }, h('span', { className: 'dst-dot-glyph', 'aria-hidden': 'true' }, t('selectionTranslate.glyph'))))
    }

    /**
     * Render a part-of-speech label in dictionary style.
     * @param {string} pos - raw label such as `n` or `vt`.
     * @returns {string} label with a trailing period.
     */
    function posLabel(pos) {
      if (typeof pos !== 'string' || pos === '') return ''
      return /^[a-z]{1,5}$/i.test(pos) ? `${pos}.` : pos
    }

    /**
     * Normalize a part of speech into its long name, matching host payloads.
     * @param {unknown} pos - raw part of speech.
     * @returns {string|null} long name.
     */
    function posName(pos) {
      if (typeof pos !== 'string') return null
      const key = pos.toLowerCase().trim().replace(/\.$/, '')
      if (key === 'n' || key === 'noun') return 'noun'
      if (key === 'v' || key === 'verb') return 'verb'
      if (key === 'adj' || key === 'adjective') return 'adjective'
      if (key === 'adv' || key === 'adverb') return 'adverb'
      return null
    }

    /**
     * Inline speaker toggle appended after an English text.
     * @param {string} value - text to read.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @param {string} labelKey - locale key for the idle label.
     * @returns {object|null} React element, or null for non-English text.
     */
    function sayButton(value, state, t, labelKey) {
      if (!isEnglish(value)) return null
      const active = state.speaking === true && state.speakingText === value
      const label = active ? t('selectionTranslate.stopSpeech') : t(labelKey)
      return h('button', {
        type: 'button',
        className: 'dst-say',
        title: label,
        'aria-label': label,
        'aria-pressed': active,
        onPointerDown: event => event.preventDefault(),
        onClick: event => {
          event.preventDefault()
          event.stopPropagation()
          controller.toggleSpeak(value)
        },
      }, active ? stopIcon() : speakIcon())
    }

    /**
     * Wrap occurrences of a term inside an example sentence.
     * @param {string} text - example sentence.
     * @param {string} term - headword to highlight.
     * @returns {object[]} React children.
     */
    function highlight(text, term) {
      const source = typeof text === 'string' ? text : ''
      const needle = typeof term === 'string' ? term.trim() : ''
      if (needle === '') return [source]
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const parts = source.split(new RegExp(`(${escaped}\\w{0,3})`, 'gi'))
      return parts.map((part, index) => (index % 2 === 1
        ? h('mark', { className: 'dst-hl', key: `hl-${index}` }, part)
        : part))
    }

    /**
     * Glossary chips for a code identifier, e.g. `diagKey` → 诊断 + 键.
     * @param {object[]} parts - `{word, meaning}` entries.
     * @param {(key: string) => string} t - translator.
     * @returns {object|null} React element, or null when there is nothing to show.
     */
    function renderParts(parts, t) {
      const entries = Array.isArray(parts) ? parts.filter(part => part !== null && typeof part.word === 'string' && part.word !== '') : []
      if (entries.length === 0) return null
      return h('div', { className: 'dst-parts' },
        h('p', { className: 'dst-parts-label' }, t('selectionTranslate.parts')),
        h('div', { className: 'dst-chips' },
          entries.map((part, index) => h('span', { className: 'dst-chip', key: `part-${index}` },
            h('span', { className: 'dst-chip-w' }, part.word),
            typeof part.meaning === 'string' && part.meaning !== ''
              ? h('span', { className: 'dst-chip-m' }, part.meaning)
              : null))))
    }

    /**
     * Panel header: headword plus phonetic, or the mode label, then the close action.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @returns {object} React element.
     */
    function renderHead(state, t) {
      const data = state.data
      const word = data !== null && data.word !== null && data.word !== undefined ? data.word : null
      const rawPhonetic = word !== null && typeof word.phonetic === 'string' ? word.phonetic.trim() : ''
      const phonetic = rawPhonetic === '' ? '' : (rawPhonetic.startsWith('/') ? rawPhonetic : `/${rawPhonetic}/`)
      const headword = word === null
        ? ''
        : (typeof word.headword === 'string' && word.headword !== '' ? word.headword : state.text)
      return h('div', { className: 'dst-head' },
        h('div', { className: 'dst-head-main' },
          word !== null
            ? h('span', { className: 'dst-head-word' }, headword)
            : h('span', { className: 'dst-head-label' }, t('selectionTranslate.panelTitle')),
          word !== null && phonetic !== ''
            ? h('span', { className: 'dst-head-phonetic' }, phonetic)
            : null,
          word !== null ? sayButton(headword, state, t, 'selectionTranslate.speakOriginal') : null),
        h('button', {
          type: 'button',
          className: 'dst-close',
          title: t('selectionTranslate.close'),
          'aria-label': t('selectionTranslate.close'),
          onPointerDown: event => event.preventDefault(),
          onClick: () => controller.close(),
        }, '×'))
    }

    /**
     * Dictionary body for a single word: parts of speech, then examples.
     * @param {object} word - dictionary entry.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @returns {object[]} React children.
     */
    function renderWord(word, state, t) {
      const senses = Array.isArray(word.senses) ? word.senses : []
      const examples = Array.isArray(word.examples) ? word.examples : []
      const headword = typeof word.headword === 'string' && word.headword !== '' ? word.headword : state.text
      // Examples arrive as one flat list; the host tags each with a guessed part
      // of speech so it can sit under the sense it illustrates.
      const sensePos = senses.map(sense => posName(sense.pos))
      const attached = senses.map(() => [])
      for (const example of examples) {
        const pos = posName(example.pos)
        const index = pos === null ? -1 : sensePos.indexOf(pos)
        // One sentence per sense, and only when it illustrates that sense:
        // borrowing a leftover sentence is what put "a light breeze" under the
        // "光线" sense, which reads as a wrong example rather than a missing one.
        if (index >= 0 && attached[index].length === 0) attached[index].push(example)
      }
      const exampleNode = (example, key) => h('div', { className: 'dst-ex', key },
        h('div', { className: 'dst-ex-en' },
          highlight(example.en, headword),
          example.generated === true ? h('span', { className: 'dst-ai', title: t('selectionTranslate.generatedTitle') }, t('selectionTranslate.generated')) : null),
        typeof example.zh === 'string' && example.zh !== '' ? h('div', { className: 'dst-ex-zh' }, example.zh) : null)
      return [
        senses.length === 0 ? null : h('div', { key: 'senses' },
          senses.map((sense, index) => h('div', { className: 'dst-sense-block', key: `sense-${index}` },
            h('div', { className: 'dst-sense' },
              h('span', { className: 'dst-pos' }, posLabel(sense.pos)),
              h('div', { className: 'dst-defs' }, (Array.isArray(sense.defs) ? sense.defs : []).join('；'))),
            attached[index].length === 0 ? null : h('div', { className: 'dst-examples dst-examples--inline' },
              attached[index].map((example, key) => exampleNode(example, `ex-${index}-${key}`)))))),
      ]
    }

    /**
     * Panel body for the settled lookup result.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @returns {object[]} React children.
     */
    function renderResult(state, t) {
      const data = state.data
      const word = data !== null && data.word !== null && data.word !== undefined ? data.word : null
      const translation = data === null || typeof data.translation !== 'string' ? '' : data.translation
      const parts = data !== null && Array.isArray(data.parts) ? data.parts : null
      if (word !== null) {
        const described = Array.isArray(word.senses) && word.senses.length > 0
        return [
          translation === '' || described ? null : h('p', { className: 'dst-gloss', key: 'gloss' }, translation,
            sayButton(translation, state, t, 'selectionTranslate.speakTranslation')),
          h(React.Fragment, { key: 'word' }, renderWord(word, state, t)),
        ]
      }
      return [
        h('p', { className: 'dst-text dst-text--source', key: 'source' }, state.text,
          sayButton(state.text, state, t, 'selectionTranslate.speakOriginal')),
        h('div', { className: 'dst-rule', key: 'rule' }),
        translation === ''
          ? h('div', { className: 'dst-skel', key: 'translation', style: { width: '86%' } })
          : h('p', { className: 'dst-text dst-text--result', key: 'translation' }, translation,
            sayButton(translation, state, t, 'selectionTranslate.speakTranslation')),
        parts === null ? null : renderParts(parts, t),
      ]
    }

    /**
     * Loading skeleton.
     *
     * The selected text is already known when the panel opens, so it is shown
     * immediately; only the translation line waits for the host.
     *
     * @param {object} state - store snapshot.
     * @returns {object} React element.
     */
    function renderSkeleton(state) {
      return h(React.Fragment, null,
        state.text === '' ? null : h('p', { className: 'dst-text dst-text--source', key: 'source' }, state.text),
        h('div', { className: 'dst-skel', style: { width: '38%' } }),
        h('div', { className: 'dst-skel', style: { width: '92%' } }),
        h('div', { className: 'dst-skel', style: { width: '74%' } }))
    }

    /**
     * Error state with a retry action.
     * @param {object} state - store snapshot.
     * @param {(key: string) => string} t - translator.
     * @returns {object} React element.
     */
    /** Host error codes mapped to locale keys. */
    const ERROR_KEYS = {
      EMPTY_TEXT: 'selectionTranslate.errorEmpty',
      TEXT_LIMIT: 'selectionTranslate.errorTooLong',
      UNSUPPORTED_TARGET: 'selectionTranslate.errorTarget',
      BAD_REQUEST: 'selectionTranslate.errorGeneric',
      BUSY: 'selectionTranslate.errorBusy',
      TIMEOUT: 'selectionTranslate.errorTimeout',
      TRANSLATION_FAILED: 'selectionTranslate.errorUpstream',
      BAD_RESPONSE: 'selectionTranslate.errorGeneric',
      NETWORK: 'selectionTranslate.errorNetwork',
    }

    function renderError(state, t) {
      const key = Object.prototype.hasOwnProperty.call(ERROR_KEYS, state.error) ? ERROR_KEYS[state.error] : 'selectionTranslate.errorGeneric'
      return h('div', { className: 'dst-error-body' },
        h('p', { className: 'dst-error' }, t('selectionTranslate.error')),
        h('p', { className: 'dst-error-detail' }, t(key) || ''),
        h('button', {
          type: 'button',
          className: 'dst-retry',
          onPointerDown: event => event.preventDefault(),
          onClick: () => {
            store.patch({ loading: true, error: null })
            void controller.lookup()
          },
        }, t('selectionTranslate.retry')))
    }

    /**
     * Floating panel anchored below the dot.
     * @param {object} props - slot props.
     * @returns {object|null} React element.
     */
    /**
     * Keeps one failing render from unmounting the whole overlay entry: without
     * it a single bad prop would silently kill every later selection.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        report('render:crash', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack) : '',
          componentStack: info !== null && info !== undefined && typeof info.componentStack === 'string' ? info.componentStack : '',
        })
        // Leave the surface idle instead of stuck in a phase that renders
        // nothing, so the next selection still offers the dot. Deferred: a
        // synchronous store write during commit can re-enter React and turn
        // one bad render into an update loop.
        window.setTimeout(() => controller.close('render-crash'), 0)
      }

      render() {
        return this.state.failed === true ? null : this.props.children
      }
    }

    /**
     * Boundary host: remounts the surface whenever the selection changes, so a
     * crashed render heals on the next selection instead of staying dead.
     * @param {object} props - slot props.
     * @returns {object} element.
     */
    function SelectionTranslateSlot(props) {
      const state = React.useSyncExternalStore(store.subscribe, store.get, store.get)
      const resetKey = `${state.phase}:${state.text.slice(0, 24)}`
      return h(PanelBoundary, { key: resetKey }, h(SelectionTranslate, props))
    }

    function SelectionTranslate(props) {
      const t = props.t
      const state = React.useSyncExternalStore(store.subscribe, store.get, store.get)
      const panelRef = React.useRef(null)
      const [measured, setMeasured] = React.useState(0)
      const [fontTick, setFontTick] = React.useState(0)
      const measureCount = React.useRef(0)
      React.useLayoutEffect(() => {
        if (state.phase !== 'panel') return
        const node = panelRef.current
        if (node === null) return
        if (measureCount.current >= 6) return
        // maxHeight clamps the measured box, so add up the real content instead:
        // the body reports its full scroll height, head and foot are intrinsic.
        const headNode = node.querySelector('.dst-head')
        const bodyNode = node.querySelector('.dst-body')
        const footNode = node.querySelector('.dst-foot')
        const height = (headNode === null ? 0 : headNode.offsetHeight)
          + (bodyNode === null ? 0 : bodyNode.scrollHeight)
          + (footNode === null ? 0 : footNode.offsetHeight) + 2
        if (height < 40) return
        if (Math.abs(height - measured) < 2) return
        measureCount.current += 1
        setMeasured(height)
        const body = node.querySelector('.dst-body')
        report('panel:geometry', {
          build: BUILD,
          panelH: Math.round(node.getBoundingClientRect().height),
          top: Math.round(node.getBoundingClientRect().top),
          left: Math.round(node.getBoundingClientRect().left),
          width: Math.round(node.getBoundingClientRect().width),
          bodyScrollW: body === null ? 0 : body.scrollWidth,
          bodyClientW: body === null ? 0 : body.clientWidth,
          bodyScrollH: body === null ? 0 : body.scrollHeight,
          bodyClientH: body === null ? 0 : body.clientHeight,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
        })
      }, [state.phase, state.text, state.loading, state.error, state.data, measured, fontTick])
      React.useEffect(() => {
        measureCount.current = 0
        setMeasured(0)
      }, [state.text, state.phase])
      // Wrapping can settle one frame after the data arrives (images, fonts,
      // a late translation), which used to leave the card at the height of the
      // loading state. Watch the body itself so a late reflow is picked up.
      React.useEffect(() => {
        if (state.phase !== 'panel') return () => {}
        const node = panelRef.current
        if (node === null) return () => {}
        const body = node.querySelector('.dst-body')
        if (body === null || typeof ResizeObserver !== 'function') return () => {}
        let pending = 0
        const observer = new ResizeObserver(() => {
          if (pending !== 0) return
          pending = window.requestAnimationFrame(() => {
            pending = 0
            if (measureCount.current >= 8) return
            const headNode = node.querySelector('.dst-head')
            const footNode = node.querySelector('.dst-foot')
            const height = (headNode === null ? 0 : headNode.offsetHeight)
              + body.scrollHeight
              + (footNode === null ? 0 : footNode.offsetHeight) + 2
            if (height < 40) return
            measureCount.current += 1
            setMeasured((previous) => (Math.abs(previous - height) < 2 ? previous : height))
          })
        })
        observer.observe(body)
        return () => {
          observer.disconnect()
          if (pending !== 0) window.cancelAnimationFrame(pending)
        }
      }, [state.phase, state.text, state.loading, state.error, state.data])
      // A web font that lands after the first paint changes the text metrics,
      // so the measured height must be allowed one more pass once it settles.
      React.useEffect(() => {
        const fonts = typeof document === 'undefined' ? undefined : document.fonts
        if (fonts === undefined || fonts === null || typeof fonts.ready?.then !== 'function') return () => {}
        let live = true
        fonts.ready.then(() => {
          if (!live) return
          measureCount.current = 0
          setFontTick((value) => value + 1)
        }).catch(() => {})
        return () => {
          live = false
        }
      }, [])
      if (state.phase === 'idle') return null
      if (state.phase === 'dot') return state.dot === null ? null : renderDot(state, t)
      if (state.dot === null) return null

      const MARGIN = 20
      const width = Math.min(420, Math.max(240, window.innerWidth - MARGIN * 2))
      const maxHeight = Math.min(440, Math.max(160, window.innerHeight - MARGIN * 2))
      const below = state.dot.y + 12
      const roomBelow = Math.max(0, window.innerHeight - below - MARGIN)
      const roomAbove = Math.max(0, state.dot.y - 12 - MARGIN)
      const natural = measured > 0 ? measured : Math.min(180, maxHeight)
      // Stay inside the viewport: prefer the side the panel actually fits on,
      // otherwise the roomier side, and never let the card run past an edge.
      const placeBelow = natural <= roomBelow || roomBelow >= roomAbove
      const above = !placeBelow
      const room = placeBelow ? roomBelow : roomAbove
      const height = Math.max(80, Math.min(natural, maxHeight, room))
      const top = placeBelow
        ? Math.min(below, Math.max(MARGIN, window.innerHeight - MARGIN - height))
        : Math.max(MARGIN, state.dot.y - 12 - height)
      const left = clamp(state.dot.x - DOT_SIZE, MARGIN, Math.max(MARGIN, window.innerWidth - width - MARGIN))
      const caretX = clamp(state.dot.x + DOT_SIZE / 2 - left, 16, Math.max(16, width - 30))
      const provider = state.data !== null && typeof state.data.provider === 'string' ? state.data.provider : ''
      const providerLabel = provider === 'bing' ? 'Bing' : provider === 'google' ? 'Google' : ''

      return h('div', { className: 'dst-layer', 'data-selection-translate-ui': '' },
        h('section', {
          ref: panelRef,
          className: above ? 'dst-panel dst-panel--above' : 'dst-panel',
          role: 'dialog',
          'aria-label': t('selectionTranslate.action'),
          'aria-busy': state.loading,
          style: {
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            maxHeight: `${height}px`,
            '--dst-caret-x': `${caretX}px`,
          },
          onPointerDown: event => event.preventDefault(),
        },
        renderHead(state, t),
        state.pending === true ? h('div', { className: 'dst-progress', role: 'progressbar', 'aria-label': t('selectionTranslate.pending') }) : null,
        h('div', { className: 'dst-body' },
          state.error !== null ? h('div', { className: 'dst-live', role: 'alert' }, renderError(state, t))
            : state.data === null && state.loading === true ? h('div', { className: 'dst-live', role: 'status', 'aria-live': 'polite' }, renderSkeleton(state))
              : h('div', { className: 'dst-live', role: 'status', 'aria-live': 'polite' },
                renderResult(state, t),
                state.voiceError === true ? h('p', { className: 'dst-note' }, t('selectionTranslate.voiceUnavailable')) : null)),
        h('div', { className: 'dst-foot' },
          h('div', { className: 'dst-seg', role: 'group', 'aria-label': t('selectionTranslate.direction') },
            h('button', {
              type: 'button',
              className: 'dst-seg-btn',
              'aria-pressed': state.targetMode === 'auto',
              title: t('selectionTranslate.autoHint'),
              onPointerDown: event => event.preventDefault(),
              onClick: () => controller.setTarget('auto'),
            }, t('selectionTranslate.auto')),
            h('button', {
              type: 'button',
              className: 'dst-seg-btn',
              'aria-pressed': state.targetMode === 'zh-CN',
              onPointerDown: event => event.preventDefault(),
              onClick: () => controller.setTarget('zh-CN'),
            }, t('selectionTranslate.toChinese')),
            h('button', {
              type: 'button',
              className: 'dst-seg-btn',
              'aria-pressed': state.targetMode === 'en',
              onPointerDown: event => event.preventDefault(),
              onClick: () => controller.setTarget('en'),
            }, t('selectionTranslate.toEnglish'))),
          h('span', { className: 'dst-engine' },
            state.data !== null && state.data.word !== null && state.data.word !== undefined
              ? `${providerLabel} · ${t('selectionTranslate.dictionary')}`
              : providerLabel))))
    }

    return {
      name: 'selection-translate',
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (applied) return
        applied = true
        ctx.effect(() => () => {
          applied = false
        }, 'selection-translate: applied')
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'selection-translate: dictionaries')
        ctx.effect(() => injectStyles(), 'selection-translate: styles')
        ctx.effect(() => controller.start(ctx), 'selection-translate: selection listeners')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'selection-translate',
          order: 100,
          locale: NS,
        }, SelectionTranslateSlot))
      },
      /** Test-only handles for the offline render smoke test. */
      __test: { store, controller, SelectionTranslateSlot, report, css: CSS },
    }
  },
})
