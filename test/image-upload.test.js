import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUploadReply, uploadImages, uploadProgressText } from '../public/model/image-upload.js';

/** @param {number} bytes @param {string | undefined} [uploaded] */
const itemOf = (bytes, uploaded = undefined) => ({
  mediaType: 'image/jpeg',
  blob: new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
  uploaded,
});

test('uploadImages_Should_UploadInBoundedParallelChunks_PreservingOrderAndReportingByteProgress', async () => {
  const items = [itemOf(100), itemOf(200), itemOf(300), itemOf(400), itemOf(500)];
  let inFlight = 0;
  let maxInFlight = 0;
  /** @type {number[]} */
  const percents = [];
  /** @type {number[]} */
  const doneCounts = [];
  /** @type {Map<number, string>} */
  const notified = new Map();

  const outcome = await uploadImages(items, {
    concurrency: 2,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: (progress) => {
      percents.push(progress.percent);
      doneCounts.push(progress.done);
    },
    onUploaded: (index, name) => notified.set(index, name),
    upload: async ({ blob }, onBytes) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onBytes(Math.floor(blob.size / 2));
      // Earlier smaller items finish slower than later items to verify original order is preserved
      await new Promise((resolve) => setTimeout(resolve, blob.size === 100 ? 25 : 5));
      onBytes(blob.size);
      inFlight--;
      return { ok: true, name: `img-${blob.size}.jpg` };
    },
  });

  assert.deepEqual(outcome, { ok: true, names: ['img-100.jpg', 'img-200.jpg', 'img-300.jpg', 'img-400.jpg', 'img-500.jpg'] });
  assert.equal(maxInFlight, 2);
  assert.equal(percents[0], 0);
  assert.equal(percents.at(-1), 100);
  assert.ok(percents.some((p) => p > 0 && p < 100), `expected intermediate progress: ${percents.join(',')}`);
  assert.equal(doneCounts.at(-1), 5);
  assert.deepEqual([...notified.entries()].sort((a, b) => a[0] - b[0]), [
    [0, 'img-100.jpg'],
    [1, 'img-200.jpg'],
    [2, 'img-300.jpg'],
    [3, 'img-400.jpg'],
    [4, 'img-500.jpg'],
  ]);
});

test('uploadImages_Should_RetryTransientNetworkOnce_And_ResumeSkippingAlreadyUploaded', async () => {
  // First run: item 0 succeeds after 1 transient network drop; item 1 already uploaded (skipped); item 2 fails twice; item 3 never started
  const attempts = new Map();
  /** @type {Map<number, string>} */
  const saved = new Map();
  const initial = [itemOf(100), itemOf(200, 'kept-1.jpg'), itemOf(300), itemOf(400)];

  const first = await uploadImages(initial, {
    concurrency: 1,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onUploaded: (index, name) => saved.set(index, name),
    upload: async ({ blob }) => {
      const count = (attempts.get(blob.size) ?? 0) + 1;
      attempts.set(blob.size, count);
      if (blob.size === 100 && count === 1) return { ok: false, reason: 'network', message: 'Network drop' };
      if (blob.size === 300) return { ok: false, reason: 'network', message: 'Server unreachable' };
      return { ok: true, name: `up-${blob.size}.jpg` };
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.reason, 'network');
  assert.equal(first.done, 2);
  assert.equal(first.total, 4);
  assert.equal(attempts.get(100), 2);
  assert.equal(attempts.get(200), undefined);
  assert.equal(attempts.get(300), 2);
  assert.equal(attempts.get(400), undefined);
  assert.equal(saved.get(0), 'up-100.jpg');

  // Second run (resume): items 0 and 1 already have uploaded names → only items 2 and 3 upload
  /** @type {number[]} */
  const resumedSizes = [];
  /** @type {number[]} */
  const resumedDone = [];
  const resumedItems = initial.map((item, index) => ({ ...item, uploaded: item.uploaded ?? saved.get(index) }));
  const second = await uploadImages(resumedItems, {
    concurrency: 2,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: (progress) => resumedDone.push(progress.done),
    onUploaded: () => undefined,
    upload: async ({ blob }) => {
      resumedSizes.push(blob.size);
      return { ok: true, name: `up-${blob.size}.jpg` };
    },
  });

  assert.deepEqual(resumedSizes.sort((a, b) => a - b), [300, 400]);
  assert.equal(resumedDone[0], 2);
  assert.deepEqual(second, { ok: true, names: ['up-100.jpg', 'kept-1.jpg', 'up-300.jpg', 'up-400.jpg'] });
});

test('uploadImages_Should_NotRetryRefusal_And_HandleAbort', async () => {
  let refusalCalls = 0;
  const refused = await uploadImages([itemOf(100), itemOf(200)], {
    concurrency: 1,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onUploaded: () => undefined,
    upload: async () => {
      refusalCalls++;
      return { ok: false, reason: 'refused', message: 'An attached image must be under 15 MB.' };
    },
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.message, 'An attached image must be under 15 MB.');
  assert.equal(refusalCalls, 1);

  const controller = new AbortController();
  const aborted = await uploadImages([itemOf(100), itemOf(200)], {
    concurrency: 1,
    retryDelayMs: 0,
    signal: controller.signal,
    onProgress: () => undefined,
    onUploaded: () => undefined,
    upload: async (_item, _onBytes, signal) => {
      controller.abort();
      return signal.aborted ? { ok: false, reason: 'aborted', message: 'Upload cancelled.' } : { ok: true, name: 'x.jpg' };
    },
  });

  assert.equal(aborted.ok, false);
  assert.equal(aborted.reason, 'aborted');
});

test('parseUploadReply_And_uploadProgressText_Should_HandleAllOutcomes', () => {
  assert.deepEqual(parseUploadReply(200, { ok: true, name: '20261126_135000-abcd1234.jpg' }), { ok: true, name: '20261126_135000-abcd1234.jpg' });
  assert.deepEqual(parseUploadReply(413, { ok: false, error: 'An attached image must be under 15 MB.' }), { ok: false, reason: 'refused', message: 'An attached image must be under 15 MB.' });
  assert.deepEqual(parseUploadReply(502, undefined), { ok: false, reason: 'network', message: 'The viewer server did not answer.' });

  assert.equal(uploadProgressText({ done: 0, total: 1, loadedBytes: 42, totalBytes: 100, percent: 42 }), 'Uploading image — 42%');
  assert.equal(uploadProgressText({ done: 12, total: 33, loadedBytes: 3600, totalBytes: 10000, percent: 36 }), 'Uploading images: 12 of 33 (36%)');
});
