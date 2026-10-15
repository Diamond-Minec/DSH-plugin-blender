#!/usr/bin/env node
/**
 * 静态自检：不需要 DSH、不需要 Blender、不需要第三方包。适合 CI 与提交前跑。
 *
 *   node tools/verify.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []
let checks = 0

function pass(label, detail) { checks++; console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`) }
function fail(label, detail) { checks++; failures.push(label); console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`) }
function warn(label, detail) { warnings.push(label); console.log(`[WARN] ${label}${detail ? ` — ${detail}` : ''}`) }
function skip(label, detail) { console.log(`[SKIP] ${label}${detail ? ` — ${detail}` : ''}`) }
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`) }

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/**
 * 去掉 JS 的块注释与行注释，只留真代码。
 * 否则「这里不能用裸的 import('@deepseek-ai/dsh-tools')」这种说明文字会被当成真调用。
 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

/** 去掉 Python 的文档字符串与 # 注释，只留真代码（避免把说明文字当成真调用）。 */
function stripPythonDocs(src) {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n')
}

const allFiles = walk(ROOT)
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

/* ------------------------------------------------------------ 1. JSON --- */
section('1. JSON 可解析性')
let manifest = null
for (const file of allFiles.filter((f) => f.endsWith('.json'))) {
  const r = rel(file)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    pass(r)
    if (r === 'package.json') manifest = parsed
  } catch (err) {
    fail(r, err.message)
  }
}

/* -------------------------------------------------------------- 2. JS --- */
section('2. JavaScript 语法')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-verify-'))
for (const file of allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
  const r = rel(file)
  const copy = path.join(tmp, path.basename(file).replace(/\.js$/, '') + '.mjs')
  fs.copyFileSync(file, copy)
  const res = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  if (res.status === 0) pass(r)
  else fail(r, (res.stderr || '').split('\n').slice(0, 3).join(' ').trim())
}
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------------------------------------------------- 3. Python --- */
section('3. Python 语法')
const pyFiles = allFiles.filter((f) => f.endsWith('.py'))
const pythonCandidates = [
  process.env.BLENDER_PYTHON,
  path.join(ROOT, '..', 'runtimes', 'jianying-venv', 'Scripts', 'python.exe'),
  'python', 'python3',
].filter(Boolean)
let pythonExe = ''
for (const cand of pythonCandidates) {
  const probe = spawnSync(cand, ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) { pythonExe = cand; break }
}
if (!pythonExe) {
  skip('Python 语法', '没找到 Python（装好运行环境后会自动检查）')
} else {
  console.log(`       使用解释器：${pythonExe}`)
  for (const file of pyFiles) {
    const r = rel(file)
    const res = spawnSync(pythonExe, ['-m', 'py_compile', file], { encoding: 'utf8' })
    if (res.status === 0) pass(r)
    else fail(r, (res.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' '))
  }
  for (const dir of ['blender', 'blender/addon']) {
    const cache = path.join(ROOT, dir, '__pycache__')
    if (fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------- 4. Manifest --- */
section('4. 插件 manifest 不变量')
if (!manifest) {
  fail('package.json 可读')
} else {
  pass('name', manifest.name)
  if (/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name || '')) pass('name 符合包名规范')
  else fail('name 符合包名规范', String(manifest.name))

  if (manifest.private === true) warn('标了 private: true', 'npm publish 会被拒绝')
  else pass('未标 private（可发布到 npm）')
  if (manifest.scripts?.prepublishOnly) pass('有 prepublishOnly 钩子')
  else warn('没有 prepublishOnly 钩子')

  const repoUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (!repoUrl) warn('没有 repository', 'npm 包不会与 GitHub 仓库关联')
  else if (repoUrl.includes('YOUR-GITHUB-USERNAME')) fail('repository 还是占位符', repoUrl)
  else pass('repository 已填', repoUrl)

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string' && fs.existsSync(path.join(ROOT, patch))) {
    pass('dsh.bundle.patch 存在', patch)
    const text = fs.readFileSync(path.join(ROOT, patch), 'utf8')
    if (text.includes(manifest.name)) pass('patch 引用了本包名')
    else fail('patch 引用了本包名', `找不到 "${manifest.name}"`)
    if (/^\s*-\s*insert:/m.test(text)) pass('patch 使用 insert 行')
    else fail('patch 使用 insert 行')
  } else {
    fail('dsh.bundle.patch 存在', String(patch))
  }

  const client = manifest.dsh?.client
  if (client && typeof client === 'object') {
    pass('dsh.client 已声明')
    if (client.platform === 'web') pass('dsh.client.platform 为 web')
    else fail('dsh.client.platform 为 web', String(client.platform))
    const clientExport = manifest.exports?.['./client']
    if (clientExport && fs.existsSync(path.join(ROOT, clientExport))) pass('exports["./client"] 有效')
    else fail('exports["./client"] 有效', String(clientExport))
  } else {
    warn('dsh.client 未声明')
  }

  if (typeof manifest.icon === 'string') {
    const iconPath = path.join(ROOT, manifest.icon)
    if (!fs.existsSync(iconPath)) fail('icon 文件存在', manifest.icon)
    else {
      const size = fs.statSync(iconPath).size
      const ext = path.extname(manifest.icon).toLowerCase()
      if (!['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) fail('icon 扩展名允许', ext)
      else if (size > 256 * 1024) fail('icon 不超过 256 KiB', `${(size / 1024).toFixed(1)} KiB`)
      else pass('icon', `${manifest.icon} (${(size / 1024).toFixed(1)} KiB)`)
    }
  } else {
    warn('icon 未声明')
  }

  if (manifest.meta?.title && manifest.meta?.description) pass('meta 展示信息已声明')
  else warn('meta 展示信息不完整')

  for (const file of ['locale/zh.json', 'locale/en.json']) {
    const p = path.join(ROOT, file)
    if (!fs.existsSync(p)) { warn(`${file} 不存在`); continue }
    try {
      const loc = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (loc.meta?.title && loc.meta?.description) pass(`${file} 结构正确`)
      else fail(`${file} 结构正确`, '需要 meta.title 与 meta.description')
    } catch (err) {
      fail(`${file} 可解析`, err.message)
    }
  }
}

/* ------------------------------------------------------ 5. 工程约束 --- */
section('5. 关键工程约束')
for (const file of ['index.js', 'client.js'].map((f) => path.join(ROOT, f)).filter(fs.existsSync)) {
  const r = rel(file)
  const code = fs.readFileSync(file, 'utf8')
  const staticImport = /(?:^|\n)\s*import\s[^\n]*?from\s*['"]@deepseek-ai\//.test(code)
  const staticRequire = /require\(\s*['"]@deepseek-ai\//.test(code)
  if (staticImport || staticRequire) {
    fail(`${r} 没有静态引入 @deepseek-ai/*`, 'profile 里解析不到这些包，会加载失败')
  } else {
    pass(`${r} 没有静态引入 @deepseek-ai/*`)
  }
  if (/import\(\s*['"]@deepseek-ai\//.test(code) && !/\.catch\(/.test(code)) {
    warn(`${r} 的动态 import 没有 .catch 兜底`)
  }
}
const hostEntry = path.join(ROOT, 'index.js')
if (fs.existsSync(hostEntry)) {
  const code = fs.readFileSync(hostEntry, 'utf8')
  if (/\bexport\s+(?:const|let|var)\s+Config\b/.test(code)) {
    fail('index.js 不导出 Config', '需要 schemastery，profile 里解析不到')
  } else {
    pass('index.js 不导出 Config')
  }
  if (/\bexport\s+function\s+apply\b/.test(code)) pass('index.js 导出了 apply()')
  else fail('index.js 导出了 apply()')

  // 可选依赖不能裸 import —— 插件常以 link: 装在 profile 之外，
  // 从那里往上找永远找不到 DSH 的 node_modules，会静默地永不注册。
  // 注意先剥注释：上面就有一句写着「不能用裸 import」的说明，不能被它骗过。
  const hostCode = stripJsComments(code)
  const bareDynamic = [...hostCode.matchAll(/import\(\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1])
  if (bareDynamic.length) {
    fail('index.js 不用裸 import() 加载 @deepseek-ai/*',
      `发现 ${bareDynamic.join(', ')} —— 应以候选基点用 createRequire 解析`)
  } else {
    pass('index.js 不用裸 import() 加载 @deepseek-ai/*')
  }
  if (/createRequire/.test(hostCode) && /moduleResolutionBases/.test(hostCode)) {
    pass('index.js 用候选基点解析可选依赖（link 安装也能找到）')
  } else if (/dsh-tools/.test(hostCode)) {
    fail('index.js 用候选基点解析可选依赖', '否则 link 安装时工具永远注册不上')
  }
}

/* --------------------------------------------------- 6. Blender 资产 --- */
section('6. Blender 侧资产完整性')
const blenderDir = path.join(ROOT, 'blender')
for (const file of ['modeling_ops.py', 'preview_render.py', 'modeling_driver.py']) {
  const p = path.join(blenderDir, file)
  if (fs.existsSync(p)) pass(`blender/${file} 存在`, `${(fs.statSync(p).size / 1024).toFixed(1)} KiB`)
  else fail(`blender/${file} 存在`)
}
const addonInit = path.join(blenderDir, 'addon', '__init__.py')
if (fs.existsSync(addonInit)) pass('blender/addon/__init__.py 存在')
else fail('blender/addon/__init__.py 存在')

// addon 必须能被复制成自包含形态：它自己要能找到共享层
if (fs.existsSync(addonInit)) {
  const code = fs.readFileSync(addonInit, 'utf8')
  for (const needle of ['modeling_ops', 'preview_render']) {
    if (code.includes(needle)) pass(`addon 引用了 ${needle}`)
    else fail(`addon 引用了 ${needle}`)
  }
  if (/bpy\.app\.timers\.register/.test(code)) pass('addon 用 bpy.app.timers 做主线程调度')
  else fail('addon 用 bpy.app.timers 做主线程调度', '否则 bpy 操作不在主线程会崩')
  if (/registerProvider|register\(/.test(code) === false) pass('addon 不涉及 DSH 技能接口（职责分离）')
}

// 驱动脚本必须用 utf-8-sig 读请求（Windows 的 BOM 会炸掉 json.load）
const driver = path.join(blenderDir, 'modeling_driver.py')
if (fs.existsSync(driver)) {
  const code = fs.readFileSync(driver, 'utf8')
  if (/utf-8-sig/.test(code)) pass('驱动脚本容忍 UTF-8 BOM')
  else fail('驱动脚本容忍 UTF-8 BOM', 'Windows 上用 utf-8 读带 BOM 的 JSON 会直接失败')
  if (/reset_scene/.test(code)) pass('驱动脚本默认清空场景')
  else fail('驱动脚本默认清空场景', '否则出厂 Cube 会混进模型')
  if (/RESULT_JSON=/.test(code)) pass('驱动脚本输出机器可读结果')
  else fail('驱动脚本输出机器可读结果')
}

// 清空场景绝不能走 read_factory_settings —— 在 GUI 里会把正在工作的 addon 一起卸载
const opsFile = path.join(blenderDir, 'modeling_ops.py')
if (fs.existsSync(opsFile)) {
  const code = stripPythonDocs(fs.readFileSync(opsFile, 'utf8'))
  if (/read_factory_settings\s*\(/.test(code)) {
    fail('modeling_ops.py 不调用 read_factory_settings',
      '它会重建 Blender 状态并卸载正在运行的 addon，表现为「发一条指令后连接就断」')
  } else {
    pass('modeling_ops.py 不调用 read_factory_settings（清场景不会拆掉宿主）')
  }
  if (/def reset_scene/.test(code)) pass('modeling_ops.py 提供 reset_scene()')
  else fail('modeling_ops.py 提供 reset_scene()')
}

// addon 必须在端口被占时能换端口，否则连接可能落到别的程序上
const addonCode = fs.existsSync(addonInit) ? fs.readFileSync(addonInit, 'utf8') : ''
if (addonCode) {
  if (/SO_EXCLUSIVEADDRUSE/.test(addonCode)) pass('addon 在 Windows 上独占绑定端口')
  else warn('addon 未使用 SO_EXCLUSIVEADDRUSE', 'Windows 下两个进程可同时绑同一端口，连接可能落到别人身上')
  if (/_write_discovery|bridge\.json/.test(addonCode)) pass('addon 写出端口发现文件')
  else fail('addon 写出端口发现文件', '插件需要靠它得知实际监听端口')
  if (/tries/.test(addonCode)) pass('addon 支持端口被占时顺延')
  else fail('addon 支持端口被占时顺延', '端口被占用时应当换一个可用的')
}

/* ------------------------------------------------------- 7. 技能 --- */
section('7. 技能结构')
const skillsDir = path.join(ROOT, 'skills')
if (!fs.existsSync(skillsDir)) {
  fail('skills/ 目录存在')
} else {
  const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  pass('skills/ 目录存在', `${dirs.length} 个技能`)
  for (const dir of dirs) {
    const file = path.join(skillsDir, dir.name, 'SKILL.md')
    if (!fs.existsSync(file)) { fail(`skills/${dir.name}/SKILL.md 存在`); continue }
    const text = fs.readFileSync(file, 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!m) { fail(`skills/${dir.name} 有 frontmatter`); continue }
    const meta = {}
    for (const ln of m[1].split(/\r?\n/)) {
      const i = ln.indexOf(':')
      if (i > 0) meta[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
    }
    if (meta.name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name)) pass(`  ${meta.name}: name 合法`)
    else fail(`  ${dir.name}: name 合法`, String(meta.name))
    const dlen = (meta.description || '').length
    if (dlen > 0 && dlen <= 200) pass(`  ${meta.name}: description 长度 ${dlen}（<=200）`)
    else fail(`  ${meta.name}: description 长度合适`, `${dlen} 字符`)
    // SKILL.md 里引用的 references/ 必须真实存在
    for (const ref of text.matchAll(/references\/([a-z0-9-]+\.md)/g)) {
      const p = path.join(skillsDir, dir.name, 'references', ref[1])
      if (fs.existsSync(p)) pass(`  ${meta.name}: references/${ref[1]} 存在`)
      else fail(`  ${meta.name}: references/${ref[1]} 存在`, 'SKILL.md 引用了但文件缺失')
    }
  }
}

/* ------------------------------------------------------------ 8. 卫生 --- */
section('8. 仓库卫生')
const junk = allFiles.map(rel).filter((r) =>
  /(^|\/)(__pycache__|node_modules|runtimes)\//.test(r) || /\.(blend|blend1|pyc)$/.test(r))
if (junk.length) for (const r of junk.slice(0, 10)) fail(`不应提交：${r}`)
else pass('没有构建产物 / 运行环境 / .blend 混进来')
for (const f of ['.gitignore', 'LICENSE', 'README.md', 'README.zh.md']) {
  if (fs.existsSync(path.join(ROOT, f))) pass(`${f} 存在`)
  else warn(`${f} 缺失`)
}

/* ------------------------------------------------------------ 结果 --- */
section('结果')
console.log(`共 ${checks} 项检查，失败 ${failures.length} 项，警告 ${warnings.length} 项`)
if (failures.length) {
  console.log('\n失败：')
  for (const f of failures) console.log(`  · ${f}`)
}
if (warnings.length) {
  console.log('\n警告（不阻塞）：')
  for (const w of warnings) console.log(`  · ${w}`)
}
if (!failures.length) console.log('\n静态自检通过。')
process.exitCode = failures.length ? 1 : 0
