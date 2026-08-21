// Check the cf-* providers against the shapes upstream validates them with.
//
// This exists because of one failure that has now arrived twice, the same way
// both times: a provider satisfies the abstract base class — every abstract
// method implemented, the plugin loads, the boot report is clean — and then a
// read fails somewhere else entirely, because a PROPERTY the base only declares
// is missing and something downstream parses it through a schema.
//
// The first time it was `imageLimits` existing at all, and `session.history`
// answered "Invalid input: expected object, received undefined" with an empty
// path. The second was upstream 0.1.0-rc.8 adding `maxImageDimension` to that
// same object, which no compiler here would catch and no boot report would
// show: the tree loads clean and every transcript read fails.
//
// So the field list is not written down here. It is read out of the installed
// upstream package at check time, which is the only version of it that cannot
// drift — bump the pin, run this, and a new required field shows up as a
// failure rather than as a 500 in production.
//
//   node scripts/check-seam-shapes.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../units/session-do/package.json', import.meta.url))

/** Import a package by name, resolved from the workspace that installs it. */
async function load(name) {
  return import(pathToFileURL(require.resolve(name)).href)
}

/**
 * The installed copy of an upstream package file.
 *
 * Resolved through the workspace rather than by reading `node_modules/.pnpm`:
 * pnpm truncates long directory names and appends a peer hash, and one package
 * has several such directories when its peers resolve more than one way. The
 * resolver picks the copy this workspace actually imports, which is the copy
 * whose schemas are the ones running.
 */
function upstreamSource(pkg, file) {
  const manifest = require.resolve(`${pkg}/package.json`)
  return readFileSync(new URL(file, pathToFileURL(manifest)), 'utf8')
}

/**
 * The field names of one zod object literal in compiled upstream source.
 *
 * Reading the source rather than the schema object because these schemas are
 * package-internal — upstream never exported the one that matters — and a
 * regex over a generated bundle is honest about being a regex, where a
 * hand-copied field list would quietly claim to be current.
 */
function zodObjectFields(source, binding) {
  const block = new RegExp(`${binding} = z\\$?\\d*\\.object\\(\\{([\\s\\S]*?)\\n\\}\\)`).exec(source)
  if (!block) throw new Error(`could not find ${binding} in the installed upstream source`)
  return [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
}

const checks = []

// ---------------------------------------------------------------- attachments
{
  const source = upstreamSource('@deepseek-ai/dsh-host-apiproxy', 'lib/index.js')
  const required = zodObjectFields(source, 'imageLimitsProjectionSchema')

  const { Context } = await load('@deepseek-ai/cordis')
  const { CfAttachmentsDo } = await import(
    new URL('../packages/cf-attachments-do/src/index.mjs', import.meta.url).href
  )
  // The constructor only needs a handle it can run DDL against.
  const sql = { exec: () => ({ toArray: () => [] }) }
  const limits = new CfAttachmentsDo(new Context(), { sql }).imageLimits

  checks.push({
    what: 'cf-attachments-do imageLimits vs imageLimitsProjectionSchema',
    required,
    actual: limits,
  })
}

let failures = 0
for (const check of checks) {
  console.log(`\n${check.what}`)
  for (const field of check.required) {
    const value = check.actual[field]
    if (value === undefined) { failures++; console.log(`  MISSING  ${field}`) }
    else console.log(`  ok       ${field} = ${JSON.stringify(value)}`)
  }
  const extra = Object.keys(check.actual).filter((k) => !check.required.includes(k))
  // Extra properties are not a failure: upstream's schemas are not strict, and
  // a provider may carry its own state. They are printed because an extra whose
  // name is nearly a required one is how a typo hides.
  if (extra.length) console.log(`  (extra, not validated: ${extra.join(', ')})`)
}

console.log(failures === 0
  ? `\nOK - ${checks.length} shape(s) match the installed upstream schemas`
  : `\nFAILED - ${failures} required field(s) missing`)
process.exit(failures === 0 ? 0 : 1)
