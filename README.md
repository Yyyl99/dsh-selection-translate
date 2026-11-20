# 划词翻译

在 DeepSeek Harness 的对话里框选任意一句文本，选区右下角会出现一个小圆点（中文界面显示「译」，英文界面显示「A」）。点一下，圆点下方弹出翻译小窗：

- 句子：原文 + 译文（英汉互译）；
- 单个英文单词：词典式词条 —— 词头、音标、每个词性最多两条中文释义，**每个词性下配一条**双语例句；
- 每段英文后面都有小喇叭，点一下朗读该段（原文、译文或词头）。

不会自动翻译任何内容，弹窗也不改动对话；在小窗内选中文字不会触发新的翻译。

## 安装

在插件市场 / Discover 里搜索 `selection translate`，或打开 **Plugins** 页面，在添加插件输入框里填：

```
github:Yyyl99/dsh-selection-translate
```

已安装 DSH 命令行工具的机器也可以执行：

```sh
dsh plugin add github:Yyyl99/dsh-selection-translate
```

装一次，Desktop 与 `dsh web` 都能用。

## 用法

1. 用鼠标框选对话里的一句话或一个英文单词；
2. 选区右下角出现小圆点，点它；
3. 小窗在圆点下方展开；上排可以切「自动 / 中文 / English」方向，右上是朗读与关闭；
4. 点小窗外、按 Esc、或把选区滚出屏幕，小窗都会收起。

方向默认是「自动」：中文内容译成英文，其余译成中文；手动选过的方向会记住。

## 界面

小窗是不透明卡片：深色底加一档提亮、1px 描边、14px 圆角、较大投影，顶部有一个指向圆点的小尖角，与窗口边缘至少留 20px。高度随内容自适应，只有内容超出窗口时才在卡片内滚动。

- **头部**：查词时显示词头 + 音标（带喇叭），整句时显示 `翻译` 小标题；右侧关闭按钮；
- **整句**：原文（次要色）→ 细分隔线 → 译文（更大更深）；
- **单词**：按词性的释义列，每个词性下缩进一条例句，源词在例句里高亮；词典完全没有该词条时，才用一行机翻作为兜底释义；
- **例句来源**：优先用词典自带的句子，按语义挑与该词性对得上的；仍然缺例句的词性，才请当前窗口使用的模型按词性补一句 —— 对得上就沿用原句，对不上才新写，新写的句子带 `AI` 角标；
- **代码标识符**（如 `diagKey`，机翻会原样返回，看着像「翻不了」）：拆成单词后翻译，并以词条小卡列出每个部分的释义；
- **底部**：`自动 / 中文 / English` 方向胶囊，以及引擎名（查词时再带一个 `词典` 标记）。

## 朗读

优先用窗口自带的语音合成；窗口没有可用语音时，改由宿主通过 Windows SAPI 朗读。正在朗读的那段，喇叭会变成停止方块；点另一段会先停掉上一段。

## 隐私

翻译发给 Bing（`edge.microsoft.com`），查词发给有道（`dict.youdao.com`，未收录时回退 `dictionaryapi.dev`）。选中的文本不写入磁盘；本地只保存方向选择，以及一小段用于排障的诊断记录（`%TEMP%/dsh-selection-translate.log`，只记时间、阶段、尺寸，不记文本）。

---

## English

Select text in a conversation and click the 译 badge at the bottom-right corner of the selection to open a translation card below it. The card shows phonetics, meanings and examples (one bilingual example under each part of speech), and can read any English text aloud. Translation is English ↔ Chinese, on demand only.

Corpus first: the dictionary's own sentences are matched to senses by meaning; only senses left without a sentence go to the model the window already runs on, and those sentences carry an `AI` tag.

Text leaves the machine only to reach Bing Translate and Youdao (fallback: dictionaryapi.dev).

Install from the plugin market, from the Plugins page with `github:Yyyl99/dsh-selection-translate`, or with `dsh plugin add github:Yyyl99/dsh-selection-translate`.
