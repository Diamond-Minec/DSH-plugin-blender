/**
 * Host 冒烟测试：mock 一个 Cordis ctx，真实 import index.js，跑通 apply() 与全部路由。
 *
 *   node tools/smoke.mjs              只测接线、环境探测与接口结构
 *   node tools/smoke.mjs --blender    额外真跑一次终端模式（出 .blend + 预览图）
 *
 * 这不是替代在 DSH 里真装一遍，而是把最容易写错的地方钉住。
 */
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '/blender/api'
const DO_BLENDER = process.argv.includes('--blender')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-smoke-'))

// 关键：把 DSH_HOME 指到临时目录**再**加载插件。
// 否则 POST /config 会写进真实的 $DSH_HOME/blender-plugin/config.json，
// 测试就会改掉用户的配置 —— 测试不该有这种副作用。
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-home-'))
process.env.DSH_HOME = FAKE_HOME

const reg = { effects: [], sections: [], routes: [], tools: [], logs: [], skillProviders: [], skills: [] }
const logger = {
  info: (m) => reg.logs.push(['info', m]),
  warn: (m) => reg.logs.push(['warn', m]),
  error: (m) => reg.logs.push(['error', m]),
  debug: () => {},
}
const childCtxBase = {
  effect(fn, label) { const d = fn(); reg.effects.push({ label, dispose: d }); return d },
  tools: { register(tool) { reg.tools.push(tool); return () => {} } },
  skills: {
    // 照真实 dsh-skill 的契约严格模拟：入参是**工厂函数**，会被调用
    registerProvider(create) {
      if (typeof create !== 'function') {
        throw new TypeError(
          'skill provider 注册失败：registerProvider 需要同步工厂函数（注册表会执行 create(control)），'
          + `收到的是 ${typeof create}`)
      }
      const provider = create({ signal: new AbortController().signal, invalidate() {} })
      if (!provider || typeof provider.name !== 'string') {
        throw new Error('skill provider 必须返回带 name 的对象')
      }
      if (provider.name === 'runtime') throw new Error('"runtime" 是保留的 provider 名')
      reg.skillProviders.push(provider)
      return () => {}
    },
    register(skill) { reg.skills.push(skill); return () => {} },
    // 供 /skill 路由「真的去问注册表」用；真实注册表也提供这两个。
    // 注意 list/get 都必须是**异步**的：真实注册表在带 signal 时会直接对
    // provider 的返回值调 .then，同步返回会抛 promise.then is not a function。
    // 这里同样 await，才能测出 provider 侧写成同步的那种回归。
    async list() {
      const out = []
      for (const p of reg.skillProviders) {
        if (typeof p.list !== 'function') continue
        const listed = await p.list()
        for (const c of listed) validateCandidateStrict(c, p.name)
        out.push(...listed)
      }
      return out
    },
    async get(name) {
      for (const p of reg.skillProviders) {
        if (typeof p.list !== 'function') continue
        const hit = (await p.list()).find((c) => c.name === name)
        if (hit) return p.get(hit)
      }
      return undefined
    },
  },
  logger,
}

/** 照抄 dsh-skill 的 validateCandidate 规则 */
function validateCandidateStrict(c, providerName) {
  const bad = (msg) => { throw new Error(`skill provider "${providerName}" ${msg}`) }
  if (typeof c.name !== 'string') bad('returned a non-string skill name')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.name)) bad(`returned invalid skill name "${c.name}"`)
  if (typeof c.description !== 'string') bad(`returned skill "${c.name}" with a non-string description`)
  if (c.description.length === 0) bad(`returned skill "${c.name}" without a description`)
  if (!c.invocation || typeof c.invocation.modelInvocable !== 'boolean'
    || typeof c.invocation.userInvocable !== 'boolean') {
    bad(`returned skill "${c.name}" with an invalid invocation（需要 invocation.{modelInvocable,userInvocable}）`)
  }
  if (c.whenToUse !== undefined && typeof c.whenToUse !== 'string') bad(`skill "${c.name}" 的 whenToUse 不是字符串`)
  if (typeof c.source !== 'string') bad(`returned skill "${c.name}" with a non-string source`)
  if (typeof c.rank !== 'number' || !Number.isFinite(c.rank)) bad(`returned skill "${c.name}" with an invalid rank`)
  if (typeof c.provider !== 'string') bad(`returned skill "${c.name}" with a non-string provider`)
  if (c.provider !== providerName) bad(`returned skill "${c.name}" for provider "${c.provider}"`)
  if (c.path !== undefined && typeof c.path !== 'string') bad(`skill "${c.name}" 的 path 不是字符串`)
}
const ctx = {
  logger,
  effect(fn, label) { const d = fn(); reg.effects.push({ label, dispose: d }); return d },
  systemPrompt: { section(spec) { reg.sections.push(spec); return () => {} } },
  webServer: { register(route) { reg.routes.push(route); return () => {} } },
  inject(names, cb) { cb(childCtxBase) },
}

function makeReq(method, url, body, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers || {}
  setImmediate(() => {
    if (body !== undefined) {
      // raw: 前缀表示「原样发送」，用来测坏 JSON；否则按 JSON 序列化
      const raw = typeof body === 'string' && body.startsWith('raw:') ? body.slice(4) : JSON.stringify(body)
      req.emit('data', Buffer.from(raw, 'utf8'))
    }
    req.emit('end')
  })
  return req
}

function call(handler, method, url, body, headers) {
  return new Promise((resolve) => {
    const chunks = []
    const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb() } })
    res.statusCode = 0
    res.headers = {}
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
    res.on('finish', () => {
      const buf = Buffer.concat(chunks)
      let parsed = buf.toString('utf8')
      try { parsed = JSON.parse(parsed) } catch { /* 二进制保留 */ }
      resolve({ status: res.statusCode, headers: res.headers, body: parsed, bytes: buf.length })
    })
    Promise.resolve(handler(makeReq(method, url, body, headers), res)).catch((err) => {
      resolve({ status: -1, body: { error: String(err) }, bytes: 0 })
    })
  })
}

function line(t) { console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`) }
const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/* --------------------------------------------------------------------- run --- */

line('1. import + apply')
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
check('导出 name', mod.name === 'blender', `name=${mod.name}`)
check('导出 inject', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))
check('导出 apply', typeof mod.apply === 'function')

try {
  mod.apply(ctx, { outDir: OUT_DIR, mode: 'terminal', autoPreview: true })
  check('apply() 未抛错', true)
} catch (err) {
  check('apply() 未抛错', false, `${err.name}: ${err.message}`)
}

line('2. 注册结果')
check('注册了提示词段', reg.sections.length === 1, reg.sections.map((s) => s.name).join(','))
check('注册了前缀路由', reg.routes.length === 1 && reg.routes[0].kind === 'prefix',
  JSON.stringify(reg.routes.map((r) => r.path)))
check('注册了 ctx.effect', reg.effects.length >= 3, reg.effects.map((e) => e.label).join(' | '))
const section = reg.sections[0]
if (section) {
  check('提示词段讲了两种模式', /APP 模式/.test(section.text) && /终端模式/.test(section.text))
  check('提示词段指向技能', /blender-modeling/.test(section.text))
  console.log(`      长度 ${section.text.length} 字符，order=${section.order}`)
}

line('3. 技能安装（插件装技能）')
check('注册了 skill provider', reg.skillProviders.length === 1,
  reg.skillProviders.map((p) => p.name).join(','))
const provider = reg.skillProviders[0]
if (provider) {
  check('provider 名不是保留的 runtime', provider.name !== 'runtime', provider.name)
  // list() 必须是异步的：真实注册表带 signal 时会直接对返回值调 .then
  check('list() 返回 Promise（否则真实宿主会抛 promise.then is not a function）',
    typeof provider.list()?.then === 'function')
  let listed = []
  try { listed = await provider.list() } catch (err) { console.log('      list() 抛错: ' + err.message) }
  check('list() 返回技能', listed.length >= 1, `${listed.length} 个：${listed.map((s) => s.name).join(', ')}`)
  for (const skill of listed) {
    // 这些字段缺一个，真实注册表就会抛错并静默跳过整个 provider
    check(`  ${skill.name}: description 非空且 <=200`, !!skill.description && skill.description.length <= 200,
      `${(skill.description || '').length} 字符`)
    check(`  ${skill.name}: 调用策略在 invocation 里`,
      skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true)
    check(`  ${skill.name}: 有 source`, typeof skill.source === 'string' && skill.source.length > 0, String(skill.source))
    check(`  ${skill.name}: 有 rank（有限数）`, Number.isFinite(skill.rank), String(skill.rank))
    check(`  ${skill.name}: provider 字段等于 provider 名`, skill.provider === provider.name, String(skill.provider))
    check(`  ${skill.name}: 有 path`, !!skill.path)
  }
  if (listed.length) {
    // get() 收到的是**候选对象**，不是名字
    check('get() 返回 Promise', typeof provider.get(listed[0])?.then === 'function')
    const def = await provider.get(listed[0])
    check('get() 能加载正文', !!def && typeof def.content === 'string' && def.content.length > 500,
      def ? `${(def.content || '').length} 字符` : 'undefined')
    check('get() 返回的定义带 content/provider', !!def && def.provider === provider.name)
    check('get() 剥掉了 frontmatter', !!def && !def.content.startsWith('---'))
    check('get() 给了 resourceBase（references/ 才解析得到）',
      !!def && def.resourceBase?.kind === 'directory' && !!def.resourceBase?.path)
    check('get() 对不存在的候选返回 undefined',
      (await provider.get({ path: 'E:/nope/SKILL.md' })) === undefined)
  }
  check('list() 不泄漏内部字段', !listed.some((s) => '_file' in s))
}

line('4. skill-filesystem 不在时的降级')
console.log('      （ctx.inject(["skills"]) 未提供 provider 时，插件不应抛错）')
let noSkillsThrew = false
try {
  const reg2 = { sections: [], routes: [], effects: [] }
  // 这次装载要用**独立的**工具注册表，否则会把工具重复计进 reg.tools
  const child2 = {
    effect(fn) { try { return fn() } catch { return () => {} } },
    tools: { register() { return () => {} } },   // 丢弃，不污染主断言
    skills: { registerProvider() { return () => {} }, register() { return () => {} } },
    logger,
  }
  const ctx2 = {
    logger,
    effect(fn, label) { const d = fn(); reg2.effects.push({ label, dispose: d }); return d },
    systemPrompt: { section(s) { reg2.sections.push(s); return () => {} } },
    webServer: { register(r) { reg2.routes.push(r); return () => {} } },
    inject(names, cb) {
      if (names.includes('skills')) return  // 模拟 skills 服务不存在
      cb(child2)
    },
  }
  mod.apply(ctx2, { outDir: OUT_DIR, mode: 'terminal' })
} catch (err) {
  noSkillsThrew = true
  console.log('      抛错：' + err.message)
}
check('没有 skills 服务时不抛错', !noSkillsThrew)

await new Promise((r) => setTimeout(r, 2500))
const toolWarn = reg.logs.find(([l, m]) => l === 'warn' && /dsh-tools/.test(m))
if (reg.tools.length > 0) {
  // 本机装了 DSH 时，候选基点解析应当成功，工具真的注册上
  check('工具注册成功', true, reg.tools.map((t) => t.name).join(', '))
  check('注册了两个工具', reg.tools.length === 2, `${reg.tools.length} 个`)
  for (const tool of reg.tools) {
    const hasRender = typeof tool.output?.render === 'function' || typeof tool.render === 'function'
    check(`  ${tool.name}: 有 output.render`, hasRender)
  }
  // 光注册上不够，主体也要真能跑
  const envTool = reg.tools.find((t) => t.name === 'blender_environment')
  if (envTool && typeof envTool.execute === 'function') {
    let out = null
    try { out = await envTool.execute({}) } catch (err) { out = `抛错: ${err.message}` }
    check('blender_environment 能执行并返回可解析 JSON',
      typeof out === 'string' && (() => { try { JSON.parse(out); return true } catch { return false } })(),
      String(out).slice(0, 90))
  } else {
    warn('  blender_environment 没有可调用的 execute')
  }
} else {
  // 本机没有 DSH 的 profile 依赖时（例如 CI），应当优雅降级而不是抛错
  check('解析不到 dsh-tools 时优雅降级', !!toolWarn, toolWarn ? '已留 warn' : '没有 warn')
}

const handler = reg.routes[0]?.handler
if (!handler) {
  check('拿到路由 handler', false)
} else {
  line('5. GET /status')
  const st = await call(handler, 'GET', `${BASE}/status`)
  check('status 200', st.status === 200, `status=${st.status}`)
  const s = st.body?.status
  check('status 结构完整', !!s && !!(s.blender && s.addon && s.bridge && s.skills && s.outDir && s.ready))
  if (s) {
    console.log(`      Blender : ${s.blender.path || '(未找到)'}  版本=${s.blender.version || '-'}  来源=${s.blender.source}`)
    console.log(`      桥接组件: 已装=${s.addon.installed} 完整=${s.addon.complete}`)
    console.log(`      桥接在线: ${s.bridge.alive}${s.bridge.error ? ' (' + s.bridge.error + ')' : ''}  端口=${s.bridge.port}`)
    console.log(`      技能    : ${s.skills.count} 个 [${s.skills.names.join(', ')}]`)
    console.log(`      成片目录: ${s.outDir.path} 可写=${s.outDir.writable}`)
    console.log(`      就绪    : terminal=${s.ready.terminal} app=${s.ready.app}`)
    check('探测到了 Blender', s.blender.found === true, s.blender.path || '未找到')
    check('Blender 版本可读', !!s.blender.version, s.blender.version)
    check('技能目录被读到', s.skills.count >= 1, `${s.skills.count} 个`)
    check('终端模式就绪', s.ready.terminal === true)
  }

  line('6. 路由健壮性')
  check('未知子路径 404', (await call(handler, 'GET', `${BASE}/nope`)).status === 404)
  check('file 拒绝目录外路径',
    (await call(handler, 'GET', `${BASE}/file?path=${encodeURIComponent('C:/Windows/win.ini')}`)).status === 403)
  check('outputs 200', (await call(handler, 'GET', `${BASE}/outputs`)).status === 200)
  check('bridge 200', (await call(handler, 'GET', `${BASE}/bridge`)).status === 200)
  const skillRoute = await call(handler, 'GET', `${BASE}/skill`)
  check('skill 200', skillRoute.status === 200, `status=${skillRoute.status}`)
  check('skill 报告结构完整',
    !!skillRoute.body?.skill && 'inCatalog' in skillRoute.body.skill && 'loadable' in skillRoute.body.skill,
    JSON.stringify(skillRoute.body?.skill || {}).slice(0, 160))
  const emptyRun = await call(handler, 'POST', `${BASE}/run`, { instructions: [] })
  check('空指令被拒', emptyRun.status === 500, `status=${emptyRun.status}`)
  // 坏 JSON 应当是 400。注意要真的发一段坏内容 —— 空 body 不算语法错误，
  // 它走「没有指令」那条路（500），这是更准确的语义。
  const badJson = await call(handler, 'POST', `${BASE}/run`, 'raw:{not json at all')
  check('坏 JSON 返回 400', badJson.status === 400, `status=${badJson.status}`)
  const emptyBody = await call(handler, 'POST', `${BASE}/run`, undefined)
  check('空 body 不算语法错误', emptyBody.status === 500, `status=${emptyBody.status}`)

  line('7. POST /config 并回读')
  const saved = await call(handler, 'POST', `${BASE}/config`, { mode: 'terminal', previewAngles: [0, 90] })
  check('config 保存成功', saved.status === 200 && saved.body?.ok === true, saved.body?.error || '')
  check('config 立即生效', saved.body?.config?.mode === 'terminal' &&
    JSON.stringify(saved.body?.config?.previewAngles) === '[0,90]',
    JSON.stringify(saved.body?.config?.previewAngles))
  await call(handler, 'POST', `${BASE}/config`, { mode: 'app', previewAngles: [0, 45, 135] })
  console.log('      （已复原默认值）')

  if (DO_BLENDER) {
    line('8. POST /run（终端模式，真出 .blend + 预览图）')
    const started = Date.now()
    const made = await call(handler, 'POST', `${BASE}/run`, {
      mode: 'terminal',
      title: 'smoke-tower',
      render: true,
      instructions: [
        { op: 'primitive', kind: 'cylinder', name: 'base', radius: 0.6, depth: 0.2, location: [0, 0, 0.1] },
        { op: 'primitive', kind: 'cube', name: 'shaft', size: 0.4, location: [0, 0, 1.0], scale: [1, 1, 2.2] },
        { op: 'material', targets: ['base'], name: 'stone', base_color: [0.45, 0.44, 0.42], metallic: 0, roughness: 0.8 },
        { op: 'material', targets: ['shaft'], name: 'steel', base_color: [0.35, 0.38, 0.42], metallic: 0.9, roughness: 0.25 },
        { op: 'primitive', kind: 'cone', name: 'roof', radius: 0.45, depth: 0.6, location: [0, 0, 2.4] },
        { op: 'material', targets: ['roof'], name: 'brass', base_color: [0.75, 0.55, 0.2], metallic: 1.0, roughness: 0.3 },
      ],
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    check('run 返回 200', made.status === 200, `status=${made.status}（${seconds}s）`)
    check('run ok=true', made.body?.ok === true, JSON.stringify(made.body).slice(0, 400))
    const blend = made.body?.blend
    if (blend) {
      console.log(`      模型  : ${blend}`)
      console.log(`      截稿  : ${made.body.summary?.count} 个物体 [${(made.body.summary?.objects || []).map((o) => o.name).join(', ')}]`)
      console.log(`      预览图: ${(made.body.previews || []).length} 张`)
      for (const p of made.body.previews || []) console.log(`         ${p}  (${fs.existsSync(p) ? fs.statSync(p).size + ' B' : '缺失'})`)
      check('.blend 已产出', fs.existsSync(blend))
      check('.blend 非空', fs.existsSync(blend) && fs.statSync(blend).size > 20000,
        fs.existsSync(blend) ? `${fs.statSync(blend).size} B` : '')
      check('预览图已产出', (made.body.previews || []).length >= 1)
      for (const p of made.body.previews || []) {
        check(`  预览图存在且非空: ${path.basename(p)}`,
          fs.existsSync(p) && fs.statSync(p).size > 5000,
          fs.existsSync(p) ? `${fs.statSync(p).size} B` : '缺失')
      }
      check('场景里没有出厂残留 Cube', !(made.body.summary?.objects || []).some((o) => o.name === 'Cube'))
      if (made.body.previews?.[0]) {
        const img = await call(handler, 'GET', `${BASE}/file?path=${encodeURIComponent(made.body.previews[0])}`)
        check('file 能读出预览图', img.status === 200 && img.bytes > 5000, `bytes=${img.bytes}`)
        check('图片 Content-Type 正确', img.headers?.['content-type'] === 'image/png', img.headers?.['content-type'])
      }
    }
  } else {
    line('8. POST /run')
    console.log('      （未加 --blender，跳过真实建模）')
  }
}

line('9. 清理 effect')
let disposeOk = true
for (const e of reg.effects) {
  try { if (typeof e.dispose === 'function') e.dispose() } catch (err) { disposeOk = false; console.log(`      ${e.label} 抛错：${err.message}`) }
}
check('所有 effect 可安全 dispose', disposeOk)

fs.rmSync(OUT_DIR, { recursive: true, force: true })

line('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
