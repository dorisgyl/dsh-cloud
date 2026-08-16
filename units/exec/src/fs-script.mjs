// The filesystem worker that runs INSIDE the container.
//
// Every fs seam call becomes exactly one `node -e` invocation carrying a
// base64 payload. That shape is deliberate:
//
//   * One round trip per seam call. The seam is per-file (readText, writeText,
//     editText, listDir, stat), not per-syscall, so this is the natural
//     granularity — reading 20 files costs 20 trips, not several hundred.
//
//   * `editText` must be atomic. Upstream keeps it at the seam precisely so
//     "version check, literal match, and rewrite share one critical section".
//     Splitting it into a read and a write from the Worker would let two edits
//     interleave and silently lose one. Here the whole sequence happens in one
//     process in the container.
//
//   * Stateless. No helper process to supervise and no script cached on disk —
//     which matters because a container can be destroyed and recreated under us
//     (see the dead-shell recovery in index.mjs), and cached state would then be
//     silently missing.
//
// Base64 on both sides means neither the script nor the payload ever needs
// shell quoting, so no input can break out of the command.
export const FS_SCRIPT = String.raw`
const fs = require('fs')
const path = require('path')

const payload = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'))
const done = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
const fail = (code, message) => done({ error: { code, message: String(message) } })

// A version must change whenever content changes. mtime in milliseconds plus
// size is cheap and needs no read; the pair is what the staleness guards
// compare, never parse.
const versionOf = (st) => st.mtimeMs + ':' + st.size

const typeOf = (st) => st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other'

const CODES = {
  ENOENT: 'FS_NOT_FOUND',
  ENOTDIR: 'FS_NOT_DIRECTORY',
  EISDIR: 'FS_NOT_REGULAR_FILE',
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
  EFBIG: 'FS_TOO_LARGE',
}
const codeFor = (err) => CODES[err && err.code] || 'FS_IO_ERROR'

/**
 * Decode as UTF-8 and reject anything that is not regular text. A NUL byte or a
 * replacement character means the caller asked for text and the file is not
 * text; returning mojibake would put garbage in front of the model.
 */
function decodeText(buf) {
  if (buf.includes(0)) return null
  const text = buf.toString('utf8')
  if (text.includes('�')) return null
  return text
}

function readFileChecked(target, maxBytes) {
  const st = fs.statSync(target)
  if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' })
  if (maxBytes != null && st.size > maxBytes) {
    throw Object.assign(new Error('file is ' + st.size + ' bytes, limit is ' + maxBytes), { code: 'EFBIG' })
  }
  return { buf: fs.readFileSync(target), st }
}

/**
 * Publish atomically: write a sibling temp file, then rename over the target.
 * A reader either sees the whole old file or the whole new one, never a
 * half-written file — which a crashed or aborted write would otherwise leave.
 */
function writeAtomic(target, content) {
  const tmp = path.join(path.dirname(target), '.dsh-fs-' + process.pid + '-' + path.basename(target))
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch (_) {}
    throw err
  }
  return versionOf(fs.statSync(target))
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let n = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) { n++; at = haystack.indexOf(needle, at + needle.length) }
  return n
}

const ops = {
  realpath: (p) => done({ path: fs.realpathSync(p.path) }),

  stat: (p) => {
    let st
    try { st = fs.statSync(p.path) } catch (err) {
      if (err.code === 'ENOENT') return done({ info: null })
      throw err
    }
    done({ info: { version: versionOf(st), type: typeOf(st), size: st.size } })
  },

  lstat: (p) => {
    let st
    try { st = fs.lstatSync(p.path) } catch (err) {
      if (err.code === 'ENOENT') return done({ info: null })
      throw err
    }
    const type = st.isSymbolicLink() ? 'symlink' : typeOf(st)
    done({ info: { version: versionOf(st), type, size: st.size } })
  },

  read: (p) => {
    const { buf, st } = readFileChecked(p.path, p.maxBytes)
    const text = decodeText(buf)
    if (text === null) return fail('FS_NOT_TEXT', 'file is not valid UTF-8 text')
    done({ text, version: versionOf(st) })
  },

  readBytes: (p) => {
    const { buf, st } = readFileChecked(p.path, p.maxBytes)
    done({ base64: buf.toString('base64'), version: versionOf(st) })
  },

  list: (p) => {
    const entries = fs.readdirSync(p.path, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      const full = path.join(p.path, entry.name)
      let st = null
      // A broken symlink or a file removed mid-listing must not fail the whole
      // listing: report the entry without the metadata we could not get.
      try { st = fs.statSync(full) } catch (_) {}
      out.push({
        name: entry.name,
        path: full,
        type: st ? typeOf(st) : 'other',
        version: st ? versionOf(st) : undefined,
        size: st ? st.size : undefined,
      })
    }
    out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    done({ entries: out })
  },

  write: (p) => {
    let st = null
    try { st = fs.statSync(p.path) } catch (err) { if (err.code !== 'ENOENT') throw err }

    if (p.expected && p.expected.kind === 'createIfAbsent' && st) {
      return fail('FS_STALE_VERSION', 'file already exists')
    }
    if (p.expected && p.expected.kind === 'replaceIfVersion') {
      if (!st) return fail('FS_NOT_FOUND', 'file does not exist')
      if (versionOf(st) !== p.expected.version) {
        return fail('FS_STALE_VERSION', 'file changed since it was read')
      }
    }

    let before = null
    if (st) {
      if (!st.isFile()) return fail('FS_NOT_REGULAR_FILE', 'not a regular file')
      before = decodeText(fs.readFileSync(p.path))
    }
    fs.mkdirSync(path.dirname(p.path), { recursive: true })
    const version = writeAtomic(p.path, p.content)
    done({ operation: st ? 'update' : 'create', version, before, after: p.content })
  },

  // Version check, literal match and rewrite in one process — the reason this
  // op exists at all rather than being composed from read and write.
  edit: (p) => {
    const { buf, st } = readFileChecked(p.path, p.maxBytes)
    if (p.expected && versionOf(st) !== p.expected.version) {
      return fail('FS_STALE_VERSION', 'file changed since it was read')
    }
    const before = decodeText(buf)
    if (before === null) return fail('FS_NOT_TEXT', 'file is not valid UTF-8 text')

    const hits = countOccurrences(before, p.edit.oldString)
    if (hits === 0) return fail('FS_EDIT_NOT_FOUND', 'the literal text to replace was not found')
    if (hits > 1 && !p.edit.replaceAll) {
      return fail('FS_AMBIGUOUS_EDIT', 'the literal text appears ' + hits + ' times; pass replaceAll or give more context')
    }

    const after = p.edit.replaceAll
      ? before.split(p.edit.oldString).join(p.edit.newString)
      : before.replace(p.edit.oldString, p.edit.newString)

    done({ version: writeAtomic(p.path, after), before, after })
  },

  mkdir: (p) => {
    fs.mkdirSync(p.path, { recursive: true })
    done({ ok: true })
  },
}

try {
  const op = ops[payload.op]
  if (!op) fail('FS_IO_ERROR', 'unknown fs op: ' + payload.op)
  else op(payload)
} catch (err) {
  fail(codeFor(err), err && err.message ? err.message : err)
}
`

/** UTF-8 to base64 without Node's Buffer — this half runs on workerd. */
function b64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

const SCRIPT_B64 = b64(FS_SCRIPT)

/**
 * Build the one-shot command. Both the script and the payload travel as base64,
 * so neither needs shell quoting and no path or file content can break out of
 * the command line.
 */
export function fsCommand(payload) {
  return `node -e "eval(Buffer.from('${SCRIPT_B64}','base64').toString())" ${b64(JSON.stringify(payload))}`
}
