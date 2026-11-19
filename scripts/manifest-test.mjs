/**
 * Offline manifest check: exports, files, icon rules, locale metadata and the
 * Cordis patch entry. Run with `node scripts/manifest-test.mjs`.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const at = (name) => join(root, name)
const read = (name) => readFileSync(at(name), 'utf8')
const problems = []
const require = (condition, message) => {
  if (!condition) problems.push(message)
}

const pkg = JSON.parse(read('package.json'))
const clientKeys = new Set(['platform', 'inject', 'external', 'immediately'])
for (const key of Object.keys(pkg.dsh?.client ?? {})) {
  require(clientKeys.has(key), `dsh.client 不允许的键: ${key}`)
}
require(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform 必须是 web')
require(pkg.type === 'module', 'package.json 必须声明 "type": "module"')
require(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 必须指向 ./cordis.patch.yml')

const exactExports = ['.', './client', './icon']
for (const key of exactExports) require(key in pkg.exports, `exports 缺少 ${key}`)
require('./locale/*.json' in pkg.exports, 'exports 缺少 ./locale/*.json')

for (const [key, target] of Object.entries(pkg.exports)) {
  if (typeof target !== 'string' || target.includes('*')) continue
  require(existsSync(at(target)), `exports ${key} -> ${target} 不存在`)
}

for (const entry of pkg.files) {
  if (entry.includes('*')) continue
  require(existsSync(at(entry)), `files 条目不存在: ${entry}`)
}

const runtime = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'lib/translate.js',
  'lib/dictionary.js',
  'lib/route.js',
  'lib/tts.js',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'README.md',
]
for (const name of runtime) require(existsSync(at(name)), `缺少运行时文件: ${name}`)

for (const name of ['locale/en.json', 'locale/zh.json']) {
  let meta = {}
  try {
    meta = JSON.parse(read(name)).meta ?? {}
  } catch (error) {
    problems.push(`${name} 不是合法 JSON: ${error.message}`)
    continue
  }
  require(typeof meta.title === 'string' && meta.title !== '', `${name} meta.title 缺失`)
  require(typeof meta.description === 'string' && meta.description !== '', `${name} meta.description 缺失`)
}

const svg = read('icon.svg')
require(/viewBox="0 0 36 36"/.test(svg), 'icon.svg 的 viewBox 必须是 0 0 36 36')
for (const tag of ['<style', '<script', '<text', '<image', 'foreignObject']) {
  require(!svg.includes(tag), `icon.svg 不允许出现 ${tag}`)
}
require(statSync(at('icon.svg')).size <= 256 * 1024, 'icon.svg 不能超过 256 KiB')

const patch = read('cordis.patch.yml')
require(patch.includes(`name: '${pkg.name}'`), 'cordis.patch.yml 未插入当前包名')
require(patch.includes('id: selection-translate'), 'cordis.patch.yml 缺少 id: selection-translate')

if (problems.length > 0) {
  console.error(problems.map((line) => `FAIL ${line}`).join('\n'))
  process.exit(1)
}
console.log('manifest ok')
