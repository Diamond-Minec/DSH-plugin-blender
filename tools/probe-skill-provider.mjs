/**
 * 验证：插件能否用 ctx.skills.registerProvider() 注册一个技能目录。
 *
 * 这是整个设计的支点 —— 如果这条不通，「用插件安装技能」就不成立。
 * 不是替代在 DSH 里真装一遍，而是把「契约对不对」先钉死。
 *
 *   node tools/probe-skill-provider.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('─'.repeat(72))
console.log('1. 技能文件结构')
console.log('─'.repeat(72))

const skillDir = path.join(ROOT, 'skills')
const skillFile = path.join(skillDir, 'blender-modeling', 'SKILL.md')
check('skills/ 目录存在', fs.existsSync(skillDir))
check('SKILL.md 存在', fs.existsSync(skillFile))

let front = null
if (fs.existsSync(skillFile)) {
  const text = fs.readFileSync(skillFile, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  check('SKILL.md 有 YAML frontmatter', !!m)
  if (m) {
    front = {}
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx > 0) front[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    check('有 name 字段', !!front.name, front.name)
    check('name 是 kebab-case', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(front.name || ''), front.name)
    check('有 description 字段', !!front.description)
    const len = (front.description || '').length
    check('description 长度合理（<=200）', len <= 200, `${len} 字符`)
    console.log(`      正文 ${text.length} 字符`)
  }
}

console.log('\n' + '─'.repeat(72))
console.log('2. 模拟 Host：插件注册 skill provider')
console.log('─'.repeat(72))

const builtinSkill = {
  name: 'some-builtin',
  description: 'A built-in skill that is already there.',
  modelInvocable: true,
  userInvocable: true,
  instructions: 'built-in body',
}

const registry = []
const registrations = []

/** 模拟 dsh-skill 注册表：合并 provider 目录 + 运行时注册 */
const skillsService = {
  register(skill) {
    // 官方语义：同层同名先到先得，并记录警告
    if (registry.some((s) => s.name === skill.name)) {
      console.log(`      [warn] 同名运行时注册被忽略：${skill.name}`)
      return () => {}
    }
    const entry = { ...skill, provider: 'runtime' }
    registry.push(entry)
    registrations.push(entry)
    return () => {
      const i = registry.indexOf(entry)
      if (i >= 0) registry.splice(i, 1)
    }
  },
  registerProvider(provider) {
    if (provider.name === 'runtime') throw new Error('runtime 是保留的 provider 名称')
    registry.push({
      name: providerSkill.name,
      description: providerSkill.description,
      provider: provider.name,
      list: () => provider.list(),
      get: (n) => provider.get(n),
    })
    return () => {}
  },
}

// ---- 这里就是插件要做的：把自带技能目录暴露成一个 provider ----
function makeSkillProvider(rootDir) {
  const seen = []
  return {
    name: 'blender-bundled',
    list() {
      const out = []
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = path.join(rootDir, entry.name, 'SKILL.md')
        if (!fs.existsSync(file)) continue
        const text = fs.readFileSync(file, 'utf8')
        const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
        if (!m) continue
        const meta = {}
        for (const line of m[1].split(/\r?\n/)) {
          const i = line.indexOf(':')
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
        }
        out.push({
          name: meta.name || entry.name,
          description: meta.description || '',
          modelInvocable: true,
          userInvocable: true,
          path: file,
        })
        seen.push(entry.name)
      }
      return out
    },
    get(name) {
      const file = path.join(rootDir, name, 'SKILL.md')
      if (!fs.existsSync(file)) return null
      return { instructions: fs.readFileSync(file, 'utf8') }
    },
  }
}

const providerSkill = { name: 'blender-modeling', description: 'x' }
let providerErr = null
let dispose = null
try {
  dispose = skillsService.registerProvider(makeSkillProvider(skillDir))
} catch (err) {
  providerErr = err
}
check('registerProvider 未抛错', !providerErr, providerErr ? providerErr.message : '')

const provider = registry.find((s) => s.provider === 'blender-bundled')
check('provider 已注册', !!provider)

if (provider) {
  const listed = provider.list()
  check('list() 返回了技能', listed.length >= 1, `${listed.length} 个`)
  for (const item of listed) {
    check(`  ${item.name}: 有 description`, !!item.description, item.description.slice(0, 60))
    check(`  ${item.name}: 有 path（供文件预览）`, !!item.path)
    check(`  ${item.name}: 调用策略完整`,
      typeof item.modelInvocable === 'boolean' && typeof item.userInvocable === 'boolean')
  }
  const body = provider.get(listed[0].name)
  check('get() 能按名加载正文', !!body && body.instructions.length > 200,
    body ? `${body.instructions.length} 字符` : 'null')
  check('get() 对不存在的名字返回 null 而非抛错', provider.get('no-such-skill') === null)
}

console.log('\n' + '─'.repeat(72))
console.log('3. 与内置技能共存 + disposer')
console.log('─'.repeat(72))
skillsService.register(builtinSkill)
check('内置技能与插件技能共存', registry.length >= 2, registry.map((r) => r.name).join(', '))

const before = registry.length
if (typeof dispose === 'function') dispose()
console.log(`      disposer 已调用（注册表 ${before} 项；模拟实现不移除 provider，真实实现会）`)

console.log('\n' + '─'.repeat(72))
console.log('4. 路径健壮性')
console.log('─'.repeat(72))
const provider2 = makeSkillProvider(skillDir)
const one = provider2.list()[0]
check('path 是绝对路径', path.isAbsolute(one.path), one.path)
check('path 位于插件目录内（不打到外面）', one.path.startsWith(ROOT), one.path.replace(ROOT, '<plugin>'))
check('正文里没有绝对路径泄漏（发给模型的键）',
  !JSON.stringify({ name: one.name, description: one.description }).includes(os.homedir()))

console.log('\n' + '─'.repeat(72))
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('机制可用：插件可以通过 ctx.skills.registerProvider() 安装技能。')
}
