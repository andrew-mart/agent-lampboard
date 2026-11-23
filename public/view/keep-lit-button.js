// @ts-check
// The button over a session or terminal that keeps its agent lit to come back to (model/lamps.js: keptLit): a press
// marks it, the next takes the mark off; pressed while the mark holds — the agent changing state ends it. There while
// an agent runs the session or pane in herdr, none otherwise.
import { keptNow } from '../model/lamps.js';

/**
 * @param {HTMLButtonElement} button
 * @param {string | import('../model/herdr.js').Opened} target — a session's id, or what the page opened (session or pane)
 * @param {(pane: import('../model/herdr.js').HerdrPane) => void} toggle — the agent marked, or its mark taken off
 * @returns {(layout: import('../model/herdr.js').HerdrLayout, kept: import('../model/lamps.js').KeptPanes) => void} —
 *   the button shown anew for what herdr has and what is kept lit now
 */
export function keepLitButton(button, target, toggle) {
  /** @type {import('../model/herdr.js').Opened} */
  const opened = typeof target === 'string' ? { kind: 'session', id: target } : target;
  /** @type {import('../model/herdr.js').HerdrPane | undefined} */
  let pane;
  button.hidden = true;
  button.addEventListener('click', () => {
    if (pane !== undefined) toggle(pane);
  });
  return (layout, kept) => {
    pane = layout.workspaces
      .flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes))
      .find((one) => (opened.kind === 'session' ? one.session === opened.id : one.id === opened.id && one.agent !== undefined));
    button.hidden = pane === undefined;
    button.setAttribute('aria-pressed', String(pane !== undefined && keptNow(pane, kept)));
  };
}
