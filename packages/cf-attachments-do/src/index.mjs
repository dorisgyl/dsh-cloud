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
import { AttachmentStore, AttachmentError } from '@deepseek-ai/dsh-attachment'

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
      // Per SIDE, not per image, and required since upstream 0.1.0-rc.8.
      //
      // Required is the operative word: the `imageLimits` projection unit is
      // validated host-side against a zod object that lists every field, so a
      // provider omitting one fails the whole session snapshot — the same
      // single-property failure recorded at the top of this file, arriving the
      // same way. 2000 matches `dsh-attachment-local`'s default, which is what
      // the composer's client-side pre-check is written against.
      //
      // It binds well before `maxImagePixels` does (2000x2000 is 4 MP against a
      // 40 MP cap); the pixel limit stays as the guard for a wide-and-short
      // raster that slips under the per-side bound.
      maxImageDimension: config?.maxImageDimension ?? 2000,
      mediaTypes: MEDIA_TYPES,
    }
  }

  /**
   * Refuse an image the deployment will not store, with a code the caller can act on.
   *
   * Every refusal here is an `AttachmentError` carrying one of upstream's
   * `ImageAdmissionErrorCode`s, and that is a behaviour, not a formality:
   * `isImageAdmissionError()` is how the RPC boundary decides whether a failure
   * is the user's to fix ("that image is too wide") or the deployment's ("the
   * store is broken"). A bare `Error` is not in the set, so every refusal this
   * file used to raise was routed as a storage fault and shown as one.
   */
  async validateImage(input) {
    const limits = this.imageLimits
    const data = input?.data
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
    }
    if (!MEDIA_TYPES.includes(input.mediaType)) {
      throw new AttachmentError(
        `Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
    }
    if (data.byteLength > limits.maxImageBytes) {
      throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }

    // Sniff the container before trusting the declared type. Upstream decodes
    // with sharp and compares what came out; there is no decoder here, but the
    // four accepted formats each announce themselves in their first bytes, so
    // the same two failures stay distinguishable: bytes that are some OTHER
    // supported format are mislabelled, bytes that are no format at all are
    // malformed. Collapsing both into one code would tell a user to convert a
    // file that is already fine and merely misnamed.
    const detected = detectMediaType(data)
    if (!detected) throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    if (detected !== input.mediaType) {
      throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
    }

    const size = imageSize(data, detected)
    // Dimensions are not decoration here: the seam's own ref carries them, and
    // the model's vision path bills by pixels. An image whose header will not
    // parse is one we cannot describe, so it is refused rather than stored with
    // a guess.
    if (!size) throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
    if (size.width * size.height > limits.maxImagePixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (Math.max(size.width, size.height) > limits.maxImageDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
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
    if (!ref?.attachmentId) {
      throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
    }
    const row = this.sql
      .exec('SELECT mediaType, bytes, width, height, name, data FROM attachment WHERE id = ?', String(ref.attachmentId))
      .toArray()[0]
    if (!row) throw new AttachmentError('Attachment not found.', 'ATTACHMENT_NOT_FOUND')
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
 * Identify the container from its first bytes, ignoring what the caller claimed.
 *
 * Only the four accepted formats are recognised; anything else is undefined,
 * which the caller reports as malformed rather than as an unsupported type —
 * "unsupported" is reserved for a media type the deployment declined, and a
 * caller cannot fix a declined type by declaring a different one.
 */
function detectMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
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
