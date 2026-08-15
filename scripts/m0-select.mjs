// M0: 从上游全量闭包中筛出 U2(SessionAgentDO)在 M1 范围(最小档)下要装的包。
// 输入: 上游闭包 closure-full.json;输出: units/session-do/package.json 的 dependencies
import { readFileSync, writeFileSync } from 'node:fs'

const closure = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const short = (n) => n.replace('@deepseek-ai/', '')

// U2 不装的东西。每条都要有理由——理由就是设计文档的章节。
const EXCLUDE = [
  [/^dsh-client/, '前端包,走 U1 的浏览器 bundle'],
  [/^dsh-host-/, '§5.4 宿主传输面自研(webserver/frontend-static/directory-picker/apiproxy/plugin-inventory)'],
  [/^dsh$|^dsh-cmdline$|^dsh-app-boot$/, '§5.5 CLI 与 boot,由 cf-boot 取代'],
  [/^dsh-cordis-host-runner$/, '§5.5 node:vm 动态插件宿主,workerd 的 vm 是 stub'],
  [/^dsh-workflow-worker-thread$|^dsh-code-runtime/, 'vm + worker_threads'],
  [/^dsh-session-query/, '§5.3 跨会话检索出范围;sqlite 变体还带 node:sqlite'],
  [/bash|pwsh|terminal|subprocess|sandbox|^dsh-fs-local|^dsh-fs-sandbox|landlock|native-command/, '§5.2 执行世界,最小档不装'],
  [/^dsh-storage-json$|^dsh-settings-file$|^dsh-credentials-local$|^dsh-spill-local$|^dsh-attachment-local$|^dsh-session-persistence-jsonl$|^dsh-jobs-local$/, '§5.3/§5.5 本地 provider,由 cf-* 取代(缝仍引用)'],
  [/hmr/, '热重载,生产不需要'],
  [/^dsh-typert-loader$/, '运行时按文件加载 typert 契约;我们静态引用'],
  [/^dsh-home-paths$|^dsh-atomic-write$|^dsh-anonymous-user-id$|^dsh-launch-environment$/, '本机路径/身份,云端无对应物'],
  [/^dsh-skill-filesystem$|^dsh-skill-badge$/, '技能从磁盘读,最小档不装'],
  [/^cordis-plugin-include$|^cordis-plugin-loader$/, '按文件解析插件树;§10.6 改静态'],
  [/^dsh-web-app$|^dsh-web-frontend$/, '§5.4 前端托管,U1 用 Static Assets'],
  [/^dsh-headless$/, '本地 headless 模式'],
  [/^dsh-tool-bash|^dsh-tool-fs|^dsh-tool-pwsh|^dsh-tool-str-replace-editor|^dsh-tool-ralph|^dsh-tool-cordis|^dsh-tool-workflow/, '依赖执行世界的工具,最小档不装'],
  [/^dsh-persona$/, '暂不装,M1 用默认'],
  // —— 以下三条是 M0 实测发现的,设计文档 §5 里没有 ——
  [/^dsh-base$/, 'M0 发现:它硬依赖 76 个包,含整个执行世界 + session-query-sqlite(node:sqlite) + workflow-worker-thread(vm/worker_threads) + 全部本地 provider。它是"本地版 dsh 全家桶",不是内核'],
  [/^dsh-llm-pi-ai$/, 'M0 发现:→ pi-ai → @google/genai → @modelcontextprotocol/sdk → cross-spawn → child_process。且 @google/genai 单独占 688 KB'],
  [/^dsh-mcp-client$/, 'M0 发现:→ @modelcontextprotocol/sdk → cross-spawn → child_process(MCP stdio 传输)。MCP over HTTP 需另配传输层'],
  [/^dsh-session-telemetry-otel$/, 'M0 发现:OTel semantic-conventions 占 336 KB,M1 无收益'],
]

const all = Object.keys(closure.packages)
const kept = [], dropped = []
for (const full of all) {
  const n = short(full)
  const hit = EXCLUDE.find(([re]) => re.test(n))
  if (hit) dropped.push([n, hit[1]])
  else kept.push(full)
}

const deps = Object.fromEntries(kept.sort().map(n => [n, closure.packages[n].version]))
writeFileSync(process.argv[3], JSON.stringify(deps, null, 2))

console.log(`U2 装 ${kept.length} 个,不装 ${dropped.length} 个`)
const byReason = {}
for (const [n, r] of dropped) (byReason[r] = byReason[r] || []).push(n)
console.log('\n=== 不装的包与理由 ===')
for (const [r, ns] of Object.entries(byReason)) console.log(`\n[${r}]\n  ${ns.sort().join('  ')}`)
console.log('\n=== U2 要装的 ===')
console.log(kept.map(short).sort().join('  '))
