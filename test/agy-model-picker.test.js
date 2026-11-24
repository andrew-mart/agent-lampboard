import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { window, document: window.document, Node: window.Node });
const { createAgyModelPicker } = await import('../public/view/agy-model-picker.js');

const session = '6f1c2a3b-5d4e-4f60-8a7b-9c0d1e2f3a4b';

/** @type {readonly import('../public/model/agy-models.js').AgyModel[]} */
const catalog = [
  {
    name: 'Gemini 4 Hydrogen',
    defaultId: 'gemini-4-hydrogen-high',
    defaultEffort: 'high',
    efforts: [
      { level: 'low', id: 'gemini-4-hydrogen-low' },
      { level: 'medium', id: 'gemini-4-hydrogen-medium' },
      { level: 'high', id: 'gemini-4-hydrogen-high' },
      { level: 'xhigh', id: 'gemini-4-hydrogen-xhigh' },
    ],
  },
  {
    name: 'Claude Opus 5.5',
    defaultId: 'claude-opus-5-5-low',
    defaultEffort: 'low',
    efforts: [
      { level: 'low', id: 'claude-opus-5-5-low' },
      { level: 'medium', id: 'claude-opus-5-5-medium' },
      { level: 'high', id: 'claude-opus-5-5-high' },
    ],
  },
  {
    name: 'Orchestrator (Neon)',
    defaultId: 'gemini-pro-orchestrator-neon',
    efforts: [],
  },
];

/** @param {'claude' | 'codex' | 'agy'} agent @returns {import('../public/model/herdr.js').HerdrLayout} */
const runningIn = (agent) => ({
  herdr: true,
  workspaces: [
    {
      id: 'w2',
      number: 1,
      label: 'web',
      status: 'idle',
      activeTab: 'w2:t1',
      tabs: [{ id: 'w2:t1', number: 1, label: 'shop', status: 'idle', panes: [{ id: 'w2:p1', agent, status: 'idle', title: undefined, session, size: undefined, activity: undefined }] }],
    },
  ],
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Mount a picker in the document body, recording every `/model <id>` sent and every catalog load.
 * @param {{ takes?: boolean, models?: readonly import('../public/model/agy-models.js').AgyModel[] }} [options]
 */
function pickerOf({ takes = true, models = catalog } = {}) {
  /** @type {string[]} */
  const sent = [];
  let loads = 0;
  let activeChanges = 0;
  let opens = 0;
  const host = window.document.createElement('header');
  const picker = createAgyModelPicker(session, {
    load: async () => {
      loads += 1;
      return models;
    },
    set: async (modelId) => {
      sent.push(modelId);
      return takes;
    },
    onActiveChange: () => {
      activeChanges += 1;
    },
    onOpen: () => {
      opens += 1;
    },
  });
  host.append(picker.trigger, picker.panel);
  window.document.body.append(host);
  const effortButtons = () => [...picker.panel.querySelectorAll('.agy-effort-section button.segment')];
  const pressedEffort = () => effortButtons().filter((one) => one.getAttribute('aria-pressed') === 'true').map((one) => one.textContent);
  const pressedModel = () => [...picker.panel.querySelectorAll('button.agy-model-option[aria-pressed="true"] .agy-model-name')].map((one) => one.textContent);
  /** @param {string} level */
  const clickEffort = (level) => {
    const button = effortButtons().find((one) => one.textContent === level);
    assert.ok(button instanceof window.HTMLButtonElement, `no effort button ${level}`);
    button.click();
  };
  /** @param {string} name */
  const clickModel = (name) => {
    const button = [...picker.panel.querySelectorAll('button.agy-model-option')].find((one) => one.querySelector('.agy-model-name')?.textContent === name);
    assert.ok(button instanceof window.HTMLButtonElement, `no model button ${name}`);
    button.click();
  };
  const cleanup = () => {
    picker.dispose();
    host.remove();
  };
  return { picker, sent, loads: () => loads, activeChanges: () => activeChanges, opens: () => opens, effortButtons, pressedEffort, pressedModel, clickEffort, clickModel, cleanup };
}

// The header picker appears only for a live agy session in herdr, loads models lazily when opened, filters effort
// buttons to what the active model supports, switches effort and model optimistically via `/model <slug>`, skips
// no-op clicks, and hides efforts for models without effort (Orchestrators)
test('agyModelPicker_Should_ShowOnlyForLiveAgy_LoadModelsOnOpen_AndSwitchEffortAndModelOptimistically', async (t) => {
  const ctx = pickerOf();
  t.after(ctx.cleanup);

  ctx.picker.show(runningIn('claude'));
  const inClaude = ctx.picker.trigger.hidden;
  ctx.picker.show(runningIn('agy'));
  ctx.picker.showCurrent('Gemini 4 Hydrogen', 'high');
  const triggerBefore = ctx.picker.trigger.textContent;
  const loadsBeforeOpen = ctx.loads();

  ctx.picker.trigger.click();
  await settled();
  const hydrogenEfforts = ctx.effortButtons().map((one) => one.textContent);

  // Clicking already-active effort is a no-op
  ctx.clickEffort('high');
  await settled();
  // Switching effort to xhigh sends the exact xhigh slug and lights it immediately
  ctx.clickEffort('xhigh');
  const afterXhighTrigger = ctx.picker.trigger.textContent;
  const afterXhighPressed = ctx.pressedEffort();
  await settled();
  // Switching from xhigh to Claude Opus 5.5 picks high (nearest supported), updating effort buttons to low..high
  ctx.clickModel('Claude Opus 5.5');
  const opusEfforts = ctx.effortButtons().map((one) => one.textContent);
  const opusPressed = { model: ctx.pressedModel(), effort: ctx.pressedEffort() };
  await settled();
  // Switching to Orchestrator hides the effort section altogether
  ctx.clickModel('Orchestrator (Neon)');
  const effortSection = ctx.picker.panel.querySelector('.agy-effort-section');
  const orchestratorEffortHidden = effortSection instanceof window.HTMLElement && effortSection.hidden;
  await settled();
  // Confirming via session status keeps the active state clean
  ctx.picker.showCurrent('Orchestrator (Neon)', undefined);

  assert.deepEqual(
    {
      inClaude,
      inAgy: !ctx.picker.trigger.hidden,
      activeChanges: ctx.activeChanges(),
      opens: ctx.opens(),
      loadsBeforeOpen,
      loadsAfterOpen: ctx.loads(),
      triggerBefore,
      hydrogenEfforts,
      afterXhighTrigger,
      afterXhighPressed,
      opusEfforts,
      opusPressed,
      orchestratorEffortHidden,
      sent: ctx.sent,
    },
    {
      inClaude: true,
      inAgy: true,
      activeChanges: 1,
      opens: 1,
      loadsBeforeOpen: 0,
      loadsAfterOpen: 1,
      triggerBefore: 'Gemini 4 Hydrogenhigh',
      hydrogenEfforts: ['low', 'medium', 'high', 'xhigh'],
      afterXhighTrigger: 'Gemini 4 Hydrogenxhigh',
      afterXhighPressed: ['xhigh'],
      opusEfforts: ['low', 'medium', 'high'],
      opusPressed: { model: ['Claude Opus 5.5'], effort: ['high'] },
      orchestratorEffortHidden: true,
      sent: ['gemini-4-hydrogen-xhigh', 'claude-opus-5-5-high', 'gemini-pro-orchestrator-neon'],
    },
  );
});

// When the terminal refuses `/model <id>`, the picker reverts to the session's real model and effort and reports the
// refusal; a late refusal from an earlier click does not undo a newer selection
test('agyModelPicker_Should_RevertOnRefusal_AndIgnoreStaleRefusalAfterNewerPick', async (t) => {
  const refused = pickerOf({ takes: false });
  t.after(refused.cleanup);
  refused.picker.show(runningIn('agy'));
  refused.picker.showCurrent('Gemini 4 Hydrogen', 'high');
  refused.picker.trigger.click();
  await settled();

  refused.clickEffort('xhigh');
  await settled();
  const afterRefusal = {
    trigger: refused.picker.trigger.textContent,
    pressedEffort: refused.pressedEffort(),
    status: refused.picker.panel.querySelector('[role="status"]')?.textContent,
  };

  // Race: first pick hangs and later fails, while a second pick succeeds in the meantime
  /** @type {((ok: boolean) => void) | undefined} */
  let finishFirst;
  const host = window.document.createElement('header');
  let call = 0;
  const race = createAgyModelPicker(session, {
    load: async () => catalog,
    set: () => {
      call += 1;
      if (call === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve(true);
    },
  });
  host.append(race.trigger, race.panel);
  window.document.body.append(host);
  t.after(() => {
    race.dispose();
    host.remove();
  });
  race.show(runningIn('agy'));
  race.showCurrent('Gemini 4 Hydrogen', 'high');
  race.trigger.click();
  await settled();
  const pickOption = (/** @type {string} */ name) => {
    const button = [...race.panel.querySelectorAll('button.agy-model-option')].find((one) => one.querySelector('.agy-model-name')?.textContent === name);
    assert.ok(button instanceof window.HTMLButtonElement);
    button.click();
  };
  pickOption('Claude Opus 5.5');
  pickOption('Orchestrator (Neon)');
  await settled();
  finishFirst?.(false);
  await settled();

  assert.deepEqual(
    {
      afterRefusal,
      raceTrigger: race.trigger.textContent,
      raceStatus: race.panel.querySelector('[role="status"]')?.textContent,
    },
    {
      afterRefusal: {
        trigger: 'Gemini 4 Hydrogenhigh',
        pressedEffort: ['high'],
        status: 'Not set — the terminal did not take /model gemini-4-hydrogen-xhigh',
      },
      raceTrigger: 'Orchestrator (Neon)',
      raceStatus: '',
    },
  );
});

// Clicking inside the popover keeps it open so the user can change both model and effort in one go; clicking outside
// or pressing Escape closes it, and switching off agy hides and closes it
test('agyModelPicker_Should_StayOpenOnInsideClick_AndCloseOnOutsidePointerDownOrEscape', async (t) => {
  const ctx = pickerOf();
  t.after(ctx.cleanup);
  ctx.picker.show(runningIn('agy'));
  ctx.picker.showCurrent('Gemini 4 Hydrogen', 'high');

  ctx.picker.trigger.click();
  await settled();
  const openAfterTrigger = !ctx.picker.panel.hidden && ctx.picker.trigger.getAttribute('aria-expanded') === 'true';

  ctx.picker.panel.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  const openAfterInside = !ctx.picker.panel.hidden;

  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  const openAfterOutside = !ctx.picker.panel.hidden;

  ctx.picker.trigger.click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const openAfterEscape = !ctx.picker.panel.hidden;

  ctx.picker.trigger.click();
  ctx.picker.show(runningIn('claude'));
  const openAfterLeavingAgy = !ctx.picker.panel.hidden;

  assert.deepEqual(
    { openAfterTrigger, openAfterInside, openAfterOutside, openAfterEscape, openAfterLeavingAgy },
    { openAfterTrigger: true, openAfterInside: true, openAfterOutside: false, openAfterEscape: false, openAfterLeavingAgy: false },
  );
});
