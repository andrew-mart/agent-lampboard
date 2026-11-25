import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, sessionStorage: window.sessionStorage, HTMLElement: window.HTMLElement, File: window.File });
const { createComposer } = await import('../public/view/composer-view.js');
const { createAsideStore } = await import('../public/view/aside-store.js');

const sessionId = '3f2c9a50-1111-4222-8333-944455556666';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * The box of a session in a herdr pane, its agent busy in it or not; what the page asked the viewer to send.
 * @param {'busy' | 'idle'} status
 * @param {(box: HTMLTextAreaElement, composer: ReturnType<typeof createComposer>) => void} act
 * @param {import('../public/model/composer.js').Agent} [agent]
 * @returns {Promise<{ sent: unknown[], onSent: string[], button: boolean, disabledInitially: boolean | undefined }>} — button: the send-now button is shown
 */
async function sendWhile(status, act, agent = 'claude') {
  /** @type {unknown[]} */
  const sent = [];
  /** @type {string[]} */
  const onSent = [];
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: false }),
    fetch: async (/** @type {string} */ path, /** @type {RequestInit | undefined} */ init) => {
      if (path === '/api/send') sent.push(JSON.parse(String(init?.body)));
      const body = path === '/api/send' ? { ok: true, pane: 'w1:p1' } : { state: 'live', status, pane: 'w1:p1' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const composer = createComposer(sessionId, { agent, focusBox: 'no', placeOf: () => undefined, asides: createAsideStore(), onSent: (text) => onSent.push(text), onDialog: () => undefined });
  window.document.body.append(composer.element);
  await settle();
  const box = composer.element.querySelector('.composer-input');
  assert.ok(box instanceof window.HTMLTextAreaElement);
  const button = composer.element.querySelector('.composer-send-now');
  const disabledInitially = button instanceof window.HTMLButtonElement ? button.disabled : undefined;
  act(box, composer);
  await settle();
  composer.dispose();
  composer.element.remove();
  // of what was sent, the text and whether it went now
  const told = sent.map((body) => (typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body).filter(([key]) => key === 'text' || key === 'now')) : body));
  return { sent: told, onSent, button: button instanceof window.HTMLElement && !button.hidden, disabledInitially };
}

/** @param {string} text @returns {(box: HTMLTextAreaElement) => void} */
const ctrlEnter = (text) => (box) => {
  box.value = text;
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
};

// While Claude works a message waits in Claude Code's queue; Ctrl+Enter sends it at once, and ⏩ on a message waiting
// there sends the queue alone. While Claude is idle there is no queue: Ctrl+Enter sends as Enter does. The box itself
// has no button of its own for it
test('composer_Should_SendNowPastQueue_WhileClaudeWorks', async () => {
  const busyKeys = await sendWhile('busy', ctrlEnter('Stop and check the logs'));
  const busyQueue = await sendWhile('busy', (box, composer) => composer.sendQueue());
  const idleKeys = await sendWhile('idle', ctrlEnter('Go on'));

  assert.deepEqual(
    [busyKeys, busyQueue, idleKeys].map(({ sent, button }) => ({ sent, button })),
    [
      { sent: [{ text: 'Stop and check the logs', now: true }], button: false },
      { sent: [{ text: '', now: true }], button: false },
      { sent: [{ text: 'Go on' }], button: false },
    ],
  );
});

// While agy works, the composer shows a send-now button (hidden while idle, disabled when the box is empty) to send
// immediately into agy's active turn; Ctrl+Enter sends immediately too, and on an empty box flushes queued messages
// without announcing an empty sent prompt
test('composer_Should_ShowSendNowButton_AndSendImmediately_WhileAgyWorks', async () => {
  const busyButton = await sendWhile(
    'busy',
    (box, composer) => {
      box.value = 'Use no_proxy';
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
      const button = composer.element.querySelector('.composer-send-now');
      assert.ok(button instanceof window.HTMLButtonElement);
      button.click();
    },
    'agy',
  );
  const busyKeys = await sendWhile('busy', ctrlEnter('Check logs'), 'agy');
  const busyEmptyKeys = await sendWhile('busy', ctrlEnter(''), 'agy');
  const idleKeys = await sendWhile('idle', ctrlEnter('Go on'), 'agy');

  assert.deepEqual(
    { busyButton, busyKeys, busyEmptyKeys, idleKeys },
    {
      busyButton: { sent: [{ text: 'Use no_proxy', now: true }], onSent: ['Use no_proxy'], button: true, disabledInitially: true },
      busyKeys: { sent: [{ text: 'Check logs', now: true }], onSent: ['Check logs'], button: true, disabledInitially: true },
      busyEmptyKeys: { sent: [{ text: '', now: true }], onSent: [], button: true, disabledInitially: true },
      idleKeys: { sent: [{ text: 'Go on' }], onSent: ['Go on'], button: false, disabledInitially: true },
    },
  );
});
