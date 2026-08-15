// M0: 扫描 U2 包在**模块顶层**(非函数体内)调用 workerd 禁止的操作。
// workerd 禁止全局作用域内: 异步 I/O(fetch/connect)、设定时器(setTimeout/setInterval)、
// 生成随机数(randomUUID/getRandomValues/Math.random)。Node 无此限制,上游随手就写。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = './units/session-do/node_modules/@deepseek-ai'
const BANNED = /\b(randomUUID|getRandomValues|randomBytes|Math\.random|setTimeout|setInterval|fetch)\s*\(/

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

// 粗略的顶层判定:统计到该行为止未闭合的花括号深度,深度 0 即模块顶层。
function topLevelHits(src) {
  const hits = []
  let depth = 0
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`]).*?\1/g, '""')
    if (depth === 0 && BANNED.test(code)) hits.push({ line: i + 1, text: line.trim().slice(0, 110) })
    for (const ch of code) { if (ch === '{' || ch === '(') depth++; else if (ch === '}' || ch === ')') depth-- }
    if (depth < 0) depth = 0
  }
  return hits
}

const results = []
for (const pkg of readdirSync(ROOT)) {
  const dir = join(ROOT, pkg)
  if (!statSync(dir).isDirectory()) continue
  let files = []; try { files = walk(dir) } catch { continue }
  for (const f of files) {
    const hits = topLevelHits(readFileSync(f, 'utf8'))
    if (hits.length) results.push({ pkg, file: relative(dir, f), hits })
  }
}

if (!results.length) console.log('未发现模块顶层的禁止操作。')
for (const r of results) {
  console.log(`\n[${r.pkg}] ${r.file}`)
  for (const h of r.hits) console.log(`   L${h.line}: ${h.text}`)
}
console.log(`\n命中文件数: ${results.length}  涉及包: ${[...new Set(results.map(r => r.pkg))].length}`)
