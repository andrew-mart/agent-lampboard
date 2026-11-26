// @ts-check
// Chunked upload of attached images: sends images in bounded parallel requests with byte-level progress, one automatic
// retry on transient network drops, and resume that skips images already saved on the server.
import { isRecord, text } from './narrow.js';

/**
 * @typedef {{ readonly mediaType: string, readonly blob: Blob, readonly uploaded: string | undefined }} UploadItem
 * @typedef {{ ok: true, name: string } | { ok: false, reason: 'aborted' | 'network' | 'refused', message: string }} UploadSingleOutcome
 * @typedef {(item: { readonly mediaType: string, readonly blob: Blob }, onBytes: (loaded: number) => void, signal: AbortSignal) => Promise<UploadSingleOutcome>} UploadSingle
 * @typedef {{ readonly done: number, readonly total: number, readonly loadedBytes: number, readonly totalBytes: number, readonly percent: number }} UploadProgress
 * @typedef {{ ok: true, names: readonly string[] } | { ok: false, reason: 'aborted' | 'network' | 'refused', message: string, done: number, total: number }} UploadBatchOutcome
 */

const defaultConcurrency = 3;
const defaultRetryDelayMs = 600;

/**
 * Uploads attached images in bounded parallel chunks, preserving original order and skipping any item already uploaded.
 * @param {readonly UploadItem[]} items
 * @param {{ upload: UploadSingle, onProgress: (progress: UploadProgress) => void, onUploaded: (index: number, name: string) => void, signal: AbortSignal, concurrency?: number, retryDelayMs?: number }} options
 * @returns {Promise<UploadBatchOutcome>}
 */
export async function uploadImages(items, { upload, onProgress, onUploaded, signal, concurrency = defaultConcurrency, retryDelayMs = defaultRetryDelayMs }) {
  const total = items.length;
  /** @type {(string | undefined)[]} */
  const names = items.map((item) => item.uploaded);
  const sizes = items.map((item) => item.blob.size);
  const loaded = items.map((item) => (item.uploaded === undefined ? 0 : item.blob.size));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  let done = names.filter((name) => name !== undefined).length;

  const emitProgress = () => {
    const loadedBytes = loaded.reduce((sum, value) => sum + value, 0);
    const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : total > 0 ? Math.round((done / total) * 100) : 100;
    onProgress({ done, total, loadedBytes, totalBytes, percent });
  };
  emitProgress();

  /** @type {number[]} */
  const pending = [];
  for (let index = 0; index < total; index++) {
    if (names[index] === undefined) pending.push(index);
  }
  if (pending.length === 0) {
    return { ok: true, names: names.flatMap((name) => (name === undefined ? [] : [name])) };
  }

  const batchController = new AbortController();
  const onOuterAbort = () => batchController.abort();
  if (signal.aborted) batchController.abort();
  else signal.addEventListener('abort', onOuterAbort, { once: true });

  /** @type {{ reason: 'aborted' | 'network' | 'refused', message: string } | undefined} */
  let failed;
  let nextCursor = 0;

  /**
   * @param {number} index
   * @param {UploadItem} item
   * @returns {Promise<UploadSingleOutcome>}
   */
  const uploadWithRetry = async (index, item) => {
    const onBytes = (/** @type {number} */ bytes) => {
      loaded[index] = Math.min(item.blob.size, Math.max(0, bytes));
      emitProgress();
    };
    const first = await upload({ mediaType: item.mediaType, blob: item.blob }, onBytes, batchController.signal);
    if (first.ok || first.reason !== 'network' || batchController.signal.aborted) return first;
    loaded[index] = 0;
    emitProgress();
    if (!(await waitAbortable(retryDelayMs, batchController.signal))) {
      return { ok: false, reason: 'aborted', message: 'Upload cancelled.' };
    }
    return upload({ mediaType: item.mediaType, blob: item.blob }, onBytes, batchController.signal);
  };

  const worker = async () => {
    while (failed === undefined && !batchController.signal.aborted) {
      const index = pending[nextCursor++];
      if (index === undefined) return;
      const item = items[index];
      if (item === undefined) return;
      const outcome = await uploadWithRetry(index, item);
      if (outcome.ok) {
        names[index] = outcome.name;
        loaded[index] = item.blob.size;
        done++;
        onUploaded(index, outcome.name);
        emitProgress();
      } else if (failed === undefined) {
        failed = { reason: signal.aborted ? 'aborted' : outcome.reason, message: signal.aborted ? 'Upload cancelled.' : outcome.message };
        batchController.abort();
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), pending.length) }, () => worker());
    await Promise.all(workers);
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }

  if (failed !== undefined) return { ok: false, reason: failed.reason, message: failed.message, done, total };
  if (signal.aborted) return { ok: false, reason: 'aborted', message: 'Upload cancelled.', done, total };
  return { ok: true, names: names.flatMap((name) => (name === undefined ? [] : [name])) };
}

/**
 * Parses the HTTP response of POST /api/upload.
 * @param {number} status — 0 when the request failed before receiving a status
 * @param {unknown} body — parsed JSON response, if any
 * @returns {UploadSingleOutcome}
 */
export function parseUploadReply(status, body) {
  if (status >= 200 && status < 300 && isRecord(body) && body.ok === true) {
    const name = text(body.name);
    if (name !== undefined) return { ok: true, name };
  }
  if (status >= 400 && status < 500) {
    const message = isRecord(body) ? (text(body.error) ?? text(body.message)) : undefined;
    return { ok: false, reason: 'refused', message: message ?? 'The viewer refused the image.' };
  }
  return { ok: false, reason: 'network', message: 'The viewer server did not answer.' };
}

/**
 * Human-readable status line above the upload progress bar.
 * @param {UploadProgress} progress
 * @returns {string}
 */
export function uploadProgressText(progress) {
  if (progress.total <= 1) return progress.percent > 0 ? `Uploading image — ${progress.percent}%` : 'Uploading image…';
  return `Uploading images: ${progress.done} of ${progress.total} (${progress.percent}%)`;
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>} — false if aborted before the delay finished
 */
function waitAbortable(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
