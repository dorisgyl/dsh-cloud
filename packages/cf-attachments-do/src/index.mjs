// cf-attachments-do — the upstream `attachments` seam, over DO SQLite.
//
// The tenth seam, and the last one the web UI needed. It surfaced in the least
// obvious way any of them has: `session.history` failed with
//
//   Invalid input: expected object, received undefined
//
// with an empty path and no clue which layer raised it. The session projection
// registry parses every registered unit's view through its schema, and one unit
// — `imageLimits` — reads `ctx.attachments.imageLimits`, which the abstract base
// declares and does not have. One missing property failed the whole snapshot,
// and the snapshot is on the path of every transcript read.
//
// Design 6.4 wants attachments in R2 with presigned direct upload. This is the
// step before that: images live as rows beside the session log, which is the
// right size for the limits below and needs no second binding to configure.
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export class CfAttachmentsDo extends AttachmentStore {
  constructor(ctx, config) {
    super(ctx)
    this.sql = config?.sql
    if (!this.sql) throw new Error('cf-attachments-do requires the Durable Object SQLite handle (config.sql)')
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attachment (
      id         TEXT PRIMARY KEY,
      mediaType  TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      width      INTEGER NOT NULL,
      height     INTEGER NOT NULL,
      name       TEXT,
      data       BLOB NOT NULL
    )`)

    // Bounded by what a Durable Object should hold, not by what the format
    // allows. A single object's SQLite is the session's own storage; images
    // large enough to matter belong in R2 (design 6.4), and these limits are
    // what the client reads to refuse an oversized paste before sending it.
    this.imageLimits = {
      maxImageBytes: config?.maxImageBytes ?? 5 * 1024 * 1024,
      maxImagesPerMessage: config?.maxImagesPerMessage ?? 8,
      maxMessageImageBytes: config?.maxMessageImageBytes ?? 16 * 1024 * 1024,
      maxImagePixels: config?.maxImagePixels ?? 40_000_000,
      mediaTypes: MEDIA_TYPES,
    }
  }

  async validateImage(input) {
    const data = input?.data
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new Error('attachment: image data must be a non-empty Uint8Array')
    }
    if (!MEDIA_TYPES.includes(input.mediaType)) {
      throw new Error(`attachment: unsupported media type "${input.mediaType}"`)
    }
    if (data.byteLength > this.imageLimits.maxImageBytes) {
      throw new Error(`attachment: image is ${data.byteLength} bytes, limit is ${this.imageLimits.maxImageBytes}`)
    }

    const size = imageSize(data, input.mediaType)
    // Dimensions are not decoration here: the seam's own ref carries them, and
    // the model's vision path bills by pixels. An image whose header will not
    // parse is one we cannot describe, so it is refused rather than stored with
    // a guess.
    if (!size) throw new Error(`attachment: could not read the dimensions of this ${input.mediaType}`)
    if (size.width * size.height > this.imageLimits.maxImagePixels) {
      throw new Error(`attachment: ${size.width}x${size.height} exceeds the pixel limit`)
    }
    return size
  }

  async saveImage(input) {
    const size = await this.validateImage(input)
    const attachmentId = crypto.randomUUID()
    this.sql.exec(
      'INSERT INTO attachment (id, mediaType, bytes, width, height, name, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      attachmentId, input.mediaType, input.data.byteLength, size.width, size.height,
      input.name ?? null, input.data,
    )
    return {
      attachmentId,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: size.width,
      height: size.height,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
  }

  async readImage(ref) {
    const row = this.sql
      .exec('SELECT mediaType, bytes, width, height, name, data FROM attachment WHERE id = ?', String(ref.attachmentId))
      .toArray()[0]
    if (!row) throw new Error(`attachment "${ref.attachmentId}" not found`)
    return {
      ref: {
        attachmentId: ref.attachmentId,
        mediaType: row.mediaType,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
        ...(row.name === null ? {} : { name: row.name }),
      },
      data: new Uint8Array(row.data),
    }
  }
}

/**
 * Read width and height out of the file header.
 *
 * There is no image decoder on workerd and none is wanted: every one of these
 * four formats states its dimensions in the first few bytes, so this reads them
 * and never touches pixel data. Returns undefined when the header is not the
 * format it claims to be, which the caller treats as a refusal.
 */
function imageSize(bytes, mediaType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (mediaType) {
    case 'image/png': return pngSize(bytes, view)
    case 'image/gif': return gifSize(bytes, view)
    case 'image/jpeg': return jpegSize(view)
    case 'image/webp': return webpSize(bytes, view)
    default: return undefined
  }
}

function pngSize(bytes, view) {
  // 8-byte signature, then a length + "IHDR", then width and height.
  if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47) return undefined
  if (view.getUint32(12) !== 0x49484452) return undefined
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function gifSize(bytes, view) {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
}

function jpegSize(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined
  let at = 2
  while (at + 9 < view.byteLength) {
    if (view.getUint8(at) !== 0xff) { at++; continue }
    const marker = view.getUint8(at + 1)
    // SOF0..SOF15 carry the frame header; DHT/JPG/DAC share the range and do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue }
    at += 2 + view.getUint16(at + 2)
  }
  return undefined
}

function webpSize(bytes, view) {
  if (bytes.length < 30 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return undefined
  const chunk = view.getUint32(12)
  if (chunk === 0x56503820) {
    // Lossy: a 3-byte start code, then 14-bit width and height.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (chunk === 0x5650384c) {
    // Lossless: 14 bits each, packed across four bytes after the signature.
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 0x38585650) {
    // Extended: 24-bit canvas size, stored minus one.
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)
    return { width: width + 1, height: height + 1 }
  }
  return undefined
}

export default CfAttachmentsDo
