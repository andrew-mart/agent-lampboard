import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window,
  document: window.document,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLProgressElement: window.HTMLProgressElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  requestAnimationFrame: (/** @type {FrameRequestCallback} */ cb) => setTimeout(cb, 0),
  createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
});
const { createComposer, sendUploadChunk } = await import('../public/view/composer-view.js');
const { createAsideStore } = await import('../public/view/aside-store.js');
const { uploadImages } = await import('../public/model/image-upload.js');

const sessionId = '3f2c9a50-1111-4222-8333-944455556666';
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle(15);
  }
  assert.fail('Timed out waiting for condition');
}

/** @param {number} count */
function makeFiles(count) {
  return Array.from({ length: count }, (_, index) => {
    const bytes = new Uint8Array(64 + index);
    bytes.fill(index + 1);
    return new File([bytes], `page-${index + 1}.png`, { type: 'image/png' });
  });
}

/**
 * @param {HTMLElement} root
 * @param {readonly File[]} files
 */
function attachFiles(root, files) {
  const input = root.querySelector('input[type="file"]');
  assert.ok(input instanceof window.HTMLInputElement);
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/**
 * @param {(path: string, init?: RequestInit) => Promise<Response>} handleFetch
 */
async function mountComposer(handleFetch) {
  window.localStorage.clear();
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: false }),
    fetch: async (/** @type {string} */ path, /** @type {RequestInit | undefined} */ init) => {
      if (path.startsWith('/api/live')) {
        return new Response(JSON.stringify({ state: 'live', status: 'idle', pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return handleFetch(path, init);
    },
  });
  /** @type {string[]} */
  const sentTexts = [];
  const composer = createComposer(sessionId, {
    agent: 'claude',
    focusBox: 'no',
    placeOf: () => undefined,
    asides: createAsideStore(),
    onSent: (text) => sentTexts.push(text),
    onDialog: () => undefined,
  });
  window.document.body.append(composer.element);
  await settle();
  return {
    composer,
    sentTexts,
    cleanup: () => {
      composer.dispose();
      composer.element.remove();
    },
  };
}

test('composer_Should_UploadImagesInChunksWithProgressBar_And_SendUploadNames', async (t) => {
  /** @type {number[]} */
  const uploadedSizes = [];
  /** @type {unknown[]} */
  const sendBodies = [];
  /** @type {string[]} */
  const observedLabels = [];
  /** @type {number[]} */
  const observedValues = [];
  let uploadSeq = 0;

  const { composer, sentTexts, cleanup } = await mountComposer(async (path, init) => {
    if (path === '/api/upload') {
      assert.equal(init?.headers && /** @type {Record<string, string>} */ (init.headers)['Content-Type'], 'image/png');
      const body = init?.body;
      const size = body instanceof window.Blob ? body.size : body instanceof Blob ? body.size : 0;
      uploadedSizes.push(size);
      const wrap = composer.element.querySelector('.composer-upload');
      const label = composer.element.querySelector('.composer-upload-label');
      const bar = composer.element.querySelector('.composer-upload-bar');
      if (wrap instanceof window.HTMLElement && !wrap.hidden && label !== null && bar instanceof window.HTMLProgressElement) {
        observedLabels.push(label.textContent ?? '');
        observedValues.push(bar.value);
      }
      await settle(5);
      uploadSeq++;
      return new Response(JSON.stringify({ ok: true, name: `20261126_135000-u${String(size).padStart(4, '0')}${uploadSeq}.png` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/send') {
      sendBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  attachFiles(composer.element, makeFiles(12));
  await settle(60);
  const box = composer.element.querySelector('.composer-input');
  assert.ok(box instanceof window.HTMLTextAreaElement);
  box.value = 'Look at all 12 pages';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));

  const sendBtn = composer.element.querySelector('.composer-send');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);
  sendBtn.click();
  await waitUntil(() => sendBodies.length === 1);
  await settle(20);

  assert.equal(uploadedSizes.length, 12);
  assert.ok(observedLabels.some((text) => text.includes('of 12')), `expected batch progress label, got: ${observedLabels.join(' | ')}`);
  assert.ok(observedValues.some((v) => v > 0), `expected advancing progress values, got: ${observedValues.join(',')}`);
  const uploadWrap = composer.element.querySelector('.composer-upload');
  assert.ok(uploadWrap instanceof window.HTMLElement && uploadWrap.hidden, 'progress UI should hide after send completes');
  assert.equal(sendBodies.length, 1);
  const sent = /** @type {Record<string, unknown>} */ (sendBodies[0]);
  assert.equal(sent.text, 'Look at all 12 pages');
  assert.equal(sent.images, undefined);
  assert.ok(Array.isArray(sent.uploads) && sent.uploads.length === 12);
  // Original order preserved (size 64..75 encoded in returned name)
  const orderedSizes = sent.uploads.map((name) => Number(String(name).slice(17, 21)));
  assert.deepEqual(
    orderedSizes,
    Array.from({ length: 12 }, (_, i) => 64 + i),
  );
  assert.deepEqual(sentTexts, ['Look at all 12 pages']);
  assert.equal(composer.element.querySelectorAll('.attachment').length, 0);
});

test('composer_Should_ResumePartialUploadWithoutReuploadingAlreadySavedImages', async (t) => {
  let failThird = true;
  /** @type {number[]} */
  const firstRunSizes = [];
  /** @type {number[]} */
  const secondRunSizes = [];
  /** @type {unknown[]} */
  const sendBodies = [];

  const { composer, cleanup } = await mountComposer(async (path, init) => {
    if (path === '/api/upload') {
      const body = init?.body;
      const size = body instanceof window.Blob ? body.size : body instanceof Blob ? body.size : 0;
      if (failThird) {
        firstRunSizes.push(size);
        // Fail images 2 and 3 (sizes 66, 67) so only 0 and 1 (64, 65) succeed on first try
        if (size >= 66) return new Response('Bad gateway', { status: 502 });
      } else {
        secondRunSizes.push(size);
      }
      return new Response(JSON.stringify({ ok: true, name: `20261126_135000-s${size}.png` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/send') {
      sendBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  attachFiles(composer.element, makeFiles(4));
  await settle(40);
  const sendBtn = composer.element.querySelector('.composer-send');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);

  sendBtn.click();
  await waitUntil(() => (composer.element.querySelector('.composer-status')?.textContent ?? '').includes('2 of 4'));
  const statusAfterFail = composer.element.querySelector('.composer-status')?.textContent ?? '';
  assert.ok(statusAfterFail.includes('2 of 4'), `expected partial upload count in status, got: ${statusAfterFail}`);
  assert.equal(sendBodies.length, 0);
  assert.equal(composer.element.querySelectorAll('.attachment').length, 4);

  failThird = false;
  sendBtn.click();
  await waitUntil(() => sendBodies.length === 1);

  assert.deepEqual(secondRunSizes.sort((a, b) => a - b), [66, 67]);
  assert.equal(sendBodies.length, 1);
  assert.deepEqual(/** @type {Record<string, unknown>} */ (sendBodies[0]).uploads, [
    '20261126_135000-s64.png',
    '20261126_135000-s65.png',
    '20261126_135000-s66.png',
    '20261126_135000-s67.png',
  ]);
});

test('composer_Should_CancelUploadAndSurfaceRefusalMessage', async (t) => {
  /** @type {'hang' | 'refuse'} */
  let mode = 'hang';
  const { composer, cleanup } = await mountComposer(async (path, init) => {
    if (path === '/api/upload') {
      if (mode === 'refuse') {
        return new Response(JSON.stringify({ ok: false, error: 'An attached image must be under 15 MB.' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
      }
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  attachFiles(composer.element, makeFiles(2));
  await settle(40);
  const sendBtn = composer.element.querySelector('.composer-send');
  const cancelBtn = composer.element.querySelector('.composer-upload-cancel');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);
  assert.ok(cancelBtn instanceof window.HTMLButtonElement);

  sendBtn.click();
  await settle(20);
  cancelBtn.click();
  await settle(30);
  const afterCancel = {
    status: composer.element.querySelector('.composer-status')?.textContent ?? '',
    disabled: sendBtn.disabled,
    hidden: composer.element.querySelector('.composer-upload')?.hasAttribute('hidden'),
  };

  mode = 'refuse';
  sendBtn.click();
  await settle(40);
  const afterRefusal = composer.element.querySelector('.composer-status')?.textContent ?? '';

  assert.ok(afterCancel.status.toLowerCase().includes('cancel'), `expected cancel status, got: ${afterCancel.status}`);
  assert.equal(afterCancel.disabled, false);
  assert.equal(afterCancel.hidden, true);
  assert.ok(afterRefusal.includes('15 MB'), `expected server refusal message, got: ${afterRefusal}`);
});

test('composer_Should_ReuploadMissingFilesOnce_When_SendReturns409MissingUploads', async (t) => {
  let sendCount = 0;
  let uploadCount = 0;
  /** @type {number[]} */
  const uploadedSizes = [];
  /** @type {unknown[]} */
  const sendBodies = [];

  const { composer, cleanup } = await mountComposer(async (path, init) => {
    if (path === '/api/upload') {
      uploadCount++;
      const body = init?.body;
      const size = body instanceof window.Blob ? body.size : body instanceof Blob ? body.size : 0;
      uploadedSizes.push(size);
      return new Response(JSON.stringify({ ok: true, name: `20261126_135000-r${uploadCount}s${size}.png` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/send') {
      sendCount++;
      const body = JSON.parse(String(init?.body));
      sendBodies.push(body);
      if (sendCount === 1) {
        return new Response(JSON.stringify({ ok: false, error: 'missing-uploads', missing: [body.uploads[0]] }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  attachFiles(composer.element, makeFiles(2));
  await settle(40);
  const sendBtn = composer.element.querySelector('.composer-send');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);
  sendBtn.click();
  await waitUntil(() => sendBodies.length === 2);
  await settle(20);

  // 2 initial uploads + 1 re-upload for the missing first file = 3 uploads total
  assert.equal(uploadedSizes.length, 3);
  assert.equal(uploadedSizes[2], 64);
  assert.equal(sendBodies.length, 2);
  const secondUploads = /** @type {Record<string, unknown>} */ (sendBodies[1]).uploads;
  const firstUploads = /** @type {Record<string, unknown>} */ (sendBodies[0]).uploads;
  assert.ok(Array.isArray(secondUploads) && Array.isArray(firstUploads));
  assert.notEqual(secondUploads[0], firstUploads[0]);
  assert.equal(secondUploads[1], firstUploads[1]);
});

test('composer_Should_ReportByteProgressThroughXmlHttpRequest_When_AvailableInBrowser', async (t) => {
  /** @type {number[]} */
  const seenPercents = [];
  /** @type {Record<string, string>} */
  const sentHeaders = {};
  /** @type {string[]} */
  const sendUploads = [];

  class FakeXhr extends EventTarget {
    upload = new EventTarget();
    status = 0;
    /** @type {unknown} */
    response = undefined;
    responseType = '';
    /** @param {string} _method @param {string} _url */
    open(_method, _url) {}
    /** @param {string} name @param {string} value */
    setRequestHeader(name, value) {
      sentHeaders[name] = value;
    }
    /** @param {Blob} blob */
    send(blob) {
      setTimeout(() => {
        const progressEvent = new Event('progress');
        Object.defineProperty(progressEvent, 'loaded', { value: Math.floor(blob.size / 2) });
        this.upload.dispatchEvent(progressEvent);
        const bar = composer.element.querySelector('.composer-upload-bar');
        if (bar instanceof window.HTMLProgressElement) seenPercents.push(bar.value);
      }, 5);
      setTimeout(() => {
        this.status = 200;
        this.response = { ok: true, name: `20261126_135000-xhr${blob.size}.png` };
        this.dispatchEvent(new Event('load'));
      }, 15);
    }
    abort() {
      this.dispatchEvent(new Event('abort'));
    }
  }

  Reflect.set(globalThis, 'XMLHttpRequest', FakeXhr);
  t.after(() => Reflect.deleteProperty(globalThis, 'XMLHttpRequest'));

  const { composer, cleanup } = await mountComposer(async (path, init) => {
    if (path === '/api/send') {
      const body = JSON.parse(String(init?.body));
      sendUploads.push(...body.uploads);
      return new Response(JSON.stringify({ ok: true, pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  attachFiles(composer.element, makeFiles(1));
  await settle(30);
  const sendBtn = composer.element.querySelector('.composer-send');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);
  sendBtn.click();
  await settle(80);

  assert.equal(sentHeaders['X-Viewer'], '1');
  assert.equal(sentHeaders['Content-Type'], 'image/png');
  assert.deepEqual(seenPercents, [50]);
  assert.deepEqual(sendUploads, ['20261126_135000-xhr64.png']);
});

test('composer_Should_UploadLargeImageIn256KBChunks_And_ResumeFromFailedChunk', async (t) => {
  let failLastChunk = true;
  /** @type {Array<{ id: string | null, offset: number, total: number, size: number }>} */
  const firstRunChunks = [];
  /** @type {Array<{ id: string | null, offset: number, total: number, size: number }>} */
  const secondRunChunks = [];
  /** @type {unknown[]} */
  const sendBodies = [];
  /** @type {string[]} */
  const seenLabels = [];

  const { composer, cleanup } = await mountComposer(async (path, init) => {
    if (path.startsWith('/api/upload')) {
      const url = new URL(path, 'http://localhost');
      const id = url.searchParams.get('id');
      const offset = Number(url.searchParams.get('offset') ?? -1);
      const total = Number(url.searchParams.get('total') ?? -1);
      const body = init?.body;
      const size = body instanceof window.Blob ? body.size : body instanceof Blob ? body.size : 0;
      const label = composer.element.querySelector('.composer-upload-label')?.textContent ?? '';
      if (label !== '') seenLabels.push(label);
      const entry = { id, offset, total, size };
      if (failLastChunk) {
        firstRunChunks.push(entry);
        if (offset + size >= total) return new Response('Bad gateway', { status: 502 });
        await settle(65);
        return new Response(JSON.stringify({ ok: true, done: false, received: offset + size }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      secondRunChunks.push(entry);
      return new Response(JSON.stringify({ ok: true, done: true, name: '20261126_144000-big01.png' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/send') {
      sendBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, pane: 'w1:p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  });
  t.after(cleanup);

  const bigBytes = new Uint8Array(600 * 1024);
  bigBytes.fill(42);
  attachFiles(composer.element, [new File([bigBytes], 'big.png', { type: 'image/png' })]);
  await settle(40);
  const sendBtn = composer.element.querySelector('.composer-send');
  assert.ok(sendBtn instanceof window.HTMLButtonElement);

  sendBtn.click();
  await waitUntil(() => (composer.element.querySelector('.composer-status')?.textContent ?? '').includes('Press Send to continue'));
  const statusAfterFail = composer.element.querySelector('.composer-status')?.textContent ?? '';
  assert.ok(statusAfterFail.includes('85%'), `expected partial byte percentage in status, got: ${statusAfterFail}`);
  assert.equal(sendBodies.length, 0);
  assert.equal(firstRunChunks[0]?.offset, 0);
  assert.equal(firstRunChunks[0]?.size, 256 * 1024);
  assert.equal(firstRunChunks[1]?.offset, 256 * 1024);
  assert.equal(firstRunChunks[1]?.size, 256 * 1024);
  assert.equal(firstRunChunks[2]?.offset, 512 * 1024);
  assert.equal(firstRunChunks[2]?.size, 88 * 1024);
  const uploadId = firstRunChunks[0]?.id;
  assert.ok(typeof uploadId === 'string' && uploadId.length >= 8);

  failLastChunk = false;
  sendBtn.click();
  await waitUntil(() => sendBodies.length === 1);

  assert.ok(seenLabels.some((text) => /[KM]?B\/s/.test(text)), `expected live upload speed in label, got: ${seenLabels.join(' | ')}`);
  assert.deepEqual(secondRunChunks, [{ id: uploadId, offset: 512 * 1024, total: 600 * 1024, size: 88 * 1024 }]);
  assert.deepEqual(/** @type {Record<string, unknown>} */ (sendBodies[0]).uploads, ['20261126_144000-big01.png']);
});

test('sendUploadChunk_Should_AbortStalledXhrAfterInactivity_And_RetryToCompletion', async (t) => {
  let attempt = 0;
  let abortCount = 0;
  /** @type {string[]} */
  const openedUrls = [];

  class StallingXhr extends EventTarget {
    upload = new EventTarget();
    status = 0;
    /** @type {unknown} */
    response = undefined;
    responseType = '';
    /** @param {string} _method @param {string} url */
    open(_method, url) {
      openedUrls.push(url);
    }
    /** @param {string} _name @param {string} _value */
    setRequestHeader(_name, _value) {}
    /** @param {Blob} _blob */
    send(_blob) {
      attempt++;
      if (attempt === 1) {
        // One early progress tick keeps the timer alive briefly, then hangs forever until stall timeout aborts it
        setTimeout(() => {
          const ev = new Event('progress');
          Object.defineProperty(ev, 'loaded', { value: 64 });
          this.upload.dispatchEvent(ev);
        }, 15);
        return;
      }
      setTimeout(() => {
        this.status = 200;
        this.response = { ok: true, done: true, name: '20261126_144000-recovered.png' };
        this.dispatchEvent(new Event('load'));
      }, 10);
    }
    abort() {
      abortCount++;
      this.dispatchEvent(new Event('abort'));
    }
  }

  Reflect.set(globalThis, 'XMLHttpRequest', StallingXhr);
  t.after(() => Reflect.deleteProperty(globalThis, 'XMLHttpRequest'));

  const item = { mediaType: 'image/png', blob: new Blob([new Uint8Array(512)], { type: 'image/png' }), uploaded: undefined };
  const result = await uploadImages([item], {
    chunkBytes: 1024,
    chunkPauseMs: 0,
    retryDelayMs: 5,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onUploaded: () => undefined,
    upload: (req, onBytes, signal) => sendUploadChunk(req, onBytes, signal, 45),
  });

  assert.deepEqual(result, { ok: true, names: ['20261126_144000-recovered.png'] });
  assert.equal(attempt, 2);
  assert.equal(abortCount, 1);
  assert.deepEqual(openedUrls, ['/api/upload', '/api/upload']);
});
