/**
 * dsh-plugin-blender — 宿主半边。
 *
 * 它把三件事接在一起：
 *   1. 找到 Blender（含 Steam 库），并能把内置的桥接 addon 装进 Blender 扩展目录
 *   2. 把自带的技能目录注册成 skill provider —— 装一次插件，agent 就有建模能力
 *   3. 两条执行通道：APP 模式（连 Blender 里的 addon，用户看得见）与终端模式（后台跑）
 *
 * 工程约束（沿用已验证的第三方插件实践）：
 *   · 只 import node 内置模块，运行时不硬依赖任何 @deepseek-ai/*
 *   · 不导出 Config（需要 schemastery，profile 里解析不到）
 *   · 一切注册放进 ctx.effect 并交出清理函数
 *
 * @module dsh-plugin-blender
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'blender'
export const inject = ['systemPrompt', 'webServer']

const PLUGIN_ID = 'blender'
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_DIR = path.dirname(PLUGIN_DIR)
const BASE = '/blender/api'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'blender-plugin')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

const ADDON_SRC = path.join(PLUGIN_DIR, 'blender', 'addon')
/** addon 在 Blender 里的模块名（也就是它在 addons/ 下的目录名） */
const ADDON_MODULE = 'dsh_blender_bridge'
const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills')
const DRIVER = path.join(PLUGIN_DIR, 'blender', 'modeling_driver.py')

/** 插件自带技能的 provider 名称（runtime 是官方保留名，不能用） */
const SKILL_PROVIDER = 'blender-bundled'

/**
 * 拿到的技能服务实例（用于「真的去问注册表」核实技能状态）。
 * 放在模块级是因为 buildStatus / buildSkillReport 都是顶层函数；
 * 一个宿主里本插件只挂一次，所以不存在多实例互相覆盖的问题。
 */
let skillsService = null

/* ------------------------------------------------------------------ 日志 --- */

function makeLogger(ctx) {
  let sink = null
  try {
    const raw = ctx.logger
    sink = typeof raw === 'function' ? raw(PLUGIN_ID) : raw
  } catch {
    sink = null
  }
  return (level, message, err) => {
    const text = err ? `${message} — ${(err && err.message) || String(err)}` : message
    try {
      if (sink && typeof sink[level] === 'function') return sink[level](text)
      if (sink && typeof sink.info === 'function') return sink.info(text)
    } catch {
      /* 日志失败绝不能影响插件 */
    }
    if (level === 'error' || level === 'warn') console.error(`[${PLUGIN_ID}] ${text}`)
  }
}

/* ------------------------------------------------------------- 配置 --- */

function defaults() {
  return {
    blenderPath: '',
    mode: 'app',
    bridgePort: 8765,
    bridgeTimeoutMs: 8000,
    outDir: path.join(DSH_HOME, 'blender-output'),
    previewWidth: 640,
    previewHeight: 480,
    previewAngles: [0, 45, 135],
    autoPreview: true,
    terminalTimeoutMs: 600000,
    autostartBridge: true,
  }
}

function dropEmpty(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || value === null || value === undefined) continue
    out[key] = value
  }
  return out
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mergeConfig(patchRaw) {
  return { ...defaults(), ...dropEmpty(patchRaw), ...dropEmpty(readConfigFile()) }
}

function normalizePatch(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of ['blenderPath', 'outDir', 'mode']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim()
  }
  if (out.mode && !['app', 'terminal'].includes(out.mode)) out.mode = 'app'
  for (const key of ['bridgePort', 'bridgeTimeoutMs', 'previewWidth', 'previewHeight', 'terminalTimeoutMs']) {
    if (input[key] !== undefined) {
      const num = Number(input[key])
      if (Number.isFinite(num) && num > 0) out[key] = Math.round(num)
    }
  }
  if (Array.isArray(input.previewAngles)) {
    const angles = input.previewAngles.map(Number).filter((n) => Number.isFinite(n))
    if (angles.length) out.previewAngles = angles.slice(0, 6)
  }
  if (input.autoPreview !== undefined) out.autoPreview = !!input.autoPreview
  if (input.autostartBridge !== undefined) out.autostartBridge = !!input.autostartBridge
  return out
}

function writeConfigFile(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfigFile(), ...patch }, null, 2), 'utf8')
}

/* --------------------------------------------------------- 基础工具 --- */

function exists(target) {
  try {
    return !!target && fs.existsSync(target)
  } catch {
    return false
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function runProcess(command, args, { cwd, env, timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || WORKSPACE_DIR,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      })
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(-2)
    }, timeoutMs)
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (err) => { stderr += String((err && err.message) || err); finish(-1) })
    child.on('close', (code) => finish(code === null ? -1 : code))
  })
}

/* --------------------------------------------------- Blender 定位 --- */

/**
 * 找 Blender。顺序：
 *   1. 用户在设置里指定的路径
 *   2. 常见安装位置
 *   3. Steam 库（Blender 的 Steam AppID 是 365670，桌面 .url 快捷方式也会指向它）
 *   4. 有界扫描几个可能的盘根
 * 每层都容错，任何一层炸了都继续往下找。
 */
function detectBlender(cfg) {
  const candidates = []

  if (cfg.blenderPath) {
    const p = cfg.blenderPath
    candidates.push(isDir(p) ? path.join(p, 'blender.exe') : p)
  }

  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''

  // 官方安装器通常落在 Blender Foundation\Blender <ver>
  for (const root of [path.join(pf, 'Blender Foundation'), path.join(pf86, 'Blender Foundation')]) {
    if (!isDir(root)) continue
    try {
      for (const entry of fs.readdirSync(root)) {
        candidates.push(path.join(root, entry, 'blender.exe'))
      }
      candidates.push(path.join(root, 'blender.exe'))
    } catch { /* ignore */ }
  }
  candidates.push(path.join(local, 'Programs', 'Blender Foundation', 'blender.exe'))

  // Steam：读库配置，再直接拼常见位置
  const steamRoots = ['D:\\ruanjian\\steam', 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
  const libraries = []
  for (const root of steamRoots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
    if (exists(vdf)) {
      try {
        const text = fs.readFileSync(vdf, 'utf8')
        for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
          libraries.push(m[1].replace(/\\\\/g, '\\'))
        }
      } catch { /* ignore */ }
    }
  }
  // 实测：库可能在别的盘（E:\SteamLibrary），直接扫盘找 steamapps
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    try {
      for (const entry of fs.readdirSync(drive + '\\')) {
        if (/steam/i.test(entry) || /^SteamLibrary$/i.test(entry)) {
          const guess = path.join(drive + '\\', entry)
          if (isDir(guess)) libraries.push(guess)
        }
      }
    } catch { /* ignore */ }
  }
  for (const lib of [...new Set(libraries)]) {
    candidates.push(path.join(lib, 'steamapps', 'common', 'Blender', 'blender.exe'))
  }

  // 桌面快捷方式能直接告诉我们路径或 steam:// 的 AppID
  const desktop = path.join(os.homedir(), 'Desktop')
  if (isDir(desktop)) {
    try {
      for (const entry of fs.readdirSync(desktop)) {
        if (!/blender.*\.(url|lnk)$/i.test(entry)) continue
        const full = path.join(desktop, entry)
        if (entry.toLowerCase().endsWith('.url')) {
          const text = fs.readFileSync(full, 'utf8')
          const m = /^URL=(.+)$/m.exec(text)
          if (m) {
            const target = m[1].trim()
            if (target.startsWith('steam://')) {
              // steam://rungameid/365670 —— 已知就是 Blender，库在上面扫过了
            } else if (exists(target)) {
              candidates.push(isDir(target) ? path.join(target, 'blender.exe') : target)
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  const explicit = ['D:\\ruanjian\\Blender\\blender.exe', 'D:\\Blender\\blender.exe',
    'E:\\Blender\\blender.exe', 'E:\\ruanjian\\Blender\\blender.exe']
  candidates.push(...explicit)

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { path: candidate, version: blenderVersionFromPath(candidate), source: 'auto' }
    }
  }

  // 最后兜底：有界扫描（避免全盘遍历拖慢启动）
  const roots = ['D:\\ruanjian', 'E:\\', 'D:\\', 'E:\\ruanjian', pf]
  const scanned = scanForBlender(roots, 4)
  if (scanned) return { path: scanned, version: blenderVersionFromPath(scanned), source: 'scan' }

  return { path: '', version: '', source: 'none' }
}

function scanForBlender(roots, maxDepth) {
  const walk = (dir, depth) => {
    if (depth > maxDepth) return null
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.toLowerCase() === 'blender') {
        const exe = path.join(dir, entry.name, 'blender.exe')
        if (exists(exe)) return exe
      }
      const hit = walk(path.join(dir, entry.name), depth + 1)
      if (hit) return hit
    }
    return null
  }
  for (const root of roots) {
    if (!isDir(root)) continue
    const hit = walk(root, 1)
    if (hit) return hit
  }
  return null
}

/** Blender 的安装目录名里常带版本（如 Blender 4.2），用它做粗判 */
function blenderVersionFromPath(exe) {
  try {
    const parent = path.basename(path.dirname(exe))
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(parent)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/** 用 --version 拿精确版本（比猜目录名可靠） */
async function blenderVersion(exe) {
  if (!exe) return ''
  const result = await runProcess(exe, ['--version'], { timeoutMs: 30000 })
  const m = /Blender\s+([\d.]+)/.exec(result.stdout || '')
  return m ? m[1] : ''
}

/* ------------------------------------------------- addon 安装到 Blender --- */

/**
 * Blender 的用户脚本目录。
 * 实测 5.2：%APPDATA%\Blender Foundation\Blender\5.2\scripts
 * 不同版本的版本号不同，所以按目录里的最大版本号猜，并用 blender 自己确认。
 */
function blenderScriptsRoot(version) {
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Blender Foundation', 'Blender')
  if (!isDir(base)) return ''
  if (version) {
    const guess = path.join(base, version, 'scripts')
    if (isDir(path.join(base, version))) return guess
  }
  // 取版本号最大的那个目录
  try {
    const versions = fs.readdirSync(base).filter((n) => /^\d+\.\d+/.test(n)).sort(
      (a, b) => {
        const [a1, a2] = a.split('.').map(Number)
        const [b1, b2] = b.split('.').map(Number)
        return (b1 - a1) || (b2 - a2)
      })
    if (versions.length) return path.join(base, versions[0], 'scripts')
  } catch { /* ignore */ }
  return ''
}

/** 插件的 addon 目标目录：<scripts>/addons/dsh_blender_bridge */
function addonTargetDir(scriptsRoot) {
  return scriptsRoot ? path.join(scriptsRoot, 'addons', 'dsh_blender_bridge') : ''
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

/**
 * 用一次无界面的 Blender 把 addon 真正「启用」并持久化到偏好设置。
 *
 * 为什么必须有这一步：往 scripts/addons/ 里复制文件只是「放好了」，
 * Blender 不会自动加载它 —— 必须启用（写进 userpref）才会生效。
 * 用户要的是「自动安装**并启用**」，所以复制完必须再启用一次。
 *
 * ⚠️ 用 `bpy.ops.preferences.addon_enable`（界面里勾选走的就是它），
 * **不要用 `addon_utils.enable()`** —— 实测后者在 save_userpref 之后
 * 重启 Blender 依然是未启用状态，等于白做。
 *
 * ⚠️ 这里也**绝对不能加 --factory-startup**：那会加载出厂设置，
 * 紧接着的 save_userpref() 会把用户自己的偏好全盖掉。
 * 所以故意加载用户现有偏好，只额外做「启用这个插件」一件事。
 */
async function enableAddon(exe, moduleName, log) {
  const code = [
    'import bpy, addon_utils',
    `name = ${JSON.stringify(moduleName)}`,
    'try:',
    '    bpy.ops.preferences.addon_enable(module=name)',
    '    print("DSH_ENABLE_OK=True")',
    'except Exception as exc:',
    '    print("DSH_ENABLE_ERR=%s: %s" % (type(exc).__name__, exc))',
    'in_prefs = name in [a.module for a in bpy.context.preferences.addons]',
    'print("DSH_IN_PREFS=" + str(in_prefs))',
    'if in_prefs:',
    '    bpy.ops.wm.save_userpref()',
    '    print("DSH_SAVED=True")',
    'else:',
    '    print("DSH_SAVED=False")',
  ].join('\n')

  const result = await runProcess(exe, ['--background', '--python-expr', code], { timeoutMs: 180000 })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const info = {
    enabled: /DSH_IN_PREFS=True/.test(output),
    saved: /DSH_SAVED=True/.test(output),
    output: output.trim().slice(-600),
  }
  if (info.enabled && info.saved) log('info', `已在 Blender 偏好设置里启用并保存 ${moduleName}`)
  else log('warn', `没能自动启用 ${moduleName}（可在 Blender 里手动勾选）`)
  return info
}

/**
 * 重新加载一次 addon，让服务立刻起来（不用等用户重启 Blender）。
 *
 * 用户很可能正开着 Blender。启用偏好只影响**下次**启动，所以要让它现在就能用，
 * 得让运行中的那个实例重新加载一次。做法：写一个一次性脚本文件，
 * 由 Blender 自己执行 `addon_utils.enable` —— 但**运行中的实例无法被外部命令驱动**。
 * 所以这里只能把「需要重启」如实告诉用户，不做假动作。
 */
function reloadHint() {
  return '如果 Blender 正开着，请完全关掉再重新打开 —— 它才会加载新插件。'
}

/**
 * 把 addon 装进 Blender 并启用，同时把共享建模层复制过去（自包含）。
 *
 * addon 装到 <scripts>/addons/dsh_blender_bridge/，并把
 * modeling_ops.py / preview_render.py / modeling_driver.py 复制到它旁边，
 * 这样 addon 不依赖插件的源码目录。
 */
async function installAddon(cfg, log) {
  const blender = detectBlender(cfg)
  if (!blender.path) {
    return { ok: false, error: '先找到 Blender 才能安装桥接组件。请在设置里填 Blender 的位置。' }
  }
  if (!exists(ADDON_SRC)) {
    return { ok: false, error: `插件里缺少桥接组件源码：${ADDON_SRC}` }
  }
  const scriptsRoot = blenderScriptsRoot(blender.version)
  if (!scriptsRoot) {
    return {
      ok: false,
      error: '找不到 Blender 的用户脚本目录（%APPDATA%\\Blender Foundation\\Blender\\<版本>\\scripts）。'
        + '请先启动一次 Blender，让它生成配置目录，然后重试。',
    }
  }

  const target = addonTargetDir(scriptsRoot)
  try {
    fs.mkdirSync(target, { recursive: true })
    // addon 主体
    fs.copyFileSync(path.join(ADDON_SRC, '__init__.py'), path.join(target, '__init__.py'))
    // 共享层复制到 addon 旁边，做到自包含
    for (const file of ['modeling_ops.py', 'preview_render.py', 'modeling_driver.py']) {
      const from = path.join(PLUGIN_DIR, 'blender', file)
      if (exists(from)) fs.copyFileSync(from, path.join(target, file))
    }
  } catch (err) {
    return { ok: false, error: `复制桥接组件失败：${err.message}` }
  }

  const files = fs.readdirSync(target).filter((n) => n.endsWith('.py'))
  log('info', `桥接组件文件已就位：${target}`)

  // 复制完还要真正启用，否则 Blender 根本不会加载它
  let enable = { found: false, enabled: false, saved: false }
  try {
    enable = await enableAddon(blender.path, ADDON_MODULE, log)
  } catch (err) {
    log('warn', `启用步骤异常：${(err && err.message) || err}`)
  }
  markAddonEnabled(enable.enabled === true)

  return {
    ok: true,
    target,
    scriptsRoot,
    module: ADDON_MODULE,
    files,
    blender: blender.path,
    enabled: enable.enabled,
    enabledPersisted: enable.saved,
    needsRestart: true,
    note: enable.enabled
      ? '装好了，并且已经写进 Blender 的偏好设置。' + reloadHint()
        + '打开后左侧会出现「DSH」面板。'
      : '文件已经放好了，但没能自动启用。请到 Blender 的「编辑 → 偏好设置 → 插件」里搜 DSH，'
        + '手动勾选一下；勾完重启 Blender。',
  }
}

function addonStatus(cfg) {
  const blender = detectBlender(cfg)
  const scriptsRoot = blenderScriptsRoot(blender.version)
  const target = addonTargetDir(scriptsRoot)
  const entry = target ? path.join(target, '__init__.py') : ''
  const shared = target ? ['modeling_ops.py', 'preview_render.py', 'modeling_driver.py']
    .filter((f) => exists(path.join(target, f))) : []
  const installed = !!entry && exists(entry)
  return {
    installed,
    // 文件就位 ≠ Blender 会加载它，必须启用过才算真的能用
    enabledInBlender: installed ? addonEnabledFlag() : false,
    target: target || '',
    scriptsRoot: scriptsRoot || '',
    sharedFiles: shared,
    complete: installed && shared.length === 3,
  }
}

/** 启用标记：装成功时记一笔，避免每次查状态都去起一次 Blender */
function addonEnabledFlag() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'addon-enabled.json'), 'utf8')).enabled === true
  } catch {
    return false
  }
}

function markAddonEnabled(enabled) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, 'addon-enabled.json'), JSON.stringify({ enabled, at: Date.now() }), 'utf8')
  } catch { /* ignore */ }
}

/* ------------------------------------------------- APP 模式：连桥接 --- */

/** addon 写出的端口发现文件（和 addon 里的 _discovery_path() 规则一致） */
const DISCOVERY_FILE = path.join(DATA_DIR, 'bridge.json')

/**
 * 桥接实际监听的端口。
 *
 * 不能直接信配置里的端口：addon 在端口被占用时会自动往后找可用的，
 * 然后把**实际**端口写进发现文件。所以以发现文件为准，
 * 读不到才退回配置值。这样用户手动启动 Blender 也能连上。
 */
function bridgePortFor(cfg) {
  try {
    const info = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'))
    const port = Number(info.port)
    if (Number.isFinite(port) && port > 0 && port < 65536) {
      return { port, source: 'discovery', pid: info.pid, blender: info.blender }
    }
  } catch { /* 没有发现文件就退回配置 */ }
  return { port: Number(cfg.bridgePort), source: 'config' }
}

/** 往本地桥接发一条请求（换行分隔 JSON）。 */
function bridgeRequest(port, payload, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) })
    let settled = false
    let buffer = ''
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch { /* ignore */ }
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, error: `连接超时（${timeoutMs}ms）` }), timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      const line = buffer.slice(0, nl)
      try {
        done({ ok: true, response: JSON.parse(line) })
      } catch (err) {
        done({ ok: false, error: `桥接返回了非 JSON 内容：${line.slice(0, 120)}` })
      }
    })
    socket.on('error', (err) => {
      const code = err && err.code
      if (code === 'ECONNREFUSED') {
        done({ ok: false, error: 'connection-refused', code })
      } else {
        done({ ok: false, error: String((err && err.message) || err), code })
      }
    })
  })
}

/** 桥接是否在线。先用发现文件里的真实端口，连不上再退回配置端口。 */
async function bridgeAlive(cfg, timeoutMs) {
  const resolved = bridgePortFor(cfg)
  const tried = [resolved.port]
  if (resolved.port !== Number(cfg.bridgePort)) tried.push(Number(cfg.bridgePort))

  let lastError = ''
  for (const port of tried) {
    const result = await bridgeRequest(port, { id: 1, cmd: 'ping' }, timeoutMs || 1500)
    if (!result.ok) {
      lastError = result.error
      // 端口上有人但不是我们的桥接（连上了却不懂协议）—— 换个端口再试
      if (result.error !== 'connection-refused' && tried.length > 1) continue
      if (result.error === 'connection-refused' && tried.length > 1) continue
    } else {
      const res = result.response || {}
      // 必须真的回我们的格式，否则就是别人占着这个端口
      if (res.ok && res.data && res.data.pong === true) {
        return { alive: true, blender: res.data.blender || '', port, source: resolved.source }
      }
      lastError = '端口上不是 DSH 桥接（返回了不认识的响应）'
      continue
    }
  }
  return { alive: false, error: lastError || '连不上', port: resolved.port, source: resolved.source }
}

/* ------------------------------------------------------- 技能注册 --- */

/**
 * 读技能目录，产出 provider 需要的候选列表。
 * 技能只在被真正调用时才读正文，平时只暴露 name + description（省 token）。
 */
function listBundledSkills() {
  const out = []
  if (!isDir(SKILLS_DIR)) return out
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md')
    if (!exists(file)) continue
    try {
      const text = fs.readFileSync(file, 'utf8')
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      if (!m) continue
      const meta = {}
      for (const line of m[1].split(/\r?\n/)) {
        const idx = line.indexOf(':')
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      }
      if (!meta.name) continue
      out.push({
        name: meta.name,
        description: meta.description || '',
        modelInvocable: true,
        userInvocable: true,
        path: file,
        _file: file,
      })
    } catch { /* 坏掉的技能跳过，不影响其它 */ }
  }
  return out
}

/* --------------------------------------------------------- 执行通道 --- */

/**
 * 跑一批建模指令 —— 两条通道的唯一分发点。
 *
 * APP 模式：走桥接，指令在 Blender 主线程逐条执行，用户在界面上实时看到。
 * 终端模式：起一个 blender --background 子进程跑驱动脚本。
 */
async function runInstructions(cfg, request, log) {
  const instructions = Array.isArray(request.instructions) ? request.instructions : []
  if (!instructions.length) return { ok: false, error: '没有要执行的建模指令' }

  const mode = request.mode === 'app' || request.mode === 'terminal'
    ? request.mode
    : (cfg.mode || 'app')

  const wantRender = request.render !== false && cfg.autoPreview !== false
  const stamp = Date.now()
  const outDir = String(request.outDir || cfg.outDir || defaults().outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const title = String(request.title || 'model').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'model'
  const blendPath = path.join(outDir, `${title}-${stamp}.blend`)
  const previewDir = path.join(outDir, `${title}-${stamp}-preview`)

  if (mode === 'app') {
    const alive = await bridgeAlive(cfg, 2000)
    if (!alive.alive) {
      return {
        ok: false,
        mode,
        error: alive.error === 'connection-refused'
          ? '连不上 Blender。APP 模式需要 Blender 开着、并且装好了桥接组件（设置页有一键安装）。'
          : `连不上 Blender 桥接：${alive.error}`,
        hint: '可以改用终端模式（不需要 Blender 开着），或先在设置页安装桥接组件并启动 Blender。',
      }
    }

    // 用**实际**监听的端口（addon 可能因为端口被占而换过端口）
    const port = alive.port || bridgePortFor(cfg).port
    log('info', `APP 模式：向 Blender(端口 ${port}) 发送 ${instructions.length} 条指令`)
    // 先清空，保证可复现
    await bridgeRequest(port, { id: stamp, cmd: 'reset', timeout: 60 }, 60000)

    const execResult = await bridgeRequest(
      port,
      { id: stamp + 1, cmd: 'exec', instructions, timeout: Math.ceil((cfg.terminalTimeoutMs || 600000) / 1000) },
      cfg.terminalTimeoutMs || 600000,
    )
    if (!execResult.ok) return { ok: false, mode, error: execResult.error }
    if (!execResult.response.ok) return { ok: false, mode, error: execResult.response.error }

    const data = { ...execResult.response.data, port }
    data.summary = data.summary || (await bridgeRequest(port, { id: stamp + 2, cmd: 'summary' }, 30000)).response?.data

    const saved = await bridgeRequest(port, { id: stamp + 3, cmd: 'save', path: blendPath }, 120000)
    if (saved.ok && saved.response.ok) data.blend = blendPath
    else data.saveError = saved.ok ? saved.response.error : saved.error

    if (wantRender) {
      const rendered = await bridgeRequest(port, {
        id: stamp + 4, cmd: 'render', out_dir: previewDir,
        width: cfg.previewWidth, height: cfg.previewHeight, angles: cfg.previewAngles,
      }, 600000)
      if (rendered.ok && rendered.response.ok) {
        data.render = rendered.response.data
        data.previews = (rendered.response.data.shots || []).map((s) => s.path)
      } else {
        data.renderError = rendered.ok ? rendered.response.error : rendered.error
      }
    }

    return { ok: true, mode, ...data }
  }

  // ---- 终端模式 ----
  const blender = detectBlender(cfg)
  if (!blender.path) {
    return { ok: false, mode, error: '找不到 Blender。请在设置页填一下 Blender 的位置。' }
  }
  if (!exists(DRIVER)) {
    return { ok: false, mode, error: `插件缺少驱动脚本：${DRIVER}` }
  }

  const payload = {
    instructions,
    save: blendPath,
    render: wantRender ? previewDir : undefined,
    width: cfg.previewWidth,
    height: cfg.previewHeight,
    angles: cfg.previewAngles,
    open: request.open || undefined,
  }
  const reqFile = path.join(DATA_DIR, `request-${stamp}.json`)
  const resFile = path.join(DATA_DIR, `result-${stamp}.json`)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(reqFile, JSON.stringify(payload, null, 2), 'utf8')

  log('info', `终端模式：跑 ${instructions.length} 条指令（blender --background）`)
  const result = await runProcess(
    blender.path,
    ['--background', '--factory-startup', '--python', DRIVER, '--', '--json', reqFile, '--out', resFile],
    { timeoutMs: cfg.terminalTimeoutMs || 600000 },
  )

  let parsed = null
  try {
    if (exists(resFile)) parsed = JSON.parse(fs.readFileSync(resFile, 'utf8'))
  } catch { parsed = null }
  for (const f of [reqFile, resFile]) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }

  if (!parsed) {
    const tail = (result.stderr || result.stdout || '').trim().slice(-1500)
    return { ok: false, mode, error: `Blender 没有返回结果（退出码 ${result.code}）。${tail ? '\n' + tail : ''}` }
  }
  if (!parsed.ok) return { ok: false, mode, error: parsed.reason, ...parsed.data }
  return { ok: true, mode, ...parsed.data }
}

/* ------------------------------------------------------- 技能状态 --- */

/**
 * 技能当前在 DSH 里到底是不是真的可用。
 *
 * 刻意**不**只看本地变量 —— 要真的去问注册表：目录里有没有、能不能加载正文。
 * 因为契约不符时注册表是静默跳过的，插件自己以为自己注册了，实际什么都没有。
 * 这个报告就是用来戳穿那种情况的。
 */
async function buildSkillReport() {
  const bundled = listBundledSkills()
  const report = {
    provider: SKILL_PROVIDER,
    bundledDir: SKILLS_DIR,
    bundledCount: bundled.length,
    bundledNames: bundled.map((s) => s.name),
    registryAvailable: !!skillsService,
    inCatalog: false,
    loadable: false,
    visible: false,
    contentLength: 0,
    catalogNames: [],
    error: '',
  }

  if (!skillsService) {
    report.error = '这个 profile 里没有技能服务（@deepseek-ai/dsh-skill 未挂载），插件装的技能无法生效。'
    return report
  }

  const name = bundled[0]?.name
  if (!name) {
    report.error = '插件里没有找到技能文件。'
    return report
  }

  try {
    const listed = await skillsService.list({ cwd: PLUGIN_DIR })
    const catalog = Array.isArray(listed) ? listed : (listed?.skills || [])
    report.catalogNames = catalog.map((s) => s.name)
    report.inCatalog = catalog.some((s) => s.name === name)

    const def = await skillsService.get(name, { cwd: PLUGIN_DIR })
    if (def && typeof def.content === 'string') {
      report.loadable = true
      report.contentLength = def.content.length
    }
    report.visible = report.inCatalog && report.loadable
    if (!report.visible) {
      report.error = report.inCatalog
        ? '技能在目录里，但正文加载失败。'
        : '技能没有出现在 DSH 的技能目录里（provider 注册可能被跳过了）。'
    }
  } catch (err) {
    report.error = `查询技能注册表失败：${(err && err.message) || err}`
  }
  return report
}

/* ------------------------------------------------------- 状态汇总 --- */

async function buildStatus(cfg) {
  const blender = detectBlender(cfg)
  const version = await blenderVersion(blender.path)
  const addon = addonStatus(cfg)
  const bridge = blender.path ? await bridgeAlive(cfg, 1500) : { alive: false, error: '还没找到 Blender' }
  const skills = listBundledSkills()

  let outDirWritable = false
  try {
    fs.mkdirSync(cfg.outDir, { recursive: true })
    fs.accessSync(cfg.outDir, fs.constants.W_OK)
    outDirWritable = true
  } catch { /* ignore */ }

  return {
    blender: {
      found: !!blender.path,
      path: blender.path,
      version,
      source: blender.source,
    },
    addon: { ...addon, needsRestart: addon.installed },
    bridge: { ...bridge, configuredPort: Number(cfg.bridgePort), port: bridge.port || Number(cfg.bridgePort) },
    skills: {
      dir: SKILLS_DIR,
      count: skills.length,
      names: skills.map((s) => s.name),
      // 真的去问注册表，而不是只报「我有技能文件」
      registry: await buildSkillReport(),
    },
    outDir: { path: cfg.outDir, writable: outDirWritable },
    ready: {
      // 终端模式只需要找到 Blender
      terminal: !!blender.path && exists(DRIVER),
      // APP 模式还需要桥接在线
      app: !!blender.path && bridge.alive === true,
    },
  }
}

/* ------------------------------------------------------------- 路由工具 --- */

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4 * 1024 * 1024) {
        raw = raw.slice(0, 4 * 1024 * 1024)
        try { req.destroy() } catch { /* ignore */ }
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

function listOutputs(dir, limit = 40) {
  const out = []
  if (!isDir(dir)) return out
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!['.blend', '.png'].includes(ext)) continue
      const full = path.join(dir, entry.name)
      const stat = fs.statSync(full)
      out.push({ name: entry.name, path: full, size: stat.size, modified: stat.mtimeMs, kind: ext === '.blend' ? 'blend' : 'image' })
    }
  } catch { /* ignore */ }
  out.sort((a, b) => b.modified - a.modified)
  return out.slice(0, limit)
}

/* ------------------------------------------------------------- 提示词段 --- */

function buildPromptSection(cfg) {
  const lines = [
    '## Blender 建模（本机已装好，可直接用）',
    '',
    '用户要「建模 / 做 3D / 出个模型 / 建个场景」时，用这个能力，不要凭空描述步骤。',
    '完整的操作手册在技能 `blender-modeling` 里 —— **先加载它再动手**，那里有指令表、',
    '预览评审要点和建模范式。这里只讲怎么选通道。',
    '',
    '### 两种通道',
    '',
    '**APP 模式** —— 指令发给 Blender 里的桥接，在主线程逐条执行，**用户能在 Blender 界面',
    '实时看到每一步**。需要 Blender 开着且装好桥接组件。用户说「我想看着建」时用它。',
    '',
    '**终端模式** —— `blender --background --python` 跑一批指令，只有结果，看不到过程。',
    '不需要 Blender 开着，适合批量与无人值守。',
    '',
    '### 怎么调',
    '',
    `- 设置页「Blender 建模」里有环境状态、模式切换、一键安装桥接组件、成片列表`,
    `- 成片输出到：${cfg.outDir}`,
    `- 默认模式：${cfg.mode === 'app' ? 'APP（实时可见）' : '终端（后台）'}`,
    '',
    '### 自查闭环（重要）',
    '',
    '每做完一轮就在设置页点预览，或让插件自动渲染 —— 渲染器会自动取景、加三点光和地面，',
    '出图是可判读的。**然后真的去看那张图**，不要因为命令都成功就以为模型对了。',
    '看轮廓像不像、比例对不对、有没有悬空或穿模。通常要两三轮；一轮几乎不够。',
    '',
    '### 常见坑',
    '- 先 `reset` 再建，否则出厂 Cube 会混进模型里（还会把自动取景撑大）',
    '- 每个物体都要起名字，否则后续指令会因为 `Cube.001` 找不到目标而失败',
    '- 布尔切割的刀具物体必须先创建；切完默认会被删掉，别再引用它',
    '- 尺度最容易错：椅子约 1 米高、杯子约 0.1 米。比例错了预览一眼就能看出来',
  ]
  return lines.join('\n')
}

/* ------------------------------------------------- 可选依赖的稳健解析 --- */

/**
 * 解析 `@deepseek-ai/dsh-tools` 并从若干候选位置取 `defineTool`。
 *
 * 为什么不能直接 `import('@deepseek-ai/dsh-tools')`：
 * 裸标识符按**导入文件所在位置**逐级向上找 node_modules，而本插件常以 `link:`
 * 装在 profile **之外**（例如 E:\dshplugins\...），那条路径上根本没有 DSH 的包，
 * 结果是 MODULE_NOT_FOUND —— 而且被 .catch 吞掉，表现为「工具从来没注册上，还没人知道」。
 *
 * 所以这里显式枚举候选基点：插件自身位置（装在 profile 里时成立）+
 * $DSH_HOME/profiles 及其下每个 profile（link 安装时靠这条）。
 * 用 createRequire 走 Node 正规算法，能正确处理 exports 映射，比硬拼 lib/index.js 稳。
 */
function moduleResolutionBases() {
  const bases = [fileURLToPath(import.meta.url)]

  const addProfilesRoot = (root) => {
    if (!root) return
    bases.push(path.join(root, 'index.js'))
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          bases.push(path.join(root, entry.name, 'index.js'))
        }
      }
    } catch { /* 这个 root 不存在就跳过 */ }
  }

  addProfilesRoot(path.join(DSH_HOME, 'profiles'))
  // 兜底：DSH_HOME 没设或指向别处时，用户默认目录通常才是对的。
  // 和 addon 写端口发现文件时的兜底规则保持一致。
  const homeProfiles = path.join(os.homedir(), '.dsh', 'profiles')
  if (path.resolve(homeProfiles) !== path.resolve(path.join(DSH_HOME, 'profiles'))) {
    addProfilesRoot(homeProfiles)
  }

  return [...new Set(bases)]
}

async function loadDefineTool(log) {
  const tried = []
  for (const base of moduleResolutionBases()) {
    let resolved = ''
    try {
      resolved = createRequire(base).resolve('@deepseek-ai/dsh-tools')
    } catch {
      continue // 这个基点解析不到，换下一个
    }
    if (tried.includes(resolved)) continue
    tried.push(resolved)
    try {
      const mod = await import(pathToFileURL(resolved).href)
      if (typeof mod.defineTool === 'function') {
        log('info', `已从 ${resolved} 加载 defineTool`)
        return mod.defineTool
      }
      log('warn', `加载到了 ${resolved}，但里面没有 defineTool`)
    } catch (err) {
      log('warn', `导入 ${resolved} 失败：${(err && err.message) || err}`)
    }
  }
  if (log && tried.length === 0) {
    log('warn', '在所有候选位置都没解析到 @deepseek-ai/dsh-tools')
  }
  return null
}

/* ------------------------------------------------------------------ 主体 --- */

export function apply(ctx, patchRaw) {
  const log = makeLogger(ctx)
  let cfg = mergeConfig(patchRaw)

  ctx.effect(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
    const blender = detectBlender(cfg)
    log('info', blender.path
      ? `Blender 建模插件已加载：${blender.path}`
      : 'Blender 建模插件已加载，但没找到 Blender（可在设置页手动指定）')
  }, 'blender.init')

  // 1) 让模型知道有这个能力
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'blender',
      order: 10270,
      text: buildPromptSection(cfg),
    }),
    'blender.prompt',
  )

  // 2) 把自带技能装进 DSH —— 这就是「用插件来安装技能」
  //
  // 契约（照真实 dsh-skill 实现，不是照 README 猜的）：
  //   · registerProvider(create) 的入参是**同步工厂函数**，注册表会调用 create(control) 取 provider。
  //     直接传对象会在 provider = create(control) 处抛错。
  //   · list() 返回的候选项必须带 source(string)、rank(有限数)、provider(且必须等于本 provider 名)，
  //     调用策略要包在 invocation 对象里。缺一项就会在 validateCandidate 抛错，
  //     而注册表对发现失败的 provider 是**静默跳过**的 —— 表现就是「插件在跑但技能没出现」。
  //   · get() 收到的是**候选对象**（不是名字），要返回带 content 的完整定义。
  //
  // 这几个点最初全写错了，而且我自己的 mock 比真实实现宽松，测出来是假绿。
  // 现在 tools/smoke-skill.mjs 直接对**真实注册表**做集成测试，契约不符必然失败。
  ctx.inject(['skills'], (child) => {
    skillsService = child.skills
    child.effect(() => {
      const dispose = child.skills.registerProvider(() => ({
        name: SKILL_PROVIDER,
        // ⚠️ list() 与 get() 必须是**异步**的（返回 Promise）。
        // 注册表内部：
        //     function waitWithAbort(promise, signal) {
        //       if (signal === void 0) return promise;
        //       ...
        //       promise.then(...)      // 有 signal 就直接调 .then
        //     }
        // 真实宿主查目录与加载技能时都会传 options.signal，所以返回同步值会抛
        // 「promise.then is not a function」。而且不带 signal 就测不出来 ——
        // 我的集成测试最初没传 signal，一直假绿。现在这两处都是 async。
        async list() {
          return listBundledSkills().map((skill) => ({
            name: skill.name,
            description: skill.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            rank: 0,
            provider: SKILL_PROVIDER,
            path: skill.path,
          }))
        },
        async get(candidate) {
          const file = candidate && candidate.path
          if (!file || !exists(file)) return undefined
          let text
          try {
            text = fs.readFileSync(file, 'utf8')
          } catch {
            return undefined
          }
          // frontmatter 是元数据，不是给模型看的指令，剥掉
          const content = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
          return {
            name: candidate.name,
            description: candidate.description,
            invocation: candidate.invocation,
            source: candidate.source,
            provider: SKILL_PROVIDER,
            content,
            path: file,
            // 让模型知道 SKILL.md 里提到的 references/xxx.md 该相对哪个目录解析
            resourceBase: { kind: 'directory', path: path.dirname(file) },
          }
        },
      }))
      const count = listBundledSkills().length
      log('info', `已注册技能 provider「${SKILL_PROVIDER}」，提供 ${count} 个技能`)
      return typeof dispose === 'function' ? dispose : () => {}
    }, 'blender.skills')
  })

  // 3) 设置页用的同源路由
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (req, res) => {
        const method = (req.method || 'GET').toUpperCase()
        const url = String(req.url || '')
        const sub = url.split('?')[0].slice(BASE.length).replace(/^\/+/, '').replace(/\/+$/, '')

        try {
          if (sub === 'status' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, config: cfg, status: await buildStatus(cfg) })
          }

          if (sub === 'config' && method === 'POST') {
            const raw = await readBody(req)
            let payload
            try { payload = JSON.parse(raw || '{}') } catch {
              return sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
            }
            try {
              writeConfigFile(normalizePatch(payload))
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: `保存失败：${err.message}` })
            }
            cfg = mergeConfig(patchRaw)
            log('info', '设置已更新')
            return sendJson(res, 200, { ok: true, config: cfg, status: await buildStatus(cfg) })
          }

          if (sub === 'install-addon' && method === 'POST') {
            const result = await installAddon(cfg, log)
            return sendJson(res, result.ok ? 200 : 400, result)
          }

          if (sub === 'start-blender' && method === 'POST') {
            const blender = detectBlender(cfg)
            if (!blender.path) return sendJson(res, 400, { ok: false, error: '没找到 Blender' })
            try {
              spawn(blender.path, [], { detached: true, stdio: 'ignore' }).unref()
              log('info', `已启动 Blender：${blender.path}`)
              return sendJson(res, 200, { ok: true, path: blender.path })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: String(err.message) })
            }
          }

          if (sub === 'bridge' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, ...(await bridgeAlive(cfg, 3000)) })
          }

          if (sub === 'run' && method === 'POST') {
            const raw = await readBody(req)
            let payload
            try { payload = JSON.parse(raw || '{}') } catch {
              return sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
            }
            const result = await runInstructions(cfg, payload, log)
            return sendJson(res, result.ok ? 200 : 500, result)
          }

          if (sub === 'skill' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, skill: await buildSkillReport() })
          }

          if (sub === 'outputs' && (method === 'GET' || method === 'HEAD')) {
            return sendJson(res, 200, { ok: true, outDir: cfg.outDir, outputs: listOutputs(cfg.outDir) })
          }

          if (sub === 'file' && (method === 'GET' || method === 'HEAD')) {
            const wanted = decodeURIComponent((/[?&]path=([^&]*)/.exec(String(req.url || '')) || [])[1] || '')
            const resolved = path.resolve(wanted)
            const root = path.resolve(cfg.outDir)
            if (!resolved.toLowerCase().startsWith(root.toLowerCase()) || !exists(resolved)) {
              return sendJson(res, 403, { ok: false, error: '不允许访问这个路径' })
            }
            let stat
            try { stat = fs.statSync(resolved) } catch (err) {
              return sendJson(res, 500, { ok: false, error: String(err.message) })
            }
            const type = path.extname(resolved).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream'
            const range = req.headers?.range
            res.setHeader('Content-Type', type)
            res.setHeader('Accept-Ranges', 'bytes')
            if (range) {
              const m = /bytes=(\d*)-(\d*)/.exec(range)
              const start = m && m[1] ? Number(m[1]) : 0
              const end = m && m[2] ? Number(m[2]) : stat.size - 1
              if (start >= stat.size || end >= stat.size || start > end) {
                res.statusCode = 416
                res.setHeader('Content-Range', `bytes */${stat.size}`)
                return res.end()
              }
              res.statusCode = 206
              res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
              res.setHeader('Content-Length', String(end - start + 1))
              if (method === 'HEAD') return res.end()
              return fs.createReadStream(resolved, { start, end }).pipe(res)
            }
            res.statusCode = 200
            res.setHeader('Content-Length', String(stat.size))
            if (method === 'HEAD') return res.end()
            return fs.createReadStream(resolved).pipe(res)
          }

          if (sub === 'reveal' && method === 'POST') {
            const raw = await readBody(req)
            let payload = {}
            try { payload = JSON.parse(raw || '{}') } catch { /* 允许空 */ }
            const target = String(payload.path || cfg.outDir)
            try {
              if (isDir(target)) spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
              else spawn('explorer.exe', ['/select,' + target.replace(/\//g, '\\')], { detached: true, stdio: 'ignore' }).unref()
              return sendJson(res, 200, { ok: true })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: String(err.message) })
            }
          }

          return sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (err) {
          log('error', '路由处理失败', err)
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    }),
    'blender.routes()',
  )

  // 4) 可选：能拿到 defineTool 就再送两个模型可见工具
  //
  // ⚠️ 这里不能用裸的 `import('@deepseek-ai/dsh-tools')`。
  // 裸标识符是**按导入文件的位置**解析的，而本插件常以 `link:` 装在 profile 之外
  // （如 E:\dshplugins\...），从那里往上找永远找不到 profile 里的 node_modules —
  // 实测就是 MODULE_NOT_FOUND，工具静默地从未注册成功。
  // 所以要显式地从若干候选位置解析：插件自身位置 + 各个 profile 目录。
  ctx.inject(['tools'], (child) => {
    loadDefineTool(log)
      .then((defineTool) => {
        if (typeof defineTool !== 'function') {
          log('warn', '没找到 @deepseek-ai/dsh-tools，跳过工具注册（设置页与技能能力不受影响）')
          return
        }
        const envTool = defineTool({
          name: 'blender_environment',
          description:
            '查看 Blender 建模环境：Blender 装在哪、桥接组件装了没、APP 模式（实时可见）和终端模式现在哪个可用。建模之前先调它。',
          parameters: {},
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute() {
            return JSON.stringify(await buildStatus(cfg), null, 2)
          },
        })
        const runTool = defineTool({
          name: 'blender_model',
          description:
            '在 Blender 里执行一批建模指令并（默认）渲染预览图。指令格式见 blender-modeling 技能。'
            + 'APP 模式会在用户眼前实时建，终端模式在后台建。返回 .blend 路径、场景摘要和预览图路径。',
          parameters: {
            instructions: {
              type: 'array',
              // DSH 的 JSON Schema 子集**强制要求** object 显式声明 additionalProperties，
              // 漏了会直接抛：unsupported JSON schema: ... must be explicitly true or false。
              // 这一条让工具注册整个失败（两个都装不上），而且只在运行时才暴露。
              items: { type: 'object', additionalProperties: true },
              required: true,
              description: '建模指令数组',
            },
            title: { type: 'string', description: '模型名，用作文件名' },
            mode: { type: 'string', description: 'app（实时可见）或 terminal（后台），留空用默认' },
            render: { type: 'boolean', description: '是否渲染预览图，默认是' },
          },
          output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
          async execute(args) {
            const result = await runInstructions(cfg, {
              instructions: args.instructions,
              title: args.title,
              mode: args.mode,
              render: args.render,
            }, log)
            return JSON.stringify(result, null, 2)
          },
        })
        child.effect(() => child.tools.register(envTool), 'blender.tool.environment')
        child.effect(() => child.tools.register(runTool), 'blender.tool.model')
        log('info', '已注册模型可见工具：blender_environment、blender_model')
      })
      .catch((err) => {
        log('warn', `工具注册失败（设置页与技能能力不受影响）：${(err && err.message) || err}`)
      })
  })
}
