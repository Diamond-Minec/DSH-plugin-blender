#!/usr/bin/env node
/**
 * 技能注册的**真集成测试** —— 用真实的 @deepseek-ai/dsh-skill 注册表，
 * 而不是我自己写的 mock。
 *
 * 为什么需要它：最初我用 mock 测过「注册成功」，但真实 DSH 里技能根本没出现。
 * 原因是 mock 接受的形状比真实实现宽松（真实实现要求 registerProvider 收工厂函数，
 * 且候选项必须带 source/rank/provider，调用策略要包在 invocation 里）。
 * mock 给了我假信心。这个脚本直接加载真实包，契约不一致就必然失败。
 *
 *   node tools/smoke-skill.mjs
 *
 * 依赖：profile 里装好的 @deepseek-ai/dsh-skill 与 @deepseek-ai/cordis。
 * 可用 DSH_PROFILES_NODE_MODULES 覆盖查找位置。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NODE_MODULES = process.env.DSH_PROFILES_NODE_MODULES
  || path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'profiles', 'node_modules')

const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t) { console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`) }

function resolvePkg(spec) {
  const base = spec.startsWith('@')
    ? path.join(NODE_MODULES, ...spec.split('/'))
    : path.join(NODE_MODULES, spec)
  return base
}

/* ------------------------------------------------------- 1. 载入真实包 --- */

section('1. 载入真实的 dsh-skill / cordis')
const skillPkg = resolvePkg('@deepseek-ai/dsh-skill')
const cordisPkg = resolvePkg('@deepseek-ai/cordis')
check('dsh-skill 已安装', fs.existsSync(skillPkg), skillPkg)
check('cordis 已安装', fs.existsSync(cordisPkg), cordisPkg)
if (!fs.existsSync(skillPkg) || !fs.existsSync(cordisPkg)) {
  // 这个测试依赖本机 DSH 的 profile 依赖，CI 之类没有它的环境应当跳过而不是失败。
  // 注意：只在**依赖不存在**时跳过；依赖存在而契约不符时下面照样会失败。
  console.log('\n[SKIP] 本机没有 DSH 的 profile 依赖，跳过真实注册表集成测试。')
  console.log(`       查找位置：${NODE_MODULES}`)
  console.log('       （可用 DSH_PROFILES_NODE_MODULES 指定其它位置）')
  process.exit(0)
}

const entryOf = (dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const exported = pkg.exports?.['.']
  const rel = (typeof exported === 'string' ? exported : exported?.default) || pkg.main || 'index.js'
  return path.join(dir, rel)
}

const cordisEntry = entryOf(cordisPkg)
const skillEntry = entryOf(skillPkg)
console.log(`      cordis : ${cordisEntry}`)
console.log(`      skills : ${skillEntry}`)

const { Context } = await import(pathToFileURL(cordisEntry).href)
const { default: SkillRegistry } = await import(pathToFileURL(skillEntry).href)
check('导出 Context', typeof Context === 'function')
check('导出 SkillRegistry', typeof SkillRegistry === 'function')

/* ------------------------------------------------ 2. 起一个真实注册表 --- */

section('2. 起一个真实技能注册表')
let realCtx = null
let registryError = null
try {
  realCtx = new Context()
  new SkillRegistry(realCtx, {})
} catch (err) {
  registryError = err
}
check('注册表创建成功', !registryError, registryError ? `${registryError.name}: ${registryError.message}` : '')
check('ctx.skills 存在', !!realCtx?.skills)
if (!realCtx?.skills) {
  console.log('\n拿不到 ctx.skills，无法继续。')
  process.exit(1)
}

/* --------------------------------------- 3. 用真实 ctx 装载我们的插件 --- */

section('3. 装载插件（skills 用真实的，其余用桩）')
const reg = { effects: [], routes: [], sections: [] }
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

// 除了 skills 走真服务，其它服务给最小桩即可
const stubChild = {
  effect(fn) { try { return fn() } catch { return () => {} } },
  tools: { register() { return () => {} } },
  logger,
}
const ctx = {
  logger,
  effect(fn) { const d = fn(); reg.effects.push(d); return d },
  systemPrompt: { section(s) { reg.sections.push(s); return () => {} } },
  webServer: { register(r) { reg.routes.push(r); return () => {} } },
  inject(names, cb) {
    // 关键：skills 交给真实的 Cordis 上下文
    if (names.includes('skills')) return cb(realCtx)
    return cb(stubChild)
  },
}

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
let applyError = null
try {
  mod.apply(ctx, { outDir: path.join(process.env.TEMP || '/tmp', 'blender-skill-test') })
} catch (err) {
  applyError = err
}
check('apply() 未抛错', !applyError, applyError ? `${applyError.name}: ${applyError.message}` : '')

await new Promise((r) => setTimeout(r, 100))

/* ------------------------------------------------- 4. 真实目录里能看到 --- */

section('4. 真实注册表的目录里有没有我们的技能')
// ⚠️ 必须**带 signal** 调用。真实宿主查目录/加载技能时都会传 options.signal，
// 而注册表内部是：
//     function waitWithAbort(promise, signal) {
//       if (signal === void 0) return promise;   // 没 signal 就直接返回
//       ...
//       promise.then(...)                        // 有 signal 就**直接调 .then**
//     }
// 所以当 provider 的 list()/get() 返回**同步值**时，只有带 signal 才会暴露
// 「promise.then is not a function」。不带 signal 测就是假绿 —— 实测踩过。
const controller = new AbortController()
const viewOptions = { cwd: ROOT, signal: controller.signal }

let catalog = null
let listError = null
try {
  catalog = await realCtx.skills.list(viewOptions)
} catch (err) {
  listError = err
}
check('list()（带 signal）未抛错', !listError, listError ? `${listError.name}: ${listError.message}` : '')

// 注意：真实的 list() 直接返回**数组**（snapshot().skills），
// 不是 {skills:[...]}。之前这里按对象取，导致永远读到空数组 —— 是测试的错。
const skills = Array.isArray(catalog) ? catalog : (catalog?.skills || [])
console.log(`      目录里共 ${skills.length} 个技能：${skills.map((s) => s.name).join(', ') || '(空)'}`)
check('目录里出现了 blender-modeling', skills.some((s) => s.name === 'blender-modeling'),
  skills.map((s) => s.name).join(', ') || '(空)')

// 用 snapshot() 还能看到发现是否完整（同样带 signal）
const snapshot = await realCtx.skills.snapshot(viewOptions)
check('发现过程完整（complete=true）', snapshot.complete === true, String(snapshot.complete))

const mine = skills.find((s) => s.name === 'blender-modeling')
if (mine) {
  console.log(`      provider=${mine.provider}  description=${(mine.description || '').slice(0, 60)}…`)
  check('summary 带 description', !!mine.description)
  check('summary 面向模型可见', mine.modelInvocable !== false, String(mine.modelInvocable))
}

/* ------------------------------------------------------ 5. 真的能加载 --- */

section('5. 按名字加载技能正文（模型调用走的就是这条）')
let def = null
let getError = null
try {
  def = await realCtx.skills.get('blender-modeling', viewOptions)
} catch (err) {
  getError = err
}
check('get()（带 signal）未抛错', !getError, getError ? `${getError.name}: ${getError.message}` : '')
check('拿到了定义', !!def, def ? Object.keys(def).join(',') : 'null')
if (def) {
  check('正文非空', typeof def.content === 'string' && def.content.length > 500,
    `${(def.content || '').length} 字符`)
  check('正文不含 frontmatter', !String(def.content).startsWith('---'))
  check('正文提到了两种模式', /APP 模式|live-app/i.test(def.content) && /终端模式|terminal/i.test(def.content))
  if (def.resourceBase) {
    console.log(`      resourceBase: ${JSON.stringify(def.resourceBase)}`)
  }
}

const missing = await realCtx.skills.get('definitely-not-a-skill', { cwd: ROOT }).catch(() => null)
check('未知技能名不炸（返回空）', missing === null || missing === undefined,
  missing === null || missing === undefined ? 'ok' : String(missing))

/* ------------------------------------------------------------ 结果 --- */

section('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('真实注册表集成测试通过：插件装的技能确实进了目录，并且能加载正文。')
}
