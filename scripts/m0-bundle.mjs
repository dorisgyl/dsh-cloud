// M0 门禁: 把 U2 的完整插件集当作真实入口静态展开并打包,再统计残留 Node 内建。
// 这与 §2.7 的 spike 不同——那次只打了 7 个内核包的 main 导出。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import * as esbuild from 'esbuild'

const deps = Object.keys(JSON.parse(readFileSync('./scripts/u2-deps.json', 'utf8')))
if (!existsSync('./units/session-do/build')) mkdirSync('./units/session-do/build', { recursive: true })

// 模拟 §10.6 的编译期展开:cordis.yml 里每一行插件都变成静态 import
const entry = [
  '// 自动生成 —— 模拟 cordis.session.yml 的编译期展开',
  ...deps.map((d, i) => `import * as p${i} from ${JSON.stringify(d)}`),
  '',
  `export const plugins = { ${deps.map((d, i) => `${JSON.stringify(d)}: p${i}`).join(', ')} }`,
  'export default { async fetch() { return new Response(String(Object.keys(plugins).length)) } }',
].join('\n')
writeFileSync('./units/session-do/build/entry.generated.js', entry)

const NODE_RE = /from\s*"node:([a-z_/]+)"|require\("node:([a-z_/]+)"\)|import\("node:([a-z_/]+)"\)/g

// 裸名内建(不带 node: 前缀)在 workerd 上无法解析。用插件把它们记下来并打桩,
// 这样既能拿到"完整可达面",也正是真实构建里要用的缓解手段。
const BARE = ['assert','async_hooks','buffer','child_process','cluster','constants','crypto',
  'dgram','dns','domain','events','fs','http','http2','https','inspector','module','net','os',
  'path','perf_hooks','process','punycode','querystring','readline','repl','stream',
  'string_decoder','timers','tls','tty','url','util','v8','vm','worker_threads','zlib']
const bareHits = new Map()   // builtin -> Set(importer)

const stubPlugin = {
  name: 'record-and-stub-bare-builtins',
  setup(build) {
    const filter = new RegExp(`^(${BARE.join('|')})(/.*)?$`)
    build.onResolve({ filter }, (args) => {
      const mod = args.path.split('/')[0]
      if (!bareHits.has(mod)) bareHits.set(mod, new Set())
      bareHits.get(mod).add(args.importer.replace(/^.*node_modules[/\\]/, '').replace(/\\/g, '/'))
      return { path: args.path, namespace: 'bare-builtin' }
    })
    build.onLoad({ filter: /.*/, namespace: 'bare-builtin' }, (args) => ({
      contents: `export default {};\nexport const __stubbed = ${JSON.stringify(args.path)};`,
      loader: 'js',
    }))
  },
}

// M0 实测发现:4 个上游包(dsh-llm / dsh-repeat-tool-reminder / dsh-time-context /
// dsh-tmux-context)在**模块顶层**执行
//     const { version } = createRequire(import.meta.url)("../package.json")
// 来读自己的版本号。workerd 里 import.meta.url 为 undefined,import 阶段即抛。
// 这是静态扫描抓不到、只有真跑才会暴露的一类失败。
const requireShim = {
  name: 'shim-create-require',
  setup(build) {
    build.onResolve({ filter: /^node:module$/ }, () => ({ path: 'node:module', namespace: 'mod-shim' }))
    build.onLoad({ filter: /.*/, namespace: 'mod-shim' }, () => ({
      contents: `
        // 只服务于"读自己的 package.json 取 version"这一种用法。
        // 任何其它用法都应当显式失败,而不是静默返回错的东西。
        export function createRequire() {
          return function req(id) {
            if (typeof id === 'string' && id.endsWith('package.json')) return { version: '0.1.0-rc.6' }
            throw new Error('createRequire shim: unsupported require(' + id + ') in workerd')
          }
        }
        export default { createRequire }
      `,
      loader: 'js',
    }))
  },
}

// M0 实测发现:workerd 禁止在**模块顶层**做 I/O、设定时器、生成随机数(Node 无此限制)。
// dsh-anonymous-user-id 在顶层用 randomUUID + fs 生成/读取匿名用户 id,import 即抛。
// 它被 dsh-llm-deepseek(M1 核心 provider)依赖,不能靠"不装"绕开——必须构建期 alias。
// 这就是 §5.5 里 identity → cf-identity 的替换,M0 证明它是必需项而非可选项。
const ALIASES = {
  '@deepseek-ai/dsh-anonymous-user-id': `
    // cf-identity 的最小占位:身份由 U1 的 JWT claim 给出,不在 U2 里生成也不落盘
    export function getOrCreateAnonymousUserId() { return 'cf-tenant-user' }
    export function readAnonymousUserId() { return 'cf-tenant-user' }
    export function anonymousUserId() { return 'cf-tenant-user' }
    export default { getOrCreateAnonymousUserId, readAnonymousUserId, anonymousUserId }
  `,
}
const aliasPlugin = {
  name: 'upstream-alias',
  setup(build) {
    const filter = new RegExp(`^(${Object.keys(ALIASES).map(k => k.replace(/[/@-]/g, '\\$&')).join('|')})$`)
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'alias' }))
    build.onLoad({ filter: /.*/, namespace: 'alias' }, (args) => ({
      contents: ALIASES[args.path], loader: 'js',
    }))
  },
}

// M0 实测发现(第三类,也是最难预判的一类):
// dsh-api-gateway 在模块顶层执行 `var NEVER_ABORTED_SIGNAL = new AbortController().signal`。
// workerd 把 AbortController 的构造算作全局作用域内的禁止操作,import 阶段即抛。
// 这既不是 Node 内建、也不在任何"危险 API"清单上——**只有真跑 workerd 才会暴露**。
// 生产上的正解是构建期源码变换(如下)或一处 pnpm patch(ADR-04 的 3 个名额之一)。
const NEVER_ABORTED = '({ aborted: false, reason: undefined, onabort: null, ' +
  'addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }, throwIfAborted() {} })'
const rewrites = []
const lazySignal = {
  name: 'defer-module-scope-abortcontroller',
  setup(build) {
    build.onLoad({ filter: /[/\\]@deepseek-ai[/\\][^/\\]+[/\\]lib[/\\].*\.(js|mjs)$/ }, async (args) => {
      const { readFile } = await import('node:fs/promises')
      const src = await readFile(args.path, 'utf8')
      // 只改模块顶层的那种赋值形态,函数体内的 new AbortController() 一律不动
      const out = src.replace(
        /^(\s*(?:var|let|const)\s+\w+\s*=\s*)new AbortController\(\)\.signal/gm,
        (_, head) => head + NEVER_ABORTED
      )
      if (out !== src) rewrites.push(args.path.replace(/^.*@deepseek-ai[/\\]/, ''))
      return { contents: out, loader: 'js' }
    })
  },
}

const result = await esbuild.build({
  entryPoints: ['./units/session-do/build/entry.generated.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
  external: ['node:*'],
  plugins: [stubPlugin, requireShim, aliasPlugin, lazySignal],
  outfile: './units/session-do/build/u2.bundle.js',
  metafile: true,
  logLevel: 'silent',
  logLimit: 0,
})

const out = readFileSync('./units/session-do/build/u2.bundle.js', 'utf8')
const found = new Map()
let m
while ((m = NODE_RE.exec(out))) {
  const mod = (m[1] || m[2] || m[3]).split('/')[0]
  found.set(mod, (found.get(mod) || 0) + 1)
}

// workerd 上真正没有实现的(stub 模块:能 import,调用即抛)
const STUBS = new Set(['child_process', 'worker_threads', 'vm', 'sqlite', 'cluster', 'dgram',
  'domain', 'http2', 'inspector', 'readline', 'repl', 'trace_events', 'tty', 'v8', 'wasi'])

const kb = Math.round(out.length / 1024)
console.log('顶层 AbortController 改写:', rewrites.length ? rewrites.join(', ') : '(无)')
console.log(`入口包数: ${deps.length}`)
console.log(`打包产物: ${kb} KB (未压缩)`)
console.log(`\n=== 残留 node: 内建 (${found.size} 个) ===`)
const rows = [...found].sort((a, b) => b[1] - a[1])
for (const [mod, n] of rows) {
  const bad = STUBS.has(mod)
  console.log(`  ${bad ? '[STUB!]' : '[ ok  ]'} node:${mod.padEnd(18)} ${n} 处引用`)
}
const blockers = rows.filter(([m]) => STUBS.has(m))

console.log(`\n=== 裸名内建引用(workerd 无法解析,必须打桩或 alias) ===`)
const bareRows = [...bareHits].sort((a, b) => b[1].size - a[1].size)
for (const [mod, importers] of bareRows) {
  const bad = STUBS.has(mod)
  console.log(`  ${bad ? '[STUB!]' : '[ ok  ]'} ${mod.padEnd(16)} 来自 ${importers.size} 个模块`)
  for (const imp of [...importers].slice(0, 4)) console.log(`             ← ${imp.slice(0, 92)}`)
  if (importers.size > 4) console.log(`             ← ...另 ${importers.size - 4} 处`)
}
const bareBlockers = bareRows.filter(([m]) => STUBS.has(m)).map(r => r[0])

console.log(`\n门禁: ${blockers.length === 0 && bareBlockers.length === 0
  ? '通过 —— 无 stub 级内建可达'
  : '需处理 —— node: 前缀[' + blockers.map(b => b[0]).join(', ') + '] 裸名[' + bareBlockers.join(', ') + ']'}`)

// 体积最大的上游包
const inputs = Object.entries(result.metafile.outputs['units/session-do/build/u2.bundle.js'].inputs)
  .map(([f, v]) => [f, v.bytesInOutput]).sort((a, b) => b[1] - a[1]).slice(0, 12)
console.log(`\n=== 打包后占比最大的模块 ===`)
for (const [f, b] of inputs) console.log(`  ${(b / 1024).toFixed(1).padStart(8)} KB  ${f.replace(/^node_modules\/\.pnpm\//, '').slice(0, 96)}`)

writeFileSync('./units/session-do/build/m0-report.json', JSON.stringify({
  entryPackages: deps.length, bundleKB: kb,
  builtins: Object.fromEntries(found), blockers: blockers.map(b => b[0]),
}, null, 2))
