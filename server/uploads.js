// @ts-check
// Images attached to prompts from the page: saved as files that Claude Code opens by path, and shown in the feed.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../public/model/narrow.js';

/**
 * Raster images only: an SVG served from the viewer's own address could run a script in its page.
 * @typedef {'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'} ImageType
 * @typedef {{ mediaType: ImageType, bytes: Buffer }} Image
 */

/** @type {Readonly<Record<ImageType, string>>} */
const extensionOf = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** @type {Readonly<Record<string, ImageType>>} */
const typeOf = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** The names the viewer gives saved images; nothing else is served from the folder. */
const savedName = /^[\w-]+\.(png|jpg|gif|webp)$/;
const uploadIdPattern = /^[a-zA-Z0-9_-]{8,64}$/;
const maxImages = 10;
export const maxUploads = 100;
export const maxImageBytes = 15 * 1024 * 1024;
export const maxChunkBytes = 1024 * 1024;
const stalePartMaxAgeMs = 2 * 60 * 60 * 1000;
const staleSweepIntervalMs = 10 * 60 * 1000;
const maxCompletedRemembered = 500;

/**
 * @param {string | undefined} header — a Content-Type header, optional parameters after ;
 * @returns {ImageType | undefined}
 */
export function parseImageType(header) {
  const bare = header?.split(';')[0]?.trim().toLowerCase();
  return isImageType(bare) ? bare : undefined;
}

/**
 * Parses chunk query parameters (?id=...&offset=...&total=...) on POST /api/upload.
 * When none of the three parameters are present, the request uploads the whole image in one shot.
 * @param {URLSearchParams} params
 * @returns {{ kind: 'whole' } | { kind: 'chunk', id: string, offset: number, total: number } | { kind: 'invalid', error: string } | { kind: 'too-large', error: string }}
 */
export function parseUploadChunk(params) {
  const id = params.get('id');
  const offsetRaw = params.get('offset');
  const totalRaw = params.get('total');
  if (id === null && offsetRaw === null && totalRaw === null) return { kind: 'whole' };
  if (id === null || offsetRaw === null || totalRaw === null) {
    return { kind: 'invalid', error: 'Invalid upload chunk parameters.' };
  }
  if (!uploadIdPattern.test(id)) return { kind: 'invalid', error: 'Invalid upload id.' };
  const offset = parseNonNegativeInt(offsetRaw);
  const total = parseNonNegativeInt(totalRaw);
  if (offset === undefined || total === undefined || total < 1) {
    return { kind: 'invalid', error: 'Invalid upload chunk parameters.' };
  }
  if (total > maxImageBytes) {
    return { kind: 'too-large', error: `An attached image must be under ${maxImageBytes / 1024 / 1024} MB.` };
  }
  if (offset >= total) return { kind: 'invalid', error: 'Invalid upload chunk offset.' };
  return { kind: 'chunk', id, offset, total };
}

/**
 * Uploaded image names referenced by /api/send; every name must match what the viewer itself generates.
 * @param {unknown} value — body.uploads, absent when none were uploaded beforehand
 * @returns {{ ok: true, names: string[] } | { ok: false, error: string }}
 */
export function parseUploadNames(value) {
  if (value === undefined) return { ok: true, names: [] };
  if (!Array.isArray(value) || value.length > maxUploads) return { ok: false, error: `Attach at most ${maxUploads} images at a time.` };
  /** @type {string[]} */
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string' || !savedName.test(item)) return { ok: false, error: 'Invalid uploaded image reference.' };
    names.push(item);
  }
  return { ok: true, names };
}

/**
 * The images of a send request; anything but a short list of base64 raster images refuses the whole request.
 * @param {unknown} value — body.images, absent when nothing is attached
 * @returns {{ ok: true, images: Image[] } | { ok: false, error: string }}
 */
export function parseImages(value) {
  if (value === undefined) return { ok: true, images: [] };
  if (!Array.isArray(value) || value.length > maxImages) return { ok: false, error: `Attach at most ${maxImages} images at a time.` };
  /** @type {Image[]} */
  const images = [];
  for (const item of value) {
    const mediaType = isRecord(item) ? item.mediaType : undefined;
    const data = isRecord(item) ? item.data : undefined;
    if (!isImageType(mediaType) || typeof data !== 'string') return { ok: false, error: 'Only PNG, JPEG, GIF and WebP images can be attached.' };
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > maxImageBytes) return { ok: false, error: `An attached image must be under ${maxImageBytes / 1024 / 1024} MB.` };
    images.push({ mediaType, bytes });
  }
  return { ok: true, images };
}

/**
 * @param {string} dir — ~/.agent-lampboard/uploads
 */
export function createUploads(dir) {
  /** @type {Map<string, Promise<unknown>>} */
  const locks = new Map();
  /** Finalized chunked upload ids remembered so a retried final chunk after a lost ACK returns the saved name. @type {Map<string, { name: string, mediaType: ImageType, total: number }>} */
  const completed = new Map();
  let lastSweepAt = 0;

  /** @param {ImageType} mediaType */
  const newSavedName = (mediaType) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
    return `${stamp}-${randomBytes(4).toString('hex')}.${extensionOf[mediaType]}`;
  };

  /**
   * @template T
   * @param {string} id
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const withLock = (id, task) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tracked = next.finally(() => {
      if (locks.get(id) === tracked) locks.delete(id);
    });
    locks.set(id, tracked);
    return next;
  };

  const sweepStaleParts = async () => {
    const now = Date.now();
    if (now - lastSweepAt < staleSweepIntervalMs) return;
    lastSweepAt = now;
    const entries = await readdir(dir).catch(() => /** @type {string[]} */ ([]));
    for (const entry of entries) {
      if (!entry.startsWith('.part-')) continue;
      const full = join(dir, entry);
      const info = await stat(full).catch(() => undefined);
      if (info !== undefined && info.isFile() && now - info.mtimeMs > stalePartMaxAgeMs) {
        await rm(full, { force: true }).catch(() => undefined);
      }
    }
  };

  /**
   * @param {Image} image
   * @returns {Promise<{ name: string, path: string }>}
   */
  const saveOne = async (image) => {
    await mkdir(dir, { recursive: true });
    const name = newSavedName(image.mediaType);
    const path = join(dir, name);
    await writeFile(path, image.bytes, { flag: 'wx' });
    return { name, path };
  };
  return {
    saveOne,
    /**
     * Appends one sequential byte chunk of an image upload, renaming the hidden partial file into place once complete.
     * @param {{ id: string, mediaType: ImageType, offset: number, total: number, bytes: Buffer }} chunk
     * @returns {Promise<{ ok: true, done: false, received: number } | { ok: true, done: true, name: string } | { ok: false, error: 'offset-mismatch', received: number }>}
     */
    async appendChunk({ id, mediaType, offset, total, bytes }) {
      return withLock(id, async () => {
        const finished = completed.get(id);
        if (finished !== undefined && finished.mediaType === mediaType && finished.total === total) {
          const exists = await stat(join(dir, finished.name)).catch(() => undefined);
          if (exists?.isFile()) return { ok: true, done: true, name: finished.name };
          completed.delete(id);
        }
        await mkdir(dir, { recursive: true });
        if (offset === 0) void sweepStaleParts();
        const partPath = join(dir, `.part-${id}.${extensionOf[mediaType]}`);
        const info = await stat(partPath).catch(() => undefined);
        const currentSize = info?.isFile() ? info.size : 0;
        if (offset === 0) {
          await writeFile(partPath, bytes);
        } else {
          if (currentSize !== offset) return { ok: false, error: 'offset-mismatch', received: currentSize };
          await appendFile(partPath, bytes);
        }
        const received = offset + bytes.length;
        if (received < total) return { ok: true, done: false, received };
        const name = newSavedName(mediaType);
        await rename(partPath, join(dir, name));
        completed.set(id, { name, mediaType, total });
        if (completed.size > maxCompletedRemembered) {
          const oldest = completed.keys().next().value;
          if (oldest !== undefined) completed.delete(oldest);
        }
        return { ok: true, done: true, name };
      });
    },
    /**
     * @param {readonly Image[]} images
     * @returns {Promise<string[]>} — absolute paths of the saved files, in the same order
     */
    async save(images) {
      if (images.length === 0) return [];
      const saved = await Promise.all(images.map(saveOne));
      return saved.map((entry) => entry.path);
    },
    /**
     * Verifies pre-uploaded image names still exist in this folder and returns their paths in the same order.
     * @param {readonly string[]} names
     * @returns {Promise<{ ok: true, paths: string[] } | { ok: false, missing: string[] }>}
     */
    async resolve(names) {
      if (names.length === 0) return { ok: true, paths: [] };
      const checked = await Promise.all(
        names.map(async (name) => {
          if (!savedName.test(name)) return { name, path: undefined };
          const path = join(dir, name);
          const info = await stat(path).catch(() => undefined);
          return { name, path: info?.isFile() ? path : undefined };
        }),
      );
      const missing = checked.flatMap((entry) => (entry.path === undefined ? [entry.name] : []));
      if (missing.length > 0) return { ok: false, missing };
      return { ok: true, paths: checked.flatMap((entry) => (entry.path === undefined ? [] : [entry.path])) };
    },
    /** @param {readonly string[]} paths */
    async remove(paths) {
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    },
    /**
     * @param {string} name — a file name from /api/upload/<name>
     * @returns {Promise<Image | undefined>} — undefined for a name the viewer could not have given, or a missing file
     */
    async read(name) {
      const extension = savedName.exec(name)?.[1];
      const mediaType = extension === undefined ? undefined : typeOf[extension];
      if (mediaType === undefined) return undefined;
      const bytes = await readFile(join(dir, name)).catch(() => undefined);
      return bytes === undefined ? undefined : { mediaType, bytes };
    },
  };
}

/**
 * @param {string} raw
 * @returns {number | undefined}
 */
function parseNonNegativeInt(raw) {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {value is ImageType}
 */
function isImageType(value) {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp';
}
