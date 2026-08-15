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
  [/^dsh-host-/, 'design 5.4: host transport surface is ours (webserver/frontend-static/directory-picker/apiproxy/plugin-inventory)'],
  [/^dsh$|^dsh-cmdline$|^dsh-app-boot$/, 'design 5.5: CLI and boot, replaced by cf-boot'],
  [/^dsh-cordis-host-runner$/, 'design 5.5: node:vm plugin host; workerd ships vm as a non-functional stub'],
  [/^dsh-workflow-worker-thread$|^dsh-code-runtime/, 'vm + worker_threads'],
  [/^dsh-session-query/, 'design 5.3: cross-session search is out of scope; the sqlite variant also pulls node:sqlite'],
  [/bash|pwsh|terminal|subprocess|sandbox|^dsh-fs-local|^dsh-fs-sandbox|landlock|native-command/, 'design 5.2: execution world; not installed in the minimal tier'],
  [/^dsh-storage-json$|^dsh-settings-file$|^dsh-credentials-local$|^dsh-spill-local$|^dsh-attachment-local$|^dsh-session-persistence-jsonl$|^dsh-jobs-local$/, 'design 5.3/5.5: local providers replaced by cf-* (the seams are still referenced)'],
  [/hmr/, 'hot reload; not needed in production'],
  [/^dsh-typert-loader$/, 'resolves typert contracts from disk at runtime; we reference them statically'],
  [/^dsh-home-paths$|^dsh-atomic-write$|^dsh-anonymous-user-id$|^dsh-launch-environment$/, 'host-machine paths and identity; no cloud equivalent'],
  [/^dsh-skill-filesystem$|^dsh-skill-badge$/, 'skills read from disk; not in the minimal tier'],
  [/^cordis-plugin-include$|^cordis-plugin-loader$/, 'resolve the plugin tree from files; design 10.6 makes it static'],
  [/^dsh-web-app$|^dsh-web-frontend$/, 'design 5.4: frontend hosting; U1 uses Workers Static Assets'],
  [/^dsh-headless$/, 'local headless mode'],
  [/^dsh-tool-bash|^dsh-tool-fs|^dsh-tool-pwsh|^dsh-tool-str-replace-editor|^dsh-tool-ralph|^dsh-tool-cordis|^dsh-tool-workflow/, 'tools that need the execution world; not in the minimal tier'],
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
