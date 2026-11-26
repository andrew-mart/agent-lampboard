// @ts-check
// Sequential byte-chunked upload of attached images: slices larger images into small chunks (default 256 KB) sent one
// at a time with brief pauses between chunks so interactive requests never starve on slow links, automatic per-chunk
// retry and server-offset resync on transient drops, and resume from the exact chunk already persisted on the server.
import { isRecord, text } from './narrow.js';

/**
 * @typedef {{ readonly id: string, readonly offset: number }} PartialUpload
 * @typedef {{ readonly mediaType: string, readonly blob: Blob, readonly uploaded: string | undefined, readonly partial?: PartialUpload | undefined }} UploadItem
 * @typedef {{ readonly id: string, readonly offset: number, readonly total: number }} UploadChunkSpec
 * @typedef {{ readonly mediaType: string, readonly blob: Blob, readonly chunk?: UploadChunkSpec | undefined }} UploadRequest
 * @typedef {
 *   | { ok: true, kind: 'done', name: string }
 *   | { ok: true, kind: 'chunk', received: number }
 *   | { ok: false, reason: 'offset-mismatch', received: number }
 *   | { ok: false, reason: 'aborted' | 'network' | 'refused', message: string }
 * } UploadChunkOutcome
 * @typedef {(request: UploadRequest, onBytes: (loaded: number) => void, signal: AbortSignal) => Promise<UploadChunkOutcome>} UploadSender
 * @typedef {{ readonly done: number, readonly total: number, readonly loadedBytes: number, readonly totalBytes: number, readonly percent: number, readonly bytesPerSec: number | undefined }} UploadProgress
 * @typedef {
 *   | { ok: true, names: readonly string[] }
 *   | { ok: false, reason: 'aborted' | 'network' | 'refused', message: string, done: number, total: number, percent: number }
 * } UploadBatchOutcome
 */

export const defaultChunkBytes = 256 * 1024;
export const defaultStallTimeoutMs = 25_000;
const defaultConcurrency = 1;
const defaultChunkPauseMs = 40;
const defaultRetryDelayMs = 500;
const defaultMaxChunkRetries = 2;
const maxOffsetResyncs = 3;
const speedWindowMs = 5000;
const minSpeedSampleMs = 50;

/**
 * Uploads attached images sequentially in small byte chunks, preserving original order and resuming from already
 * uploaded images or partially uploaded byte offsets.
 * @param {readonly UploadItem[]} items
 * @param {{
 *   upload: UploadSender,
 *   onProgress: (progress: UploadProgress) => void,
 *   onUploaded: (index: number, name: string) => void,
 *   onPartial?: (index: number, partial: PartialUpload | undefined) => void,
 *   signal: AbortSignal,
 *   concurrency?: number,
 *   chunkBytes?: number,
 *   chunkPauseMs?: number,
 *   retryDelayMs?: number,
 *   maxChunkRetries?: number,
 *   now?: () => number,
 * }} options
 * @returns {Promise<UploadBatchOutcome>}
 */
export async function uploadImages(
  items,
  {
    upload,
    onProgress,
    onUploaded,
    onPartial,
    signal,
    concurrency = defaultConcurrency,
    chunkBytes = defaultChunkBytes,
    chunkPauseMs = defaultChunkPauseMs,
    retryDelayMs = defaultRetryDelayMs,
    maxChunkRetries = defaultMaxChunkRetries,
    now = Date.now,
  },
) {
  const total = items.length;
  /** @type {(string | undefined)[]} */
  const names = items.map((item) => item.uploaded);
  const sizes = items.map((item) => item.blob.size);
  const loaded = items.map((item) => {
    if (item.uploaded !== undefined) return item.blob.size;
    if (item.partial !== undefined) return Math.min(item.blob.size, Math.max(0, item.partial.offset));
    return 0;
  });
  // Server-confirmed bytes per image: used for momentary speed so local OS socket buffering does not fake spikes
  const confirmed = [...loaded];
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  let done = names.filter((name) => name !== undefined).length;
  /** @type {Array<{ at: number, bytes: number }>} */
  const speedSamples = [{ at: now(), bytes: confirmed.reduce((sum, value) => sum + value, 0) }];

  const recordConfirmed = () => {
    const t = now();
    const bytes = confirmed.reduce((sum, value) => sum + value, 0);
    const last = speedSamples.at(-1);
    if (last !== undefined && bytes < last.bytes) {
      speedSamples.length = 0;
      speedSamples.push({ at: t, bytes });
      return;
    }
    speedSamples.push({ at: t, bytes });
    const cutoff = t - speedWindowMs;
    while (speedSamples.length > 2) {
      const second = speedSamples[1];
      if (second !== undefined && second.at <= cutoff) speedSamples.shift();
      else break;
    }
  };

  const currentBytesPerSec = () => {
    if (speedSamples.length < 2) return undefined;
    const oldest = speedSamples[0];
    const newest = speedSamples.at(-1);
    if (oldest === undefined || newest === undefined) return undefined;
    const elapsedMs = newest.at - oldest.at;
    const deltaBytes = newest.bytes - oldest.bytes;
    if (elapsedMs < minSpeedSampleMs || deltaBytes <= 0) return undefined;
    return (deltaBytes * 1000) / elapsedMs;
  };

  const snapshot = () => {
    const loadedBytes = loaded.reduce((sum, value) => sum + value, 0);
    const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100)) : total > 0 ? Math.round((done / total) * 100) : 100;
    return { done, total, loadedBytes, totalBytes, percent, bytesPerSec: currentBytesPerSec() };
  };
  const emitProgress = () => onProgress(snapshot());
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
   * Sends one request with automatic retries on transient network/stall errors.
   * @param {number} index
   * @param {number} baseOffset
   * @param {number} imageTotal
   * @param {UploadRequest} request
   * @returns {Promise<UploadChunkOutcome>}
   */
  const sendWithRetries = async (index, baseOffset, imageTotal, request) => {
    const onBytes = (/** @type {number} */ sliceLoaded) => {
      const clamped = Math.min(request.blob.size, Math.max(0, sliceLoaded));
      loaded[index] = Math.min(imageTotal, baseOffset + clamped);
      emitProgress();
    };
    for (let attempt = 0; attempt <= maxChunkRetries; attempt++) {
      const outcome = await upload(request, onBytes, batchController.signal);
      if (outcome.ok || outcome.reason !== 'network' || batchController.signal.aborted) return outcome;
      loaded[index] = baseOffset;
      emitProgress();
      if (attempt === maxChunkRetries) return outcome;
      if (!(await waitAbortable(retryDelayMs * (attempt + 1), batchController.signal))) {
        return { ok: false, reason: 'aborted', message: 'Upload cancelled.' };
      }
    }
    return { ok: false, reason: 'network', message: 'The viewer server did not answer.' };
  };

  /**
   * @param {number} index
   * @param {UploadItem} item
   * @returns {Promise<{ ok: true, name: string } | { ok: false, reason: 'aborted' | 'network' | 'refused', message: string }>}
   */
  const uploadOne = async (index, item) => {
    const imageTotal = item.blob.size;
    if (imageTotal <= chunkBytes && item.partial === undefined) {
      const outcome = await sendWithRetries(index, 0, imageTotal, { mediaType: item.mediaType, blob: item.blob });
      if (outcome.ok) {
        return outcome.kind === 'done'
          ? { ok: true, name: outcome.name }
          : { ok: false, reason: 'network', message: 'Unexpected chunk response for whole upload.' };
      }
      if (outcome.reason === 'offset-mismatch') {
        return { ok: false, reason: 'network', message: 'Unexpected upload offset from the viewer server.' };
      }
      return outcome;
    }

    const id = item.partial?.id ?? newUploadId();
    let offset = item.partial !== undefined && item.partial.offset >= 0 && item.partial.offset < imageTotal ? item.partial.offset : 0;
    let resyncs = 0;

    while (offset < imageTotal) {
      const end = Math.min(offset + chunkBytes, imageTotal);
      const slice = item.blob.slice(offset, end);
      const outcome = await sendWithRetries(index, offset, imageTotal, {
        mediaType: item.mediaType,
        blob: slice,
        chunk: { id, offset, total: imageTotal },
      });
      if (outcome.ok) {
        if (outcome.kind === 'done') {
          onPartial?.(index, undefined);
          return { ok: true, name: outcome.name };
        }
        if (outcome.received <= offset || outcome.received > imageTotal) {
          return { ok: false, reason: 'network', message: 'Unexpected upload offset from the viewer server.' };
        }
        offset = outcome.received;
        loaded[index] = offset;
        confirmed[index] = offset;
        recordConfirmed();
        onPartial?.(index, { id, offset });
        emitProgress();
        if (!(await waitAbortable(chunkPauseMs, batchController.signal))) {
          return { ok: false, reason: 'aborted', message: 'Upload cancelled.' };
        }
        continue;
      }
      if (outcome.reason === 'offset-mismatch') {
        resyncs++;
        if (resyncs > maxOffsetResyncs) {
          return { ok: false, reason: 'network', message: 'Could not synchronize upload offset with the viewer server.' };
        }
        offset = outcome.received >= 0 && outcome.received < imageTotal ? outcome.received : 0;
        loaded[index] = offset;
        confirmed[index] = offset;
        recordConfirmed();
        onPartial?.(index, offset > 0 ? { id, offset } : undefined);
        emitProgress();
        continue;
      }
      loaded[index] = offset;
      emitProgress();
      return outcome;
    }
    return { ok: false, reason: 'network', message: 'Upload ended without a saved image name.' };
  };

  const worker = async () => {
    while (failed === undefined && !batchController.signal.aborted) {
      const index = pending[nextCursor++];
      if (index === undefined) return;
      const item = items[index];
      if (item === undefined) return;
      const outcome = await uploadOne(index, item);
      if (outcome.ok) {
        names[index] = outcome.name;
        loaded[index] = item.blob.size;
        confirmed[index] = item.blob.size;
        recordConfirmed();
        done++;
        onUploaded(index, outcome.name);
        emitProgress();
        if (nextCursor < pending.length && !(await waitAbortable(chunkPauseMs, batchController.signal))) {
          if (failed === undefined) {
            failed = { reason: 'aborted', message: 'Upload cancelled.' };
            batchController.abort();
          }
          return;
        }
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

  const finalPercent = snapshot().percent;
  if (failed !== undefined) return { ok: false, reason: failed.reason, message: failed.message, done, total, percent: finalPercent };
  if (signal.aborted) return { ok: false, reason: 'aborted', message: 'Upload cancelled.', done, total, percent: finalPercent };
  return { ok: true, names: names.flatMap((name) => (name === undefined ? [] : [name])) };
}

/**
 * Parses the HTTP response of POST /api/upload (whole or chunked).
 * @param {number} status — 0 when the request failed before receiving a status
 * @param {unknown} body — parsed JSON response, if any
 * @returns {UploadChunkOutcome}
 */
export function parseUploadReply(status, body) {
  if (status >= 200 && status < 300 && isRecord(body) && body.ok === true) {
    if (body.done === false && typeof body.received === 'number' && Number.isSafeInteger(body.received) && body.received >= 0) {
      return { ok: true, kind: 'chunk', received: body.received };
    }
    const name = text(body.name);
    if (name !== undefined) return { ok: true, kind: 'done', name };
  }
  if (
    status === 409 &&
    isRecord(body) &&
    body.error === 'offset-mismatch' &&
    typeof body.received === 'number' &&
    Number.isSafeInteger(body.received) &&
    body.received >= 0
  ) {
    return { ok: false, reason: 'offset-mismatch', received: body.received };
  }
  if (status >= 400 && status < 500) {
    const message = isRecord(body) ? (text(body.error) ?? text(body.message)) : undefined;
    return { ok: false, reason: 'refused', message: message ?? 'The viewer refused the image.' };
  }
  return { ok: false, reason: 'network', message: 'The viewer server did not answer.' };
}

/**
 * Formats a throughput measurement in bytes/sec for the upload progress line.
 * @param {number | undefined} bytesPerSec
 * @returns {string | undefined}
 */
export function formatUploadSpeed(bytesPerSec) {
  if (bytesPerSec === undefined || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return undefined;
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Human-readable status line above the upload progress bar.
 * @param {UploadProgress} progress
 * @returns {string}
 */
export function uploadProgressText(progress) {
  const speed = formatUploadSpeed(progress.bytesPerSec);
  const suffix = speed === undefined ? '' : ` · ${speed}`;
  if (progress.total <= 1) return progress.percent > 0 ? `Uploading image — ${progress.percent}%${suffix}` : 'Uploading image…';
  return `Uploading images: ${progress.done} of ${progress.total} (${progress.percent}%)${suffix}`;
}

/** @returns {string} */
function newUploadId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
