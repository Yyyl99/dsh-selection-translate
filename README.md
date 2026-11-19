# Selection Translate

Select text anywhere in a DeepSeek Harness conversation, then click the small
dot at the bottom-right corner of the selection. A floating panel opens below
the dot with:

- the translation of the selection (English ↔ Chinese);
- for a single English word, a dictionary entry: headword, phonetic, at most
  two Chinese senses per part of speech and **one** bilingual example under each
  part of speech;
- a speaker button after every English text — the original, the translation,
  or a dictionary headword — that reads exactly that text aloud.

Nothing is translated automatically, and the panel never changes the
conversation. Text inside the panel is not a selection source.

## Look

The panel is an opaque, raised card — the app background over the raised
surface, a 1px border, a 14px radius and a large shadow — with a small caret
pointing back at the dot. It never reads as transparent over the conversation,
and it keeps a 20px margin from the window edge. The card is as tall as its
content — it only scrolls once the text would not fit the window.

- **header**: the headword and phonetic (plus its speaker) for a word lookup,
  or a small `翻译` label for a sentence, then the close button;
- **sentences**: the source text, a hairline, then the translation, which is
  set larger and darker than the source;
- **single words**: part-of-speech senses in a `n.` column with that sense's
  single example indented underneath, the headword highlighted, and nothing
  after the last sense; the machine translation only appears as a one-line gloss
  when the dictionary has no sense for the word;
- **corpus first, model only for what is left**: the dictionary's own sentences
  are matched to senses by meaning — the sense's Chinese term has to appear in
  the sentence's Chinese line — and a sentence whose part of speech agrees gets
  first refusal. Whatever still has no sentence is sent, with the shortlist of
  candidates, to the model the window already runs on
  (`agentDefaultModel.currentSelection()`), which returns one sentence per open
  sense: reuse the candidate when it truly illustrates the sense, otherwise write
  one. Sentences it wrote carry a small `AI` tag. Prompts stay around 350–600
  tokens and replies around 100–200, once per word and sense set, cached in
  memory for an hour and never written to disk; when every sense is answered from
  the corpus the model is not called at all;
- **code identifiers** such as `diagKey` (the engine echoes those untouched,
  which looks like "this cannot be translated"): the token is split into words,
  the spaced form is translated, and the parts appear as glossary chips;
- **footer**: 自动 / 中文 / English pills, and the engine name plus a `词典`
  tag for word lookups.

Every English text carries a speaker icon at the end of its last line; while a
text is being read its icon turns into a stop square.

## How it behaves

- Only a completed selection raises the dot; empty or collapsed selections
  close everything.
- The dot sits at the bottom-right of the last visible line of the selection.
  The panel opens **below the dot** and flips above it only when the viewport
  has no room below.
- The direction buttons are 自动 / 中文 / English. 自动 picks the direction from
  the selection (Chinese text goes to English, everything else to Chinese);
  the choice is stored in the window.
- Reading uses the window's `speechSynthesis` voices; if the window exposes
  none, the host reads through Windows SAPI instead. Each text has its own
  speaker, and starting one stops the previous reading.
- Closing the panel, pressing Escape, clicking elsewhere, or scrolling away
  closes it; scrolling keeps the panel and the dot aligned with the selection
  and hides them only while the selection is off-screen.

## Host routes

Three owner-only exact fetch routes, registered while the plugin is loaded.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/selectionTranslate.lookup` | `{"text": string, "target": "zh-CN" \| "en"}` | `{"translation", "provider", "target", "word", "parts"?}` |
| `POST /api/selectionTranslate.speak` | `{"action": "speak" \| "status" \| "stop", "text"?, "lang"?}` | `{"ok"}` / `{"speaking": boolean}` |
| `POST /api/selectionTranslate.debug` | `{"where": string, "detail"?: object}` | `{"ok": true}` |

A caller that sends `accept: application/x-ndjson` gets the same answer
progressively: one JSON object per line, in the order the pieces become ready
(`translation`, `word`, `parts`, then `done` with the whole payload), so the
dictionary can paint while a slow machine translation is still running. Without
that header the answer is one JSON object, as before.

`lookup` errors: `400` for `BAD_REQUEST`, `EMPTY_TEXT`, `TEXT_LIMIT`,
`UNSUPPORTED_TARGET`; `503 BUSY` above four concurrent lookups (a cached
selection is still served while the limit is reached); `502` for a failed
translation (`504` on timeout); `499 CANCELLED` when the caller drops the
request. The dictionary is best effort — a dictionary failure only sets `word`
to `null`.

`debug` appends one JSON line to `%TEMP%/dsh-selection-translate.log` and
truncates the file past 512KB; bodies over 8KB are refused with `413`.

`speak` answers `501 TTS_UNAVAILABLE` when Windows speech synthesis cannot be
started. The script is static; the text travels through the environment, never
through a command line.

## Privacy

The selected text leaves the machine only to reach the translation service:

- Bing Translator (`edge.microsoft.com`) is used first;
- Google Translate is a fallback when Bing answers nothing usable;
- dictionary entries come from Youdao (`dict.youdao.com`), with
  `dictionaryapi.dev` as a fallback whose English glosses are translated.

Selected text is never written to disk by the plugin. Two things do persist
locally: the direction choice in the window's `localStorage`, and a short
diagnostic trail (timestamps, stages, sizes, `%TEMP%/dsh-selection-translate.log`
plus a 120-entry ring in `localStorage`) that exists so a broken session can be
diagnosed without asking for a screenshot. Responses are cached in memory (100
entries, five minutes) only to avoid repeat requests. The debug route is
owner-only and stays in the host that owns the window.

## Development

```sh
node --check index.js client.js lib/*.js
node scripts/route-test.mjs   # route contract tests with a fake translator
node scripts/lib-test.mjs     # dictionary merge, cache, TTS and debug contracts
node scripts/render-test.mjs  # offline render smoke test of the client panel
node scripts/manifest-test.mjs
node scripts/probe.mjs        # live translation and dictionary probe
```
