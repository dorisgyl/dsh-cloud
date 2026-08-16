// cf-workspace-picker — the upstream `directoryPicker` seam, over the
// container's filesystem.
//
// Design 8.2 lists the directory picker as one of the five UI changes, on the
// grounds that a cloud deployment has no local directories to pick. That is
// true of the `native` capability — there is no desktop and no file dialog —
// but the seam has a second shape, `browse`, which is a plain list/create pair
// over some filesystem. The container has a filesystem, so the honest answer is
// not "no picker" but "a picker onto the execution world", and the client's
// existing browse UI renders it unchanged.
//
// This is the minimal true version. Design 6.3's workspace registry — several
// named workspaces per tenant, each outliving its session — is a later layer
// that will list workspaces here instead of directories.
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

const HOME = '/workspace'
const MAX_ENTRIES = 500

export class CfWorkspacePicker extends DirectoryPicker {
  constructor(ctx, config) {
    super(ctx)
    if (!config?.exec) throw new Error('cf-workspace-picker requires the EXEC service binding (config.exec)')
    this.exec = config.exec
    this.sandboxId = config.sandboxId ?? 'default'
    this.home = config.home ?? HOME
  }

  capability() {
    return {
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    }
  }

  async op(payload, signal) {
    const response = await this.exec.fetch('http://exec/fs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandboxId: this.sandboxId, cwd: this.home, payload }),
      signal,
    })
    const body = await response.json()
    if (!body?.ok) throw new Error(String(body?.error ?? 'the execution world did not answer'))
    if (body.result?.error) throw new Error(body.result.error.message)
    return body.result
  }

  async list(path, signal) {
    const target = normalize(path || this.home)
    const { entries } = await this.op({ op: 'list', path: target }, signal)

    const directories = entries
      .filter((entry) => entry.type === 'directory')
      .slice(0, MAX_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        hidden: entry.name.startsWith('.'),
      }))

    return {
      path: target,
      home: this.home,
      crumbs: crumbsFor(target),
      entries: directories,
      truncated: entries.filter((e) => e.type === 'directory').length > MAX_ENTRIES,
    }
  }

  async createDirectory(path, name) {
    const full = normalize(`${normalize(path || this.home)}/${name}`)
    await this.op({ op: 'mkdir', path: full })
    return full
  }
}

/** Pure POSIX normalisation; the same rules cf-exec-provider/fs applies. */
function normalize(path) {
  const out = []
  for (const part of String(path ?? '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return `/${out.join('/')}`
}

/** Every ancestor of `path`, root first, for the breadcrumb bar. */
function crumbsFor(path) {
  const crumbs = [{ name: '/', path: '/', hidden: false }]
  let at = ''
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`
    crumbs.push({ name: part, path: at, hidden: part.startsWith('.') })
  }
  return crumbs
}

export default CfWorkspacePicker
