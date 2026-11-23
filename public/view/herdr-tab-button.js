// @ts-check
// The button over a session or terminal that takes herdr to its tab — the tab's workspace with it: there while the
// session or pane is in a herdr tab, none otherwise.
import { placeOf } from '../model/herdr.js';

/**
 * @param {HTMLButtonElement} button
 * @param {string | import('../model/herdr.js').Opened} target — a session's id, or what the page opened (session or pane)
 * @param {(tabId: string) => void} focus — herdr taken to the tab
 * @returns {(layout: import('../model/herdr.js').HerdrLayout) => void} — the button shown anew for what herdr has now
 */
export function herdrTabButton(button, target, focus) {
  /** @type {import('../model/herdr.js').Opened} */
  const opened = typeof target === 'string' ? { kind: 'session', id: target } : target;
  /** @type {string | undefined} */
  let tab;
  button.hidden = true;
  button.addEventListener('click', () => {
    if (tab !== undefined) focus(tab);
  });
  return (layout) => {
    tab = placeOf(layout, opened)?.tab.id;
    button.hidden = tab === undefined;
  };
}
