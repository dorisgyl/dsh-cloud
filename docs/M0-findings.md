# M0 打包门禁 — 实测结论

**日期**:2026-08-15
**基线**:上游 `@deepseek-ai/*` @ `0.1.0-rc.6`(npm `next`;`latest` 仍是远古的 `0.0.1-rc.1`)
**工具**:Node 22.17 / pnpm 10.30.2 / esbuild 0.25.10 / wrangler 4.123.0 / workerd 1.20260811.1

## 结论:通过

88 个上游包在**真实 workerd**(`wrangler dev --local`)中全部 import 成功,`HTTP 200`。

| 指标 | 值 |
|---|---|
| 上游全量闭包(从 `@deepseek-ai/dsh` 爬) | **195** 个包 |
| U2 装的(M1 最小档) | **88** 个包 |
| 打包产物(未压缩) | 2,037 KB |
| wrangler 上传体积 | 2,175 KiB / **gzip 461 KiB** |
| 残留 `node:` 内建 | **9 个,全部被 workerd 覆盖** |
| 可达的 stub 级内建 | **0** |

残留内建:`crypto` `path` `fs` `util` `os` `url` `async_hooks` `timers` `buffer`。
**`vm` / `child_process` / `worker_threads` / `sqlite` 一个都没有。**

体积对 128 MB 隔离完全不构成压力(§2.7 的结论在完整 U2 规模上成立)。

---

## 推翻或修正设计的七条

### 1. `fs` 不是阻塞项 —— workerd 有虚拟文件系统

设计 §2.2 把 "`fs` 密集" 列为阻塞项,§10.6 的整节论证前提是"**workerd 无文件系统**"。**这句话是假的。**

Cloudflare 文档:**File system → 🟢 supported**。VFS 结构:

```
/bundle   只读,含 bundle 里的每个模块;可放 config、模板,用 readFileSync 读
/tmp      可写(文件、目录、符号链接),内存态
/dev      null / random / full / zero
```

compatibility date ≥ 2025-09-01 且开 `nodejs_compat` 即默认可用。

**影响**:`cordis.yml` **可以**在运行时从 `/bundle` 读出来,§10.6"降级为构建期输入"的理由需重写。
**但要精确**:能读 yml ≠ 能在运行时加载它点名的插件——那需要 `vm`,而 `vm` 是 stub。所以插件树**仍然**必须静态展开;变的是 `cf-boot` 的职责从"重写 app-boot"缩小为"提供静态 name→module 映射",yml 解析与 patch 层逻辑可以留给上游。

### 2. M0 验收标准本身写错了

设计 §11 写的验收是"打包产物的 Node 内建集合 ⊆ `nodejs_compat` 覆盖集"。

**这是个永远会通过的检查。** workerd 为 `vm` / `child_process` / `worker_threads` / `sqlite` 等都提供了**非功能 stub 模块**——能 import、调用才抛。所以任何东西都"解析得了"。

**正确的判据只有一个:能不能在 workerd 里启动。** 本次三个真实失败没有一个能被打包检查发现(见第 4 条)。

### 3. `dsh-base` 是陷阱,而设计从没看见它

`dsh-base` **硬依赖 76 个包**,把刻意排除的东西全拖回来:整个执行世界(`dsh-tool-bash` / `dsh-fs-local` / `dsh-sandbox-local` / `dsh-subprocess-local`…)、`dsh-session-query-sqlite`(**node:sqlite**)、`dsh-workflow-worker-thread`(**vm + worker_threads**)、全部本地 provider、以及 pi-ai 那条 `child_process` 链。

它不是内核,是**"本地版 dsh 全家桶"**。

| | 含 `dsh-base` | 剔除后 |
|---|---|---|
| 打包 | 7,096 KB | **2,037 KB**(−71%) |
| 裸名内建 | `child_process` | **零** |

设计 §5 按**包组**划分,而 `dsh-base` 不对应任何包组,所以从未被审视。这正是 M0"包组级 → 包级"这一交付物存在的理由。

### 4. 三类只有真跑才暴露的失败

| # | 现象 | 涉及包 | 能被静态发现吗 |
|---|---|---|---|
| a | 模块顶层 `createRequire(import.meta.url)("../package.json")` 读自己版本号;workerd 里 `import.meta.url` 为 `undefined` | `dsh-llm`(**核心**)、`dsh-repeat-tool-reminder`、`dsh-time-context`、`dsh-tmux-context` | 勉强(扫 `createRequire`) |
| b | 模块顶层 `randomUUID()` + fs 生成匿名 id;workerd 禁止全局作用域内生成随机数 | `dsh-anonymous-user-id`,被 `dsh-llm-deepseek`(**核心 provider**)依赖 | 勉强 |
| c | 模块顶层 `new AbortController().signal` | `dsh-api-gateway`(**核心**) | **不能** |

第 c 条最要命:`AbortController` 既不是 Node 内建、也不在任何"危险 API"清单上,但 workerd 把它的构造算作全局作用域内的禁止操作。**没有任何静态规则会列它。**

### 5. `child_process` 来自第三方传递依赖,不是上游 dsh 包

两条链:

```
dsh-mcp-client   → @modelcontextprotocol/sdk → cross-spawn → child_process
dsh-llm-pi-ai    → @earendil-works/pi-ai → @google/genai → @modelcontextprotocol/sdk → cross-spawn
```

§2.7 的风险表猜中了 `mcp`(MCP stdio 传输),但没预见第二条五跳链。而且 `@google/genai` 单独占 **688 KB**。

**逐包扫描 `@deepseek-ai/*` 是不够的——必须扫全部传递依赖。**

### 6. Typert 契约:§2.6 的结论成立

全 harness 195 个包里,只有 **5 个**定义 Typert RPC 服务,而这 5 个**全部**发布了 `./typert`(host 面)+ `./remote`(client 面)双面产物:

`dsh-commands` `dsh-goal` `dsh-message-feedback` `dsh-cordis-host-runner` `dsh-host-plugin-inventory`

数量少反映的是"RPC 用得少",不是"产物缺失"。**§10.3 的成本节省是真的。**

**但**:5 个里有 2 个是本方案要删的包(`dsh-cordis-host-runner` 是 `node:vm` 宿主、`dsh-host-plugin-inventory` 随 ADR-09 删)。删完剩 3 个,对应的两个 client UI 包会调用不存在的 RPC —— 落到 §8.2 的"最小档 UI 降级"。

### 7. LLM provider 只有两个

`dsh-llm-deepseek` 和 `dsh-llm-pi-ai`。**不是"很多 provider"。**

ADR-12 写的"Worker 兼容的 provider 全部引用、运行期选择"需要修正:多 provider 的路径是 `pi-ai`(一个多家聚合 SDK),而 `pi-ai` 正是拖入 `child_process` + 688 KB `@google/genai` 的那条链。要用它必须先把那条链处理掉。

---

## 构建期必需的四类机制(设计里完全没有)

这四样合起来是 `cf-boot` 的**构建侧**职责,原设计只描述了它的运行时职责:

1. **裸名内建打桩** —— 第三方包用不带 `node:` 前缀的 `require('fs')` 等,workerd 解析不了
2. **`node:module` 的 `createRequire` 垫片** —— 只服务"读自己 package.json 取 version",其余用法显式抛错
3. **上游包 alias** —— `dsh-anonymous-user-id` → `cf-identity` 占位。**这不是优化,是必需项**
4. **模块顶层 `new AbortController()` 改写** —— 或用掉 ADR-04 三个 patch 名额之一

实现见 `scripts/m0-bundle.mjs`。

---

## 复现

```bash
node scripts/m0-select.mjs scripts/upstream-closure.json scripts/u2-deps.json  # 选包 + 打印排除理由
pnpm install
node scripts/m0-bundle.mjs                                                      # 打包 + 内建统计
cd units/session-do && npx wrangler dev --port 8799 --local                      # 真实 workerd
curl http://127.0.0.1:8799/    # 期望: 88
```

## 尚未验证(留给 M1)

- `ctx.fs` 缝的粒度(syscall 级还是工具级)—— 决定 §5.2 与 M2 的形状
- 上游 client 在 Node 下的可用性、以及重连到"回合进行中"的会话
- 上游 UI 是按工具注册表渲染还是硬编码面板
- AI Gateway 的 SSE 是否端到端不缓冲 / stored provider keys
- DO input gate 在等待 fetch/RPC 时是否阻止新事件投递
- 这 88 个包能否**实际组装成一棵可运行的 Cordis 插件树**(本次只验证了 import 成功)
