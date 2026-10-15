#!/usr/bin/env node
/**
 * APP 模式端到端测试 —— 用户最在意的那条路。
 *
 * 验证的事：插件能不能把 addon 装进 Blender **并启用**，然后真的通过桥接连上
 * 一个开着的 Blender，在主线程里把模型建出来。
 *
 *   node tools/smoke-app.mjs
 *
 * 注意：这会真的启动一次 Blender 窗口（APP 模式就是要有界面），跑完会关掉。
 */

import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '/blender/api'
const OUT_DIR = path.join(os.tmpdir(), `blender-app-${Date.now()}`)

const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t) { console.log(`\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let blenderProc = null
function killBlender() {
  try { if (blenderProc && !blenderProc.killed) blenderProc.kill() } catch { /* ignore */ }
  blenderProc = null
}
process.on('exit', killBlender)
process.on('SIGINT', () => { killBlender(); process.exit(130) })

/* --------------------------------------------------- 装载插件（模拟宿主） --- */

const reg = { routes: [], effects: [] }
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
const child = {
  effect(fn) { try { return fn() } catch { return () => {} } },
  tools: { register() { return () => {} } },
  skills: { registerProvider() { return () => {} } },
  logger,
}
const ctx = {
  logger,
  effect(fn) { const d = fn(); reg.effects.push(d); return d },
  systemPrompt: { section() { return () => {} } },
  webServer: { register(r) { reg.routes.push(r); return () => {} } },
  inject(names, cb) { if (!names.includes('skills')) cb(child) },
}

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
mod.apply(ctx, { outDir: OUT_DIR, mode: 'app', autoPreview: true, bridgePort: 8765, terminalTimeoutMs: 600000 })
const handler = reg.routes[0].handler

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}
function call(method, url, body) {
  return new Promise((resolve) => {
    const chunks = []
    const res = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb() } })
    res.statusCode = 0
    res.headers = {}
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
    res.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let parsed = text
      try { parsed = JSON.parse(text) } catch { /* keep */ }
      resolve({ status: res.statusCode, body: parsed, bytes: Buffer.concat(chunks).length })
    })
    Promise.resolve(handler(makeReq(method, url, body), res)).catch((err) => {
      resolve({ status: -1, body: { error: String(err) }, bytes: 0 })
    })
  })
}

/* ------------------------------------------------------- 1. 环境检查 --- */

section('1. 环境')
const st0 = (await call('GET', `${BASE}/status`)).body
const blenderPath = st0?.status?.blender?.path
check('找到 Blender', !!blenderPath, blenderPath || '未找到')
if (!blenderPath) {
  console.log('\n找不到 Blender，无法继续。')
  process.exit(1)
}
console.log(`      Blender ${st0.status.blender.version}  ${blenderPath}`)
console.log(`      用户脚本目录 ${st0.status.addon.scriptsRoot || '(未探测到)'}`)

/* ------------------------------------------------ 2. 安装并启用 addon --- */

section('2. 安装桥接组件（复制 + 启用）')
const install = await call('POST', `${BASE}/install-addon`)
check('安装返回 200', install.status === 200, `status=${install.status}`)
check('安装 ok=true', install.body?.ok === true, install.body?.error || '')
check('文件已就位', (install.body?.files || []).length >= 4,
  (install.body?.files || []).join(', '))
check('已在 Blender 里启用', install.body?.enabled === true,
  install.body?.enabled ? '已启用' : (install.body?.note || '未启用'))
check('启用已持久化到偏好设置', install.body?.enabledPersisted === true)
if (install.body?.target) console.log(`      装到 ${install.body.target}`)

const st1 = (await call('GET', `${BASE}/status`)).body
check('状态里反映为已安装', st1?.status?.addon.installed === true)
check('状态里反映为已启用', st1?.status?.addon.enabledInBlender === true)

/* -------------------------------------------------------- 3. 启动 Blender --- */

section('3. 启动 Blender（addon 会自己把桥接开起来）')
const started = await call('POST', `${BASE}/start-blender`)
check('启动命令被接受', started.status === 200, started.body?.error || '')

// 等桥接上线。Blender 首次启动 + 加载插件需要点时间
let alive = null
const deadline = Date.now() + 90000
while (Date.now() < deadline) {
  const r = await call('GET', `${BASE}/bridge`)
  if (r.body?.alive) { alive = r.body; break }
  await sleep(2000)
  process.stdout.write('.')
}
console.log('')
check('桥接已上线（说明 addon 真的被加载并启用了）', !!alive,
  alive ? `Blender ${alive.blender}` : '90 秒内没连上')

if (!alive) {
  console.log('\n桥接没起来，APP 模式无法验证。')
  console.log('提示：若 Blender 已开着，先手动重启一次让它加载新插件。')
  killBlender()
  process.exit(1)
}

/* ------------------------------------------------------- 4. APP 模式建模 --- */

section('4. 走 APP 模式建模（指令在 Blender 主线程执行）')
const t0 = Date.now()
const run = await call('POST', `${BASE}/run`, {
  mode: 'app',
  title: 'app-mode-demo',
  render: true,
  instructions: [
    { op: 'annotate', text: '开始：底座' },
    { op: 'primitive', kind: 'cylinder', name: 'base', radius: 0.8, depth: 0.3, location: [0, 0, 0.15] },
    { op: 'material', targets: ['base'], name: 'stone', base_color: [0.42, 0.41, 0.40], metallic: 0, roughness: 0.8 },
    { op: 'annotate', text: '立柱' },
    { op: 'primitive', kind: 'cube', name: 'column', size: 0.6, location: [0, 0, 1.3], scale: [1, 1, 2.0] },
    { op: 'bevel', target: 'column', width: 0.025, segments: 2 },
    { op: 'material', targets: ['column'], name: 'steel', base_color: [0.35, 0.38, 0.42], metallic: 0.9, roughness: 0.25 },
    { op: 'annotate', text: '顶部球体' },
    { op: 'primitive', kind: 'sphere', name: 'orb', radius: 0.45, location: [0, 0, 2.75], shading: 'smooth' },
    { op: 'material', targets: ['orb'], name: 'glass_blue', base_color: [0.2, 0.6, 0.9], metallic: 0.1, roughness: 0.1 },
    { op: 'annotate', text: '黄铜环' },
    { op: 'primitive', kind: 'torus', name: 'crown', major_radius: 0.55, minor_radius: 0.055, location: [0, 0, 2.75] },
    { op: 'material', targets: ['crown'], name: 'brass', base_color: [0.8, 0.6, 0.22], metallic: 1.0, roughness: 0.25 },
  ],
})
const seconds = ((Date.now() - t0) / 1000).toFixed(1)

check('run 返回 200', run.status === 200, `status=${run.status}`)
check('run ok=true', run.body?.ok === true, JSON.stringify(run.body).slice(0, 300))
check('报告的模式是 app', run.body?.mode === 'app', String(run.body?.mode))
console.log(`      耗时 ${seconds}s`)

const d = run.body || {}
check('场景里 4 个部件', d.summary?.count === 4,
  (d.summary?.objects || []).map((o) => `${o.name}(v${o.vertices})`).join(', '))
check('注解被记录（证明逐条执行）', (d.annotations || []).length === 4,
  JSON.stringify(d.annotations))

/* ------------------------------------------------------------ 5. 产物 --- */

section('5. 验收产物')
check('.blend 已产出', !!d.blend && fs.existsSync(d.blend), d.blend || '（无）')
if (d.blend && fs.existsSync(d.blend)) {
  const size = fs.statSync(d.blend).size
  check('.blend 非空（> 20 KB）', size > 20480, `${size} B`)
}
check('预览图已产出', (d.previews || []).length >= 1, `${(d.previews || []).length} 张`)
for (const p of d.previews || []) {
  const ok = fs.existsSync(p) && fs.statSync(p).size > 5000
  check(`  预览图 ${path.basename(p)}`, ok, fs.existsSync(p) ? `${fs.statSync(p).size} B` : '缺失')
}
const img = (d.previews || [])[0]
if (img) {
  const viaRoute = await call('GET', `${BASE}/file?path=${encodeURIComponent(img)}`)
  check('file 路由能读出预览图', viaRoute.status === 200 && viaRoute.bytes > 5000, `bytes=${viaRoute.bytes}`)
}

if (d.blend) {
  console.log('\n      产物：')
  console.log(`        模型   ${d.blend}`)
  for (const p of d.previews || []) console.log(`        预览图 ${p}`)
}

/* ---------------------------------------------------------- 6. 收尾 --- */

section('6. 收尾')
killBlender()
await sleep(2500)
// 保险：把还活着的 blender 进程收掉（这个测试自己起的）
const cleanup = spawn('taskkill', ['/F', '/IM', 'blender.exe'], { windowsHide: true })
await new Promise((r) => cleanup.on('close', r))
console.log('      已关闭测试启动的 Blender')

section('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('APP 模式端到端全部通过。')
}
