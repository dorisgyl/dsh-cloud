// cf-fs-provider — the upstream `fs` seam, over a Cloudflare container.
//
// The sixth seam in this codebase and the same shape as the other five: the
// abstract base publishes a service whose methods do not exist, and the
// concrete provider must be the only thing registered under `fs`.
//
// What made this one tractable is a fact measured in M2: upstream's FileSystem
// is per-FILE, not per-syscall. `readText`, `writeText`, `editText`, `listDir`
// and `stat` are each one complete operation, so one seam call maps to one
// request to U5 and no finer. The design's worry about syscall-level
// chattiness over a three-hop call chain does not apply.
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

const DEFAULT_CWD = '/workspace'

// Reads are bounded because the whole file crosses the wire and then sits in
// the isolate's memory. Upstream's own read tools window their output well
// below this; the cap is here so a stray `readText` on a database file fails
// with FS_TOO_LARGE instead of taking the Durable Object down.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Pure POSIX normalisation: collapse `.`, `..` and repeated separators, and
 * make relative paths absolute against `cwd`.
 *
 * `resolve()` deliberately does NOT round-trip to the container to realpath the
 * result, even though the seam permits it. Every operation already costs one
 * request, and resolving first would double that for every file the agent
 * touches — twenty files would be forty round trips over a three-hop chain.
 *
 * The cost of not realpathing: two paths that reach the same file through a
 * symlink get two different target keys, which weakens staleness detection
 * between them. It cannot corrupt anything — every mutation re-checks the
 * version inside the container, against the real file — and `contains()` is
 * likewise lexical. That last point is a containment gap, but the container is
 * the confinement boundary here, not any path prefix inside it, which is also
 * why `sandboxMode` reports undefined.
 */
function normalize(path, cwd) {
  const raw = String(path ?? '')
  const absolute = raw.startsWith('/') ? raw : `${cwd}/${raw}`
  const out = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return `/${out.join('/')}`
}

function targetFor(path, cwd) {
  const full = normalize(path, cwd)
  return { targetKey: FsTargetKey(full), displayPath: full }
}

/** Every op answers `{ error: { code, message } }` or a value; never both. */
function unwrap(payload) {
  if (payload?.error) {
    throw new FsError(payload.error.message, payload.error.code)
  }
  return payload
}

export class CfFileSystem extends FileSystem {
  constructor(ctx, config) {
    super(ctx)
    if (!config?.exec) throw new Error('cf-fs-provider requires the EXEC service binding (config.exec)')
    this.exec = config.exec
    this.sandboxId = config.sandboxId ?? 'default'
    this.cwd = config.cwd ?? DEFAULT_CWD
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * `undefined` — this backend does not confine. The container is the boundary,
   * and it confines everything inside it equally; there is no narrower mode
   * this provider could honestly claim to enforce per call.
   */
  get sandboxMode() { return undefined }

  async op(payload, signal) {
    let response
    try {
      response = await this.exec.fetch('http://exec/fs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: this.sandboxId, cwd: this.cwd, payload }),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED', { cause: error })
      throw new FsError(`exec unreachable: ${String(error?.message ?? error)}`, 'FS_IO_ERROR', { cause: error })
    }

    const body = await response.json()
    // U5 reports a container-level failure as ok:false; the op's own typed
    // errors arrive inside result.error and keep upstream's code vocabulary.
    if (!body?.ok) throw new FsError(String(body?.error ?? 'fs op failed'), 'FS_IO_ERROR')
    return unwrap(body.result)
  }

  // --- pure, no I/O -------------------------------------------------------

  async resolve(path, opts) {
    return targetFor(path, opts?.cwd ? normalize(opts.cwd, this.cwd) : this.cwd)
  }

  processPath(target) {
    return String(target.targetKey)
  }

  fileUrl(target) {
    return `file://${String(target.targetKey).split('/').map(encodeURIComponent).join('/')}`
  }

  contains(parent, child) {
    const p = String(parent.targetKey)
    const c = String(child.targetKey)
    if (c === p) return true
    return c.startsWith(p === '/' ? '/' : `${p}/`)
  }

  // --- one request each ---------------------------------------------------

  async stat(target, signal) {
    const { info } = await this.op({ op: 'stat', path: this.processPath(target) }, signal)
    if (!info) return undefined
    return { version: FsVersion(info.version), type: info.type, size: info.size }
  }

  async lstat(path, opts, signal) {
    const full = normalize(path, opts?.cwd ? normalize(opts.cwd, this.cwd) : this.cwd)
    const { info } = await this.op({ op: 'lstat', path: full }, signal)
    if (!info) return undefined
    return { version: FsVersion(info.version), type: info.type, size: info.size }
  }

  async readText(target, signal) {
    const { text } = await this.op(
      { op: 'read', path: this.processPath(target), maxBytes: this.maxBytes },
      signal,
    )
    return text
  }

  /**
   * The whole file is fetched in one request and then yielded in slices.
   *
   * This is not true streaming and does not pretend to be: the memory profile
   * is identical to `readText`, and the `maxBytes` cap is what actually bounds
   * it. Chunking exists so consumers written against the iterable contract work
   * unchanged. Real streaming would need a chunked protocol through U5, which
   * is worth building only once something reads files large enough to need it.
   */
  async streamText(target, signal) {
    const text = await this.readText(target, signal)
    const size = 64 * 1024
    return (function* slices() {
      for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size)
    })()
  }

  async readBytes(target, signal, maxBytes) {
    const { base64 } = await this.op(
      { op: 'readBytes', path: this.processPath(target), maxBytes: Math.min(maxBytes, this.maxBytes) },
      signal,
    )
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  async listDir(target, signal) {
    const { entries } = await this.op({ op: 'list', path: this.processPath(target) }, signal)
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      target: { targetKey: FsTargetKey(entry.path), displayPath: entry.path },
      version: entry.version ? FsVersion(entry.version) : undefined,
      size: entry.size,
    }))
  }

  async writeText(target, content, expected, signal) {
    const result = await this.op({
      op: 'write',
      path: this.processPath(target),
      content: String(content ?? ''),
      expected: expected ?? null,
    }, signal)
    return {
      operation: result.operation,
      version: FsVersion(result.version),
      before: result.before,
      after: result.after,
    }
  }

  async editText(target, edit, expected, signal) {
    const result = await this.op({
      op: 'edit',
      path: this.processPath(target),
      maxBytes: this.maxBytes,
      edit: {
        oldString: String(edit.oldString ?? ''),
        newString: String(edit.newString ?? ''),
        replaceAll: Boolean(edit.replaceAll),
      },
      expected: expected ?? null,
    }, signal)
    return {
      version: FsVersion(result.version),
      before: result.before,
      after: result.after,
    }
  }
}

export default CfFileSystem
