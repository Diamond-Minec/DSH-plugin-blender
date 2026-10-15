#!/usr/bin/env node
/**
 * 设置页的结构化渲染测试。
 *
 * 不装浏览器、不装 React：用一个最小渲染器把 client.js 真正执行一遍，
 * 递归求值函数组件、按组件位置复用 hook 状态，最后断言关键内容确实渲染出来了。
 *
 *   node tools/render.mjs
 */

import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`) }

/** 固定引用的假响应，保证多次渲染收敛 */
const CANNED = {
  '/blender/api/status': {
    ok: true,
    config: { mode: 'app', autoPreview: true, previewWidth: 640, previewHeight: 480, bridgePort: 8765, blenderPath: '', outDir: '/tmp/out' },
    status: {
      blender: { found: true, path: 'E:/SteamLibrary/steamapps/common/Blender/blender.exe', version: '5.2.2', source: 'auto' },
      addon: { installed: true, complete: true, target: 'C:/Users/x/AppData/Roaming/Blender Foundation/Blender/5.2/scripts/addons/dsh_blender_bridge', sharedFiles: ['a', 'b', 'c'], needsRestart: true },
      bridge: { alive: true, port: 8765 },
      skills: {
        dir: '/p/skills',
        count: 1,
        names: ['blender-modeling'],
        registry: {
          provider: 'blender-bundled',
          bundledDir: '/p/skills',
          bundledCount: 1,
          bundledNames: ['blender-modeling'],
          registryAvailable: true,
          inCatalog: true,
          loadable: true,
          visible: true,
          contentLength: 3709,
          catalogNames: ['blender-modeling', 'office-docx'],
          error: '',
        },
      },
      outDir: { path: '/tmp/out', writable: true },
      ready: { terminal: true, app: true },
    },
  },
  '/blender/api/outputs': {
    ok: true,
    outDir: '/tmp/out',
    outputs: [
      { name: 'tower-1.blend', path: '/tmp/out/tower-1.blend', size: 94360, modified: 1760000000000, kind: 'blend' },
      { name: 'preview_045.png', path: '/tmp/out/preview_045.png', size: 261194, modified: 1760000001000, kind: 'image' },
    ],
  },
}

/* ------------------------------------------------ 最小渲染器 --- */

function makeMiniRenderer() {
  const instances = new Map()
  let active = null
  let dirty = false
  let effectQueue = []

  function instFor(key) {
    if (!instances.has(key)) instances.set(key, { state: [], cursor: 0, memo: {} })
    return instances.get(key)
  }
  function useSlot(init) {
    const inst = active
    const index = inst.cursor++
    if (!(index in inst.state)) inst.state[index] = typeof init === 'function' ? init() : init
    return [inst, index]
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) {
        for (const item of (Array.isArray(child) ? child.flat(Infinity) : [child])) {
          if (item === null || item === undefined || item === false || item === true) continue
          flat.push(item)
        }
      }
      return { type, props: props || {}, children: flat }
    },
    useState(init) {
      const [inst, index] = useSlot(init)
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.state[index]) : value
        if (next !== inst.state[index]) { inst.state[index] = next; dirty = true }
      }
      return [inst.state[index], set]
    },
    useEffect(fn, deps) {
      const inst = active
      const index = inst.cursor++
      const previous = inst.memo[index]
      const changed = !previous || !previous.deps || !deps
        || deps.length !== previous.deps.length
        || deps.some((v, i) => v !== previous.deps[i])
      if (!changed) return
      inst.memo[index] = { deps: deps || null }
      effectQueue.push(fn)
    },
    useCallback(fn) { active.cursor++; return fn },
    useRef(init) {
      const [inst, index] = useSlot(init)
      if (!inst.state[index] || typeof inst.state[index] !== 'object') inst.state[index] = { current: init }
      return inst.state[index]
    },
  }

  function resolve(node, key) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((n, i) => resolve(n, `${key}.${i}`))
    if (typeof node !== 'object' || !('type' in node)) return null
    if (typeof node.type === 'function') {
      const inst = instFor(key)
      inst.cursor = 0
      const previous = active
      active = inst
      let output
      try { output = node.type(node.props) } finally { active = previous }
      return resolve(output, `${key}~`)
    }
    return { type: node.type, props: node.props, children: resolve(node.children, key) }
  }

  return {
    React,
    async render(Component) {
      let tree = null
      for (let pass = 0; pass < 30; pass++) {
        dirty = false
        effectQueue = []
        const root = instFor('root')
        root.cursor = 0
        const previous = active
        active = root
        let output
        try { output = Component() } finally { active = previous }
        tree = resolve(output, 'root')
        const queued = effectQueue
        effectQueue = []
        for (const fn of queued) fn()
        await new Promise((r) => setTimeout(r, 0))
        if (!dirty) return { tree, passes: pass + 1 }
      }
      throw new Error('渲染未收敛（setState 每轮都产生新对象？）')
    },
  }
}

/* -------------------------------------------------- 1. 加载 --- */

section('1. 加载 client.js（mock window.__ModuleLoader__）')
globalThis.fetch = async (url) => {
  const key = String(url).split('?')[0]
  const body = CANNED[key]
  if (!body) return { ok: false, status: 404, json: async () => ({ ok: false, error: `no canned response for ${key}` }) }
  return { ok: true, status: 200, json: async () => body }
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }

const mini = makeMiniRenderer()
const required = []
await import(pathToFileURL(path.join(ROOT, 'client.js')).href)

check('调用了 __ModuleLoader__.load', !!loaded)
check('注册 id 等于包名', loaded?.id === 'dsh-plugin-blender', String(loaded?.id))

const plugin = loaded.factory((name) => {
  required.push(name)
  if (name === 'react') return mini.React
  throw new Error(`不允许 require 其它模块：${name}`)
})
check('工厂只 require 了 react', required.length === 1 && required[0] === 'react', required.join(', '))
check('导出了 apply', typeof plugin?.apply === 'function')
check('inject 声明了 slots', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'))

/* ------------------------------------------------- 2. 注册 --- */

section('2. slot 注册')
let registration = null
let sectionKey = null
let applyError = null
try {
  plugin.apply({
    get: () => undefined,
    slots: {
      inject(key, cb) { sectionKey = key; cb() },
      register(options, Component) { registration = { options, Component }; return () => {} },
    },
  })
} catch (err) { applyError = err }
check('apply() 未抛错', !applyError, applyError ? `${applyError.name}: ${applyError.message}` : '')
check('注册进 settings.section', sectionKey === 'settings.section', String(sectionKey))
check('注册 id 为 blender', registration?.options?.id === 'blender', String(registration?.options?.id))
check('label 取到中文标题', (() => { try { return registration.options.label() === 'Blender 建模' } catch { return false } })())

/* ---------------------------------------------------- 3. 渲染 --- */

section('3. 渲染设置页')
let result = null
let renderError = null
try { result = await mini.render(registration.Component) } catch (err) { renderError = err }
check('渲染未抛错', !renderError, renderError ? `${renderError.name}: ${renderError.message}` : '')
if (result) console.log(`      收敛用了 ${result.passes} 轮渲染`)

const texts = []
const images = []
const links = []
const buttons = []
function walk(node) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node !== 'object') return
  const props = node.props || {}
  if (node.type === 'img') images.push(props)
  if (node.type === 'a') links.push(props)
  if (node.type === 'button') buttons.push(props)
  if (props.children !== undefined) walk(props.children)
  if (Array.isArray(node.children)) walk(node.children)
}
if (result) walk(result.tree)
const haystack = texts.join(' ｜ ')

console.log(`      文本 ${texts.length} 段 · img ${images.length} · a ${links.length} · button ${buttons.length}`)

check('渲染出页面标题', haystack.includes('Blender 建模'))
check('渲染出状态卡', haystack.includes('Blender 本体') && haystack.includes('桥接组件'))
check('状态卡显示检测到的 Blender 路径', haystack.includes('blender.exe'), )
check('状态卡显示版本', haystack.includes('5.2.2'))
check('渲染出技能状态', haystack.includes('blender-modeling'))
check('渲染出两种模式选项', haystack.includes('看着建') && haystack.includes('后台建'))
check('渲染出模式说明', haystack.includes('实时看到每一块模型怎么长出来'))
check('渲染出自动预览开关', haystack.includes('建完自动渲染预览图'))
check('渲染出安装步骤引导', haystack.includes('装完之后') || haystack.includes('重新安装'))
check('渲染出试一下区块', haystack.includes('试一下'))
check('渲染出产物列表', haystack.includes('tower-1.blend') && haystack.includes('preview_045.png'))
check('产物区分了模型与预览图', haystack.includes('模型文件') && haystack.includes('预览图'))
check('渲染出高级折叠区', haystack.includes('高级'))
check('高级区有 Blender 路径输入', haystack.includes('Blender 装在哪儿'))

// 「技能安装」区块 —— 用户明确要的那个选项
check('渲染出技能安装区块', haystack.includes('建模技能已经装进 DSH 了'))
check('技能区块说明了不用手动配置', haystack.includes('不用手动配置'))
check('技能区块显示技能名', haystack.includes('blender-modeling'))
check('技能区块有检查按钮', haystack.includes('检查技能状态'))
check('技能区块显示目录里有几个技能', haystack.includes('office-docx'))
check('技能区块说明了「没有单独安装按钮」', haystack.includes('没有单独的「安装」按钮'))

// 反向验证：断言本身有效
check('断言有效性自检', !haystack.includes('这个字符串绝不该出现'))

// 按钮里应该有「安装桥接组件」或「重新安装」
// 注意：本渲染器把 children 放在 node.children 上（不是 props.children），
// 之前的收集器查错了地方，所以一个都没收到。
const btnTexts = []
function walkButtons(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(walkButtons); return }
  if (typeof node !== 'object') return
  const collectText = (n, out) => {
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach((x) => collectText(x, out)); return }
    if (n && typeof n === 'object') {
      if (n.children !== undefined) collectText(n.children, out)
      if (n.props && n.props.children !== undefined) collectText(n.props.children, out)
    }
  }
  if (node.type === 'button') {
    const parts = []
    collectText(node.children, parts)
    collectText(node.props && node.props.children, parts)
    btnTexts.push(parts.join(''))
  }
  walkButtons(node.children)
  if (node.props) walkButtons(node.props.children)
}
if (result) walkButtons(result.tree)
check('有安装桥接组件的按钮', btnTexts.some((t) => /安装桥接组件|重新安装/.test(t)),
  btnTexts.filter((t) => /安装|模型|建/.test(t)).slice(0, 6).join(' / '))
check('有重新检查按钮', btnTexts.some((t) => /重新检查/.test(t)))
check('有启动 Blender 按钮', btnTexts.some((t) => /启动 Blender/.test(t)))
check('有保存设置按钮', btnTexts.some((t) => /保存设置/.test(t)))

section('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
