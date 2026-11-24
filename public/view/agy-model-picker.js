// @ts-check
// Header chip and floating popover for choosing an Antigravity CLI (agy) session's model and reasoning effort without
// opening agy's interactive /model dialog: clicking a model or effort types `/model <slug>` straight into the terminal
// and lights it at once until the session's status confirms it. Shown only while the session runs in agy in a herdr tab.
import { findAgyModel, parseAgyEffort, pickAgyEffort, pickAgyModel } from '../model/agy-models.js';
import { placeOf } from '../model/herdr.js';
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * @typedef {import('../model/agy-models.js').AgyEffort} AgyEffort
 * @typedef {import('../model/agy-models.js').AgyModel} AgyModel
 * @typedef {import('../model/agy-models.js').AgySelection} AgySelection
 */

/**
 * Subtle right-aligned hint of a model's effort choices inside the popover (e.g. "low–xhigh" or "medium").
 * @param {AgyModel} model
 * @returns {string}
 */
function effortHint(model) {
  const first = model.efforts[0];
  const last = model.efforts.at(-1);
  if (first === undefined || last === undefined) return '';
  return first.level === last.level ? first.level : `${first.level}–${last.level}`;
}

/**
 * @param {string} sessionId
 * @param {{ load: () => Promise<readonly AgyModel[]>, set: (modelId: string) => Promise<boolean>, onActiveChange?: () => void, onOpen?: () => void }} deps
 * @returns {{ trigger: HTMLButtonElement, panel: HTMLElement, show: (layout: import('../model/herdr.js').HerdrLayout) => void, showCurrent: (model: string | undefined, effort: string | undefined) => void, close: () => void, dispose: () => void }}
 */
export function createAgyModelPicker(sessionId, { load, set, onActiveChange, onOpen }) {
  /** What the session currently runs on, as reported by its status. @type {{ model: string | undefined, effort: AgyEffort | undefined }} */
  let current = { model: undefined, effort: undefined };
  /** Optimistic target sent to the terminal, until confirmed or rejected. @type {AgySelection | undefined} */
  let asked;
  /** Models fetched from `/api/agy/models`. @type {readonly AgyModel[]} */
  let catalog = [];
  let loading = false;
  let loadedOnce = false;
  let active = false;

  const trigger = h('button', {
    className: 'fact fact-model fact-model-pick',
    title: 'Choose model and effort',
    attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', hidden: '' },
  });
  const effortButtons = h('span', { className: 'segments', attrs: { role: 'group', 'aria-label': 'Effort of this session' } });
  const effortSection = h('div', { className: 'agy-effort-section', attrs: { hidden: '' } }, [
    h('span', { className: 'agy-picker-label', text: 'Effort' }),
    effortButtons,
  ]);
  const modelList = h('div', { className: 'agy-model-list', attrs: { role: 'group', 'aria-label': 'Models' } });
  const emptyNote = h('div', { className: 'agy-picker-empty', attrs: { hidden: '' } });
  const status = h('div', { className: 'agy-picker-status', attrs: { role: 'status' } });
  const panel = h('div', { className: 'agy-model-popover', attrs: { role: 'dialog', 'aria-label': 'Choose model and effort', hidden: '' } }, [
    effortSection,
    h('div', { className: 'agy-models-section' }, [
      h('span', { className: 'agy-picker-label', text: 'Model' }),
      emptyNote,
      modelList,
    ]),
    status,
  ]);

  const shown = () => (asked !== undefined ? { model: asked.model, effort: asked.effort } : current);

  const drawTrigger = () => {
    const state = shown();
    const parts = [icon('model'), h('span', { text: state.model ?? 'Model' })];
    if (state.effort !== undefined) parts.push(h('span', { className: 'fact-dim', text: state.effort }));
    parts.push(h('span', { className: 'fact-caret' }, [icon('chevron')]));
    trigger.replaceChildren(...parts);
  };

  /** @param {AgySelection} target */
  const apply = (target) => {
    const state = shown();
    if (target.model === state.model && target.effort === state.effort) return;
    asked = target;
    status.textContent = '';
    draw();
    void set(target.id)
      .catch(() => false)
      .then((taken) => {
        if (taken || asked !== target) return;
        asked = undefined;
        status.textContent = `Not set — the terminal did not take /model ${target.id}`;
        draw();
      });
  };

  const drawPanel = () => {
    const state = shown();
    const activeModel = findAgyModel(catalog, state.model);
    const efforts = activeModel?.efforts ?? [];
    effortSection.hidden = efforts.length <= 1;
    effortButtons.replaceChildren(
      ...efforts.map((variant) => {
        const button = h('button', {
          className: 'segment',
          text: variant.level,
          title: `/model ${variant.id}`,
          attrs: { type: 'button', 'aria-pressed': String(variant.level === state.effort) },
        });
        button.addEventListener('click', () => {
          if (activeModel === undefined) return;
          const next = pickAgyEffort(activeModel, variant.level);
          if (next !== undefined) apply(next);
        });
        return button;
      }),
    );

    if (catalog.length === 0) {
      emptyNote.hidden = false;
      emptyNote.textContent = loading ? 'Loading models…' : loadedOnce ? 'No models available.' : '';
      modelList.replaceChildren();
      return;
    }
    emptyNote.hidden = true;
    modelList.replaceChildren(
      ...catalog.map((model) => {
        const selected = activeModel?.name === model.name;
        const hint = effortHint(model);
        const button = h(
          'button',
          {
            className: 'agy-model-option',
            title: model.name,
            attrs: { type: 'button', 'aria-pressed': String(selected) },
          },
          [
            h('span', { className: 'agy-model-mark' }, selected ? [icon('check')] : []),
            h('span', { className: 'agy-model-name', text: model.name }),
            ...(hint === '' ? [] : [h('span', { className: 'agy-model-hint', text: hint })]),
          ],
        );
        button.addEventListener('click', () => apply(pickAgyModel(model, shown().effort)));
        return button;
      }),
    );
  };

  const draw = () => {
    drawTrigger();
    drawPanel();
  };

  /** Align the floating popover beneath the trigger chip inside its header container without overflowing. */
  const alignPanel = () => {
    const host = panel.parentElement;
    if (host === null) return;
    const hostRect = host.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    if (hostRect.width <= 0) return;
    const panelWidth = panel.offsetWidth || Math.min(340, hostRect.width - 16);
    const wantedLeft = triggerRect.left - hostRect.left;
    const maxLeft = Math.max(8, hostRect.width - panelWidth - 8);
    panel.style.left = `${Math.round(Math.min(Math.max(8, wantedLeft), maxLeft))}px`;
  };

  const ensureLoaded = () => {
    if (catalog.length > 0 || loading) return;
    loading = true;
    drawPanel();
    void load()
      .then((models) => {
        catalog = models;
      })
      .catch(() => undefined)
      .finally(() => {
        loading = false;
        loadedOnce = true;
        drawPanel();
        if (!panel.hidden) alignPanel();
      });
  };

  const close = () => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    onOpen?.();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    ensureLoaded();
    alignPanel();
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel.hidden) open();
    else close();
  });

  /** @param {PointerEvent} event */
  const onPointerDown = (event) => {
    if (panel.hidden) return;
    if (event.target instanceof window.Node && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  };
  /** @param {KeyboardEvent} event */
  const onKeyDown = (event) => {
    if (!panel.hidden && event.key === 'Escape') {
      close();
      trigger.focus();
    }
  };
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);

  draw();

  return {
    trigger,
    panel,
    show(layout) {
      const pane = placeOf(layout, { kind: 'session', id: sessionId })?.tab.panes.find((one) => one.session === sessionId);
      const nextActive = pane?.agent === 'agy';
      trigger.hidden = !nextActive;
      if (!nextActive) close();
      if (nextActive !== active) {
        active = nextActive;
        onActiveChange?.();
      }
    },
    showCurrent(model, effort) {
      const parsedEffort = parseAgyEffort(effort);
      current = { model, effort: parsedEffort };
      if (asked !== undefined && asked.model === model && asked.effort === parsedEffort) asked = undefined;
      draw();
    },
    close,
    dispose() {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
