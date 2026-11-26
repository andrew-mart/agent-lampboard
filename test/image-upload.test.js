import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultChunkBytes, formatUploadSpeed, parseUploadReply, uploadImages, uploadProgressText } from '../public/model/image-upload.js';

/**
 * @param {number} bytes
 * @param {{ uploaded?: string, partial?: { id: string, offset: number } }} [state]
 */
function itemOf(bytes, state = {}) {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 7 + 3) % 251;
  return {
    mediaType: 'image/jpeg',
    blob: new Blob([data], { type: 'image/jpeg' }),
    uploaded: state.uploaded,
    partial: state.partial,
    raw: data,
  };
}

test('uploadImages_Should_SendByteChunksSequentiallyByDefault_And_ReportSmoothByteProgress', async () => {
  assert.equal(defaultChunkBytes, 256 * 1024);
  const large = itemOf(600 * 1024);
  const small = itemOf(100 * 1024);
  let inFlight = 0;
  let maxInFlight = 0;
  /** @type {number[]} */
  const percents = [];
  /** @type {Array<{ id: string, offset: number, total: number, size: number } | 'whole'>} */
  const sent = [];
  /** @type {Uint8Array[]} */
  const receivedParts = [];
  /** @type {Array<[number, { id: string, offset: number } | undefined]>} */
  const partials = [];
  /** @type {Map<number, string>} */
  const notified = new Map();

  const outcome = await uploadImages([large, small], {
    chunkPauseMs: 0,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: (progress) => percents.push(progress.percent),
    onUploaded: (index, name) => notified.set(index, name),
    onPartial: (index, partial) => partials.push([index, partial]),
    upload: async ({ blob, chunk }, onBytes) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      onBytes(Math.floor(blob.size / 2));
      await new Promise((resolve) => setTimeout(resolve, 5));
      onBytes(blob.size);
      inFlight--;
      if (chunk === undefined) {
        sent.push('whole');
        return { ok: true, kind: 'done', name: 'small.jpg' };
      }
      sent.push({ id: chunk.id, offset: chunk.offset, total: chunk.total, size: blob.size });
      receivedParts.push(new Uint8Array(await blob.arrayBuffer()));
      const next = chunk.offset + blob.size;
      if (next < chunk.total) return { ok: true, kind: 'chunk', received: next };
      return { ok: true, kind: 'done', name: 'large.jpg' };
    },
  });

  assert.deepEqual(outcome, { ok: true, names: ['large.jpg', 'small.jpg'] });
  assert.equal(maxInFlight, 1, 'default concurrency must be 1 to avoid head-of-line blocking');
  assert.equal(sent.length, 4);
  const chunks = sent.slice(0, 3);
  assert.ok(chunks.every((entry) => entry !== 'whole'));
  const [c0, c1, c2] = chunks;
  assert.ok(c0 !== undefined && c1 !== undefined && c2 !== undefined);
  assert.equal(c0.offset, 0);
  assert.equal(c0.size, 256 * 1024);
  assert.equal(c1.offset, 256 * 1024);
  assert.equal(c1.size, 256 * 1024);
  assert.equal(c2.offset, 512 * 1024);
  assert.equal(c2.size, 88 * 1024);
  assert.equal(c1.id, c0.id);
  assert.equal(c2.id, c0.id);
  assert.equal(sent[3], 'whole');

  const reassembled = Buffer.concat(receivedParts);
  assert.deepEqual(reassembled, Buffer.from(large.raw));
  assert.deepEqual(partials, [
    [0, { id: c0.id, offset: 256 * 1024 }],
    [0, { id: c0.id, offset: 512 * 1024 }],
    [0, undefined],
  ]);
  assert.equal(percents[0], 0);
  assert.equal(percents.at(-1), 100);
  assert.ok(percents.some((p) => p > 10 && p < 40) && percents.some((p) => p > 60 && p < 90), `expected smooth chunk progress, got: ${percents.join(',')}`);
  assert.deepEqual([...notified.entries()], [
    [0, 'large.jpg'],
    [1, 'small.jpg'],
  ]);
});

test('uploadImages_Should_RetryChunk_ResyncOffsetMismatch_And_ResumeFromPartialOffset', async () => {
  const kept = itemOf(100 * 1024, { uploaded: 'kept-0.jpg' });
  const big = itemOf(600 * 1024);
  const tail = itemOf(100 * 1024);
  const initial = [kept, big, tail];

  /** @type {Map<number, { id: string, offset: number } | undefined>} */
  const partials = new Map();
  /** @type {Map<number, string>} */
  const saved = new Map();
  /** @type {number[]} */
  const firstRunOffsets = [];
  let chunk1Calls = 0;
  let chunk2Calls = 0;

  const first = await uploadImages(initial, {
    chunkPauseMs: 0,
    retryDelayMs: 0,
    maxChunkRetries: 2,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onUploaded: (index, name) => saved.set(index, name),
    onPartial: (index, partial) => partials.set(index, partial),
    upload: async ({ blob, chunk }) => {
      assert.ok(chunk !== undefined);
      firstRunOffsets.push(chunk.offset);
      if (chunk.offset === 0) return { ok: true, kind: 'chunk', received: blob.size };
      if (chunk.offset === 256 * 1024) {
        chunk1Calls++;
        // First try drops; second try learns via 409 that the server actually persisted chunk 1 already!
        if (chunk1Calls === 1) return { ok: false, reason: 'network', message: 'Connection reset' };
        return { ok: false, reason: 'offset-mismatch', received: 512 * 1024 };
      }
      if (chunk.offset === 512 * 1024) {
        chunk2Calls++;
        return { ok: false, reason: 'network', message: 'Upload stalled.' };
      }
      return { ok: true, kind: 'done', name: 'unexpected.jpg' };
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.reason, 'network');
  assert.equal(first.done, 1);
  assert.equal(first.total, 3);
  assert.ok(first.percent > 70, `expected failure percent to include completed chunks, got ${first.percent}`);
  assert.equal(chunk1Calls, 2);
  assert.equal(chunk2Calls, 3, 'chunk should try once + 2 automatic retries');
  assert.deepEqual(firstRunOffsets, [0, 256 * 1024, 256 * 1024, 512 * 1024, 512 * 1024, 512 * 1024]);
  const savedPartial = partials.get(1);
  assert.ok(savedPartial !== undefined && savedPartial.offset === 512 * 1024);

  // Resume run: starts directly at offset 512 KB of image 1 using the same upload id, then uploads image 2
  /** @type {Array<{ id: string, offset: number, size: number } | 'whole'>} */
  const secondRunCalls = [];
  /** @type {number[]} */
  const resumedPercents = [];
  const resumedItems = initial.map((item, index) => ({
    ...item,
    uploaded: item.uploaded ?? saved.get(index),
    partial: partials.get(index),
  }));
  const second = await uploadImages(resumedItems, {
    chunkPauseMs: 0,
    retryDelayMs: 0,
    signal: new AbortController().signal,
    onProgress: (progress) => resumedPercents.push(progress.percent),
    onUploaded: () => undefined,
    onPartial: () => undefined,
    upload: async ({ blob, chunk }) => {
      if (chunk === undefined) {
        secondRunCalls.push('whole');
        return { ok: true, kind: 'done', name: 'tail-2.jpg' };
      }
      secondRunCalls.push({ id: chunk.id, offset: chunk.offset, size: blob.size });
      return { ok: true, kind: 'done', name: 'big-1.jpg' };
    },
  });

  assert.ok((resumedPercents[0] ?? 0) > 70, `expected resumed progress to start from saved chunks, got ${resumedPercents[0]}`);
  assert.deepEqual(secondRunCalls, [{ id: savedPartial.id, offset: 512 * 1024, size: 88 * 1024 }, 'whole']);
  assert.deepEqual(second, { ok: true, names: ['kept-0.jpg', 'big-1.jpg', 'tail-2.jpg'] });
});

test('uploadImages_Should_NotRetryRefusal_And_HandleAbortPreservingPartial', async () => {
  let refusalCalls = 0;
  const refused = await uploadImages([itemOf(100), itemOf(200)], {
    chunkPauseMs: 0,
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
  /** @type {{ id: string, offset: number } | undefined} */
  let keptPartial;
  const aborted = await uploadImages([itemOf(600 * 1024)], {
    chunkPauseMs: 0,
    retryDelayMs: 0,
    signal: controller.signal,
    onProgress: () => undefined,
    onUploaded: () => undefined,
    onPartial: (_index, partial) => {
      keptPartial = partial;
    },
    upload: async ({ blob, chunk }, _onBytes, signal) => {
      assert.ok(chunk !== undefined);
      if (chunk.offset === 0) return { ok: true, kind: 'chunk', received: blob.size };
      controller.abort();
      return signal.aborted ? { ok: false, reason: 'aborted', message: 'Upload cancelled.' } : { ok: true, kind: 'done', name: 'x.jpg' };
    },
  });

  assert.equal(aborted.ok, false);
  assert.equal(aborted.reason, 'aborted');
  assert.ok(aborted.percent > 30, `expected abort percent > 30, got ${aborted.percent}`);
  assert.ok(keptPartial !== undefined && keptPartial.offset === 256 * 1024);
});

test('parseUploadReply_And_uploadProgressText_Should_HandleAllOutcomes', () => {
  assert.deepEqual(parseUploadReply(200, { ok: true, name: '20261126_135000-abcd1234.jpg' }), { ok: true, kind: 'done', name: '20261126_135000-abcd1234.jpg' });
  assert.deepEqual(parseUploadReply(200, { ok: true, done: true, name: '20261126_135000-abcd1234.jpg' }), { ok: true, kind: 'done', name: '20261126_135000-abcd1234.jpg' });
  assert.deepEqual(parseUploadReply(200, { ok: true, done: false, received: 262144 }), { ok: true, kind: 'chunk', received: 262144 });
  assert.deepEqual(parseUploadReply(409, { ok: false, error: 'offset-mismatch', received: 524288 }), { ok: false, reason: 'offset-mismatch', received: 524288 });
  assert.deepEqual(parseUploadReply(413, { ok: false, error: 'An attached image must be under 15 MB.' }), { ok: false, reason: 'refused', message: 'An attached image must be under 15 MB.' });
  assert.deepEqual(parseUploadReply(502, undefined), { ok: false, reason: 'network', message: 'The viewer server did not answer.' });

  assert.equal(formatUploadSpeed(undefined), undefined);
  assert.equal(formatUploadSpeed(0), undefined);
  assert.equal(formatUploadSpeed(512), '512 B/s');
  assert.equal(formatUploadSpeed(185 * 1024), '185 KB/s');
  assert.equal(formatUploadSpeed(1.6 * 1024 * 1024), '1.6 MB/s');

  assert.equal(uploadProgressText({ done: 0, total: 1, loadedBytes: 42, totalBytes: 100, percent: 42, bytesPerSec: undefined }), 'Uploading image — 42%');
  assert.equal(uploadProgressText({ done: 0, total: 1, loadedBytes: 50, totalBytes: 100, percent: 50, bytesPerSec: 1.6 * 1024 * 1024 }), 'Uploading image — 50% · 1.6 MB/s');
  assert.equal(uploadProgressText({ done: 12, total: 33, loadedBytes: 3600, totalBytes: 10000, percent: 36, bytesPerSec: 185 * 1024 }), 'Uploading images: 12 of 33 (36%) · 185 KB/s');
});

test('uploadImages_Should_ComputeMomentarySpeedFromConfirmedChunks_And_IgnorePreuploadedBytes', async () => {
  let clock = 1000;
  const kept = itemOf(1000 * 1024, { uploaded: 'already.jpg' });
  const pending = itemOf(768 * 1024);
  /** @type {Array<{ loadedBytes: number, bytesPerSec: number | undefined }>} */
  const samples = [];

  const outcome = await uploadImages([kept, pending], {
    chunkPauseMs: 0,
    retryDelayMs: 0,
    now: () => clock,
    signal: new AbortController().signal,
    onProgress: (progress) => samples.push({ loadedBytes: progress.loadedBytes, bytesPerSec: progress.bytesPerSec }),
    onUploaded: () => undefined,
    upload: async ({ blob, chunk }) => {
      assert.ok(chunk !== undefined);
      if (chunk.offset === 0) {
        clock += 2000; // 256 KB in 2s = 128 KB/s
        return { ok: true, kind: 'chunk', received: blob.size };
      }
      if (chunk.offset === 256 * 1024) {
        clock += 1000; // +256 KB in 1s -> 512 KB in 3s ≈ 170.7 KB/s
        return { ok: true, kind: 'chunk', received: chunk.offset + blob.size };
      }
      clock += 6000; // +256 KB in 6s -> sliding 5s window drops old samples -> 256 KB / 6s ≈ 42.7 KB/s
      return { ok: true, kind: 'done', name: 'fresh.jpg' };
    },
  });

  assert.deepEqual(outcome, { ok: true, names: ['already.jpg', 'fresh.jpg'] });
  assert.equal(samples[0]?.bytesPerSec, undefined, 'no speed before first confirmed chunk');
  const afterChunk0 = samples.find((s) => s.loadedBytes === (1000 + 256) * 1024)?.bytesPerSec;
  const afterChunk1 = samples.find((s) => s.loadedBytes === (1000 + 512) * 1024)?.bytesPerSec;
  const afterChunk2 = samples.at(-1)?.bytesPerSec;
  assert.ok(afterChunk0 !== undefined && Math.abs(afterChunk0 - 128 * 1024) < 1, `expected 128 KB/s, got ${afterChunk0}`);
  assert.ok(afterChunk1 !== undefined && Math.abs(afterChunk1 - (512 * 1024) / 3) < 1, `expected ~170.7 KB/s, got ${afterChunk1}`);
  assert.ok(afterChunk2 !== undefined && Math.abs(afterChunk2 - (256 * 1024) / 6) < 1, `expected ~42.7 KB/s after slowdown, got ${afterChunk2}`);
});
