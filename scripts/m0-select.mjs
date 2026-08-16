// M0: pick the upstream packages U2 (SessionAgentDO) installs for the M1 minimal tier.
// Input:  the full upstream closure (closure JSON produced by crawling @deepseek-ai/dsh)
// Output: the `dependencies` map for units/session-do/package.json
import { readFileSync, writeFileSync } from 'node:fs'

const closure = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const short = (n) => n.replace('@deepseek-ai/', '')

// What U2 does NOT install. Every entry carries its reason — the reason is a
// section of the design doc, or an M0 measurement.
const EXCLUDE = [
  [/^dsh-client/, 'frontend package; ships in U1 browser bundle'],
  // `^dsh-host-` was too broad in exactly the way `^dsh-sandbox` was. Design 5.4
  // marks `host/apiproxy` as **referenced**, not rewritten -- and it turns out to
  // be the whole client protocol (5648 lines) behind a `toFetchHandler(api)` that
  // takes a Request and returns a Response. It touches no node:http and no
  // webserver service. Excluding it meant planning to rewrite the one host
  // package that was already the right shape for a Worker.
  //
  // dsh-host-directory-picker is the `directoryPicker` seam apiproxy injects; its
  // three local providers (-native/-browse/-auto) stay out.
  // dsh-host-plugin-inventory is IN now that `loader` exists: 118 lines, zero
  // Node builtins, and it is what the settings panel's plugin section calls.
  [/^dsh-host-webserver$|^dsh-host-frontend-static$|^dsh-host-directory-picker-/, 'design 5.4: host transport surface is ours (webserver/frontend-static/local pickers)'],
  [/^dsh$|^dsh-cmdline$|^dsh-app-boot$/, 'design 5.5: CLI and boot, replaced by cf-boot'],
  [/^dsh-cordis-host-runner$/, 'design 5.5: node:vm plugin host; workerd ships vm as a non-functional stub'],
  [/^dsh-workflow-worker-thread$|^dsh-code-runtime/, 'vm + worker_threads'],
  // The `sessionQuery` SEAM is now in: dsh-host-apiproxy injects it, so the
  // client protocol does not load without it. Only the sqlite provider stays
  // out (node:sqlite is a non-functional stub on workerd); cf-session-query-do
  // searches the Durable Object's own log instead.
  [/^dsh-session-query-/, 'design 5.3: the sqlite provider pulls node:sqlite; the seam itself is required by host-apiproxy'],
  // The execution world's PROVIDERS are ours (cf-exec-provider over U5), but
  // the seams and the tools that use them are upstream's and must be installed.
  // `^dsh-sandbox` used to be the pattern here and it was too broad: it caught
  // dsh-sandbox-policy, which is pure policy arithmetic (which mode, which
  // workspace root) with no OS enforcement in it at all. dsh-terminal-bash
  // injects `sandboxPolicy`, so the over-broad rule would have made the whole
  // terminal stack unloadable for a reason that was never about the terminal.
  [/^dsh-bash-local$|^dsh-bash-sandbox$|^dsh-pwsh|^dsh-fs-local$|^dsh-fs-sandbox$|^dsh-sandbox-local$|^dsh-sandbox-windows-acl$|^dsh-sandbox$|^dsh-subprocess-local$|landlock|native-command|^dsh-terminal-local$/, 'design 5.2: local/OS-bound execution providers, replaced by cf-exec-provider'],
  [/^dsh-storage-json$|^dsh-settings-file$|^dsh-credentials-local$|^dsh-spill-local$|^dsh-attachment-local$|^dsh-session-persistence-jsonl$/, 'design 5.3/5.5: local providers replaced by cf-* (the seams are still referenced)'],
  // dsh-jobs-local is NOT excluded: the M0 scan puts it among the 122 packages
  // with zero Node builtins, and dsh-jobs is an abstract seam that refuses to
  // start without an implementation. "local" here means in-process, not on-disk.
  [/^dsh-agent-presets$/, 'needs the `loader` service (cordis-plugin-loader), which a statically expanded tree does not use. Nothing injects what it provides'],
  [/^dsh-session-reference$/, 'needs `sessionQuery`, which is out of scope (design 5.3). Nothing injects what it provides'],
  [/hmr/, 'hot reload; not needed in production'],
  [/^dsh-typert-loader$/, 'resolves typert contracts from disk at runtime; we reference them statically'],
  [/^dsh-home-paths$|^dsh-atomic-write$|^dsh-anonymous-user-id$|^dsh-launch-environment$/, 'host-machine paths and identity; no cloud equivalent'],
  [/^dsh-skill-filesystem$|^dsh-skill-badge$/, 'skills read from disk; not in the minimal tier'],
  // cordis-plugin-loader is IN: 744 lines, one Node builtin, and it is the seam
  // that dsh-agent-presets and the plugin inventory hang off. cf-loader points
  // its `internal.import` at the statically expanded map, so plugin rows
  // resolve from the bundle instead of from disk -- runtime composition
  // without runtime code.
  [/^cordis-plugin-include$/, 'reads composition documents from disk; the roster is expanded at build time instead'],
  [/^dsh-web-app$|^dsh-web-frontend$/, 'design 5.4: frontend hosting; U1 uses Workers Static Assets'],
  [/^dsh-headless$/, 'local headless mode'],
  // dsh-tool-bash is installed: it is the standard tier's reason to exist.
  // bash-persistent needs background processes, which cf-exec-provider does not
  // implement yet, so it stays out rather than failing at the first long command.
  // dsh-tool-bash-persistent is installed: cf-exec-provider/subprocess fills the
  // `subprocess` seam, which is what dsh-terminal-bash needs to give it a PTY.
  [/^dsh-tool-pwsh|^dsh-tool-ralph|^dsh-tool-cordis|^dsh-tool-workflow/, 'needs an OS shell or a plugin host we do not provide'],
  // dsh-tool-fs is installed: cf-exec-provider/fs now fills the `fs` seam.
  [/^dsh-tool-fs-search$|^dsh-tool-str-replace-editor$/, 'not published upstream at this version'],
  [/^dsh-persona$/, 'not installed yet; M1 uses the default'],

  // --- The following were discovered by M0 measurement; the design doc's
  //     section 5 has no awareness of them because it works at package-GROUP
  //     level and these do not correspond to any group. ---
  [/^dsh-base$/, 'M0: hard-depends on 76 packages, including the whole execution world, session-query-sqlite (node:sqlite), workflow-worker-thread (vm/worker_threads) and every local provider. It is a batteries-included local dsh bundle, not a kernel'],
  [/^dsh-llm-pi-ai$/, 'M0: -> pi-ai -> @google/genai -> @modelcontextprotocol/sdk -> cross-spawn -> child_process. @google/genai alone is 688 KB'],
  [/^dsh-mcp-client$/, 'M0: -> @modelcontextprotocol/sdk -> cross-spawn -> child_process (MCP stdio transport). MCP over HTTP needs a different transport'],
  [/^dsh-session-telemetry-otel$/, 'M0: OTel semantic-conventions costs 336 KB for no M1 benefit'],
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

console.log(`U2 installs ${kept.length}, skips ${dropped.length}`)
const byReason = {}
for (const [n, r] of dropped) (byReason[r] = byReason[r] || []).push(n)
console.log('\n=== Skipped packages, by reason ===')
for (const [r, ns] of Object.entries(byReason)) console.log(`\n[${r}]\n  ${ns.sort().join('  ')}`)
console.log('\n=== Installed in U2 ===')
console.log(kept.map(short).sort().join('  '))
