# 划词翻译

在 DeepSeek Harness 的对话里框选任意一句文本，选区右下角会出现一个小圆点（中文界面显示「译」，英文界面显示「A」）。点一下，圆点下方弹出翻译小窗：

- 句子：原文 + 译文（英汉互译）；
- 单个英文单词：一个词典式词条 —— 词头、音标、每个词性最多两条中文释义，**每个词性下配一条**双语例句；
- 每段英文后面都有小喇叭，点一下朗读该段（原文、译文或词头）。

不会自动翻译任何内容，弹窗也不改动对话；在小窗内选中文字不会触发新的翻译。

## 安装

**方式一（推荐）**：在 DSH 的插件市场 / Discover 里搜索 `selection translate`，一键安装。

**方式二**：命令行安装

```sh
dsh plugin add github:Yyy199/dsh-selection-translate
```

装好后插件立即生效：宿主半身改动需要重启 DSH，前端半身热重载。

## 用法

1. 用鼠标框选对话里的一句话或一个英文单词；
2. 选区右下角出现小圆点，点它；
3. 小窗在圆点下方展开；上排可以切「自动 / 中文 / English」方向，右上是朗读与关闭；
4. 点小窗外、按 Esc、或把选区滚出屏幕，小窗都会收起。

方向默认是「自动」：中文内容译成英文，其余译成中文；手动选过的方向会记住。

## 界面

小窗是不透明卡片：`--dsw-alias-bg-base` 打底、`--dsw-alias-bg-layer-1` 提亮，1px 描边、14px 圆角、较大投影，顶部有一个指向圆点的小尖角，与窗口边缘至少留 20px。高度随内容自适应，只有内容超出窗口时才在卡片内滚动。

- **头部**：查词时显示词头 + 音标（带喇叭），整句时显示 `翻译` 小标题；右侧关闭按钮；
- **整句**：原文（次要色）→ 细分隔线 → 译文（更大更深）；
- **单词**：按词性的释义列，每个词性下缩进一条例句，源词在例句里高亮；最后一个词性之后不再追加内容。词典完全没有该词条时，才用一行机翻作为兜底释义；
- **语料优先，模型只补缺口**：词典自带的例句先按语义匹配 —— 该词性的中文释义要出现在例句的中文里，词性一致的例句优先。仍然缺例句的词性，才带着候选短名单交给窗口当前使用的模型（`agentDefaultModel.currentSelection()`），由它按词性各给一句：候选句真的对得上就沿用，对不上就自己写一句，自己写的句子带 `AI` 角标。一次 prompt 约 350–600 token、回复约 100–200 token，按「单词 + 释义集合」在内存里缓存一小时，不落盘；全部由语料命中时不调用模型；
- **代码标识符**（如 `diagKey`，机翻会原样返回，看着像「翻不了」）：拆成单词后翻译，并以词条小卡列出每个部分的释义；
- **底部**：`自动 / 中文 / English` 方向胶囊，以及引擎名（查词时再带一个 `词典` 标记）。

## 朗读

优先用窗口自带的 `speechSynthesis` 语音；窗口没有可用语音时，改由宿主通过 Windows SAPI 朗读（PowerShell 脚本是静态的，文本走环境变量传入，不进命令行）。正在朗读的那段，喇叭会变成停止方块；点另一段会先停掉上一段。

## 宿主接口

插件加载期间注册三条**仅限本窗口调用**的精确路由：

| 路由 | 请求体 | 返回 |
| --- | --- | --- |
| `POST /api/selectionTranslate.lookup` | `{"text": string, "target": "zh-CN" \| "en"}` | `{"translation", "provider", "target", "word", "parts"?}` |
| `POST /api/selectionTranslate.speak` | `{"action": "speak" \| "status" \| "stop", "text"?, "lang"?}` | `{"ok"}` / `{"speaking": boolean}` |
| `POST /api/selectionTranslate.debug` | `{"where": string, "detail"?: object}` | `{"ok": true}` |

请求头带 `accept: application/x-ndjson` 时，同一个答案会按到达顺序逐行推送（`translation`、`word`、`parts`，最后 `done` 带完整结果），所以词典可以先画出来、机翻还在跑；不带这个头则仍返回单个 JSON。

`lookup` 的错误码：`400`（`BAD_REQUEST`、`EMPTY_TEXT`、`TEXT_LIMIT`、`UNSUPPORTED_TARGET`）、`503 BUSY`（并发超过 4 个，此时缓存命中的请求仍然照常返回）、`502`（翻译失败）/`504`（超时）、`499 CANCELLED`（调用方断开）。词典是尽力而为：词典失败只会让 `word` 变成 `null`，译文不受影响。

`debug` 往 `%TEMP%/dsh-selection-translate.log` 追加 JSON 行，超过 512KB 清空；请求体超过 8KB 返回 `413`。

`speak` 在 Windows 语音合成起不来时返回 `501 TTS_UNAVAILABLE`。

## 隐私

选中的文本只会为翻译离开本机：

- 首选 Bing 翻译（`edge.microsoft.com`）；
- Bing 没有给出可用结果时，回退 Google 翻译；
- 词条来自有道（`dict.youdao.com`），回退 `dictionaryapi.dev`（其英文释义会再机翻一次）。

插件不把选中文本写入磁盘。本地只会落下两样东西：方向选择（窗口的 `localStorage`），以及一小段诊断轨迹（时间戳、阶段、尺寸，写在 `%TEMP%/dsh-selection-translate.log`，并在 `localStorage` 里保留 120 条环形缓冲）—— 它的存在是为了出问题时不必让你截图描述现象。响应只在内存里缓存（100 条 / 5 分钟）以减少重复请求。

## 开发

```sh
node --check index.js client.js lib/*.js
node scripts/route-test.mjs   # 路由契约测试（注入假翻译器，不联网）
node scripts/lib-test.mjs     # 词典合并、缓存、TTS、debug 契约
node scripts/render-test.mjs  # 客户端面板的离线渲染冒烟测试
node scripts/manifest-test.mjs
node scripts/probe.mjs        # 真实网络的翻译与词典探测
```

---

## English

Select text in a conversation and click the 译 badge at the bottom-right corner of the selection to open a translation card below it. The card shows phonetics, meanings and examples (one bilingual example under each part of speech), and can read any English text aloud. Translation is English ↔ Chinese, on demand only.

- Corpus first: the dictionary's own sentences are matched to senses by meaning; only senses left without a sentence go to the model the window already runs on, and those sentences carry an `AI` tag. Model results are cached in memory for an hour and never written to disk.
- Three owner-only host routes: `lookup` (also streams as `application/x-ndjson`), `speak`, and a local `debug` log used for diagnostics.
- Text leaves the machine only to reach Bing / Google Translate and Youdao (fallback: dictionaryapi.dev).

Install: `dsh plugin add github:Yyy199/dsh-selection-translate`
