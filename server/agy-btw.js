// @ts-check
// A side question from the page, as Antigravity CLI's (agy) own /btw: agy answers from the conversation without adding
// to it, showing the answer in a heavy-bar (┃) overlay directly above its prompt box — works before the first message,
// while idle, and while a main turn is running. Long answers start truncated (`... (truncated) — Tab to expand`) and
// expand on Tab into a scrollable viewport (`↑/↓ to scroll (start-end of total)`). Enter on an empty box dismisses the
// overlay cleanly without ever interrupting a main turn in progress.
import { settleOn, squash } from './claude-screen.js';
import { agyBoxBounds, agyInputBox } from './agy-screen.js';

/**
 * @typedef {{ start: number, end: number, total: number }} ScrollRange — 1-based line range in agy's expanded /btw view
 * @typedef {{ state: 'answering' } | { state: 'answered', lines: readonly string[], width: number, truncated: boolean, range: ScrollRange | undefined }} AgySidePanel
 */

/** A line of agy's /btw overlay: optional indent, heavy vertical bar ┃, then content. */
const barLine = /^\s*┃(.*)$/;
/** Queued message / sending lines that may sit between the /btw overlay and the prompt box's top rule while busy. */
const queueBelow = /^\s*(?:▸|⎿)\s/;
/** Footer of a finished /btw overlay in agy. */
const dismissFooter = /\bEnter\/Esc to dismiss\s*$/;
/** Working indicator inside an answering /btw overlay. */
const cancelWorking = /\(Enter\/Esc to cancel\)\s*$/;
/** Truncated preview cue before pressing Tab. */
const truncatedCue = /\.\.\.\s*\(truncated\)/;
/** Scroll range indicator in an expanded /btw overlay: e.g. "↑/↓ to scroll (1-31 of 35)". */
const scrollRange = /↑\/↓ to scroll \((\d+)-(\d+) of (\d+)\)/;
/** Box-drawing characters a table line starts with, and bullet/numbered list starts — never joined onto a previous line. */
const tableLine = /^\s*[┌│├└]/;
const listLine = /^\s*(?:[•*-]|\d+\.)\s/;

/** The overlay indents body prose by 5 cols (" ┃   ") and leaves 2 cols of right margin against the prompt box rule. */
const panelChromeCols = 7;
/** A side answer takes as long as agy thinks: up to a few minutes. */
const answerStepMs = 500;
const answerLooks = 360;
/** After ↓ or Tab the overlay redraws within a frame or two. */
const scrollStepMs = 100;
const scrollLooks = 8;
/** Safety cap on scroll iterations. */
const maxScrolls = 200;

/**
 * Ask a side question in agy's terminal via /btw, expand/scroll if needed, unwrap wrapped prose lines, and dismiss the
 * overlay with Enter so the terminal is left clean.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {{ question: string, wait: (ms: number) => Promise<void> }} options
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
export async function driveAgyBtw(terminal, { question, wait }) {
  const asked = question.replace(/\s+/g, ' ').trim();
  const screen = await withAgyBtwClosed(terminal, wait);
  const box = screen === undefined ? undefined : agyInputBox(screen);
  if (box === undefined) return { ok: false, error: 'screen-unreadable' };
  if (box !== '') return { ok: false, error: 'box-not-empty' };
  const command = `/btw ${asked}`;
  await terminal.text(command);
  await settleOn(terminal, wait, (next) => holdsCommand(agyInputBox(next), command));
  await terminal.keys('enter');
  if ((await settleOn(terminal, wait, (next) => agySidePanel(next, asked) !== undefined)) === undefined) return { ok: false, error: 'not-asked' };
  return answerOf(terminal, wait, asked);
}

/**
 * Read the answer of a /btw question already open in agy's terminal (e.g. after a reload or reconnect): nothing is
 * typed, and nothing is pressed if no overlay for that question is open.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {{ question: string, wait: (ms: number) => Promise<void> }} options
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
export async function readAgyBtw(terminal, { question, wait }) {
  const asked = question.replace(/\s+/g, ' ').trim();
  const screen = await terminal.read();
  if (screen === undefined || agySidePanel(screen, asked) === undefined) return { ok: false, error: 'panel-closed' };
  return answerOf(terminal, wait, asked);
}

/**
 * Dismiss an open agy /btw overlay with Enter — ONLY while the prompt box is empty (so a draft is never submitted, and
 * a main turn in progress is never interrupted). With no overlay open, presses nothing.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @returns {Promise<string | undefined>}
 */
export async function withAgyBtwClosed(terminal, wait) {
  const screen = await terminal.read();
  if (screen === undefined || !hasAgyBtwPanel(screen) || agyInputBox(screen) !== '') return screen;
  await terminal.keys('enter');
  return (await settleOn(terminal, wait, (next) => !hasAgyBtwPanel(next))) ?? (await terminal.read());
}

/**
 * Wait for agy's open /btw overlay to finish answering, expand if truncated, scroll through all pages if taller than
 * the viewport, dismiss with Enter, and return the unwrapped text.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} asked
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
async function answerOf(terminal, wait, asked) {
  const first = await answerShown(terminal, wait, asked);
  if (first === undefined) {
    await closePanel(terminal, wait, asked);
    return { ok: false, error: 'no-answer' };
  }
  const expanded = first.truncated ? (await expandPanel(terminal, wait, asked)) ?? first : first;
  const lines = await readToEnd(terminal, wait, asked, expanded);
  await closePanel(terminal, wait, asked);
  if (lines === undefined) return { ok: false, error: 'answer-unreadable' };
  return { ok: true, answer: unwrapped(withoutBlankEnds(lines), expanded.width).join('\n') };
}

/**
 * Parse agy's /btw heavy-bar (┃) overlay directly above the prompt box for `question`; undefined when absent or for
 * another question.
 * @param {string} screen
 * @param {string} question
 * @returns {AgySidePanel | undefined}
 */
export function agySidePanel(screen, question) {
  const block = panelBlock(screen);
  if (block === undefined) return undefined;
  const { content, width } = block;
  if (!(content[0] ?? '').trimStart().startsWith('/btw')) return undefined;
  // header may wrap across multiple ┃ lines until the blank ┃ separator line
  const blankAt = content.findIndex((line, at) => at > 0 && line.trim() === '');
  if (blankAt < 0) return undefined;
  const echoed = squash(content.slice(0, blankAt).join(' '));
  const asked = squash(`/btw ${question}`);
  if (echoed !== asked) return undefined;
  const rest = content.slice(blankAt + 1);
  if (rest.length === 0) return { state: 'answering' };
  const footer = rest.at(-1) ?? '';
  if (cancelWorking.test(footer) || !dismissFooter.test(footer)) return { state: 'answering' };
  const body = rest.slice(0, -1).map((line) => line.replace(/^ {1,3}/, '').trimEnd());
  const rangeMatch = scrollRange.exec(footer);
  const range = rangeMatch === null ? undefined : { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]), total: Number(rangeMatch[3]) };
  return { state: 'answered', lines: body, width, truncated: truncatedCue.test(footer), range };
}

/**
 * Whether any agy /btw overlay is currently drawn above the prompt box.
 * @param {string} screen
 */
function hasAgyBtwPanel(screen) {
  const block = panelBlock(screen);
  return block !== undefined && (block.content[0] ?? '').trimStart().startsWith('/btw');
}

/**
 * Contiguous block of `┃` lines directly above agy's prompt box (allowing blank or queued lines immediately below the
 * overlay) and the panel's body wrap width derived from the prompt box rule.
 * @param {string} screen
 * @returns {{ content: string[], width: number } | undefined}
 */
function panelBlock(screen) {
  const lines = screen.split('\n');
  const box = agyBoxBounds(lines);
  if (box === undefined) return undefined;
  let end = box.top - 1;
  while (end >= 0 && ((lines[end] ?? '').trim() === '' || queueBelow.test(lines[end] ?? ''))) end -= 1;
  if (end < 0 || !barLine.test(lines[end] ?? '')) return undefined;
  let start = end;
  while (start > 0 && barLine.test(lines[start - 1] ?? '')) start -= 1;
  const content = lines.slice(start, end + 1).map((line) => barLine.exec(line)?.[1] ?? '');
  const ruleWidth = [...(lines[box.top] ?? '').trimEnd()].length;
  return { content, width: Math.max(10, ruleWidth - panelChromeCols) };
}

/**
 * Press Enter to close agy's /btw overlay ONLY while the overlay for `question` is still open and the prompt box is empty.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} question
 */
async function closePanel(terminal, wait, question) {
  const screen = await terminal.read();
  if (screen === undefined || agySidePanel(screen, question) === undefined || agyInputBox(screen) !== '') return;
  await terminal.keys('enter');
  await settleOn(terminal, wait, (next) => agySidePanel(next, question) === undefined);
}

/**
 * Poll until agy's /btw overlay reaches the answered state, disappears, or times out.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} question
 * @returns {Promise<Extract<AgySidePanel, { state: 'answered' }> | undefined>}
 */
async function answerShown(terminal, wait, question) {
  for (let look = 0; look < answerLooks; look++) {
    const screen = await terminal.read();
    const panel = screen === undefined ? undefined : agySidePanel(screen, question);
    if (panel?.state === 'answered') return panel;
    if (panel === undefined) return undefined;
    await wait(answerStepMs);
  }
  return undefined;
}

/**
 * Press Tab to expand a truncated /btw overlay and wait until the expanded view is drawn.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} question
 * @returns {Promise<Extract<AgySidePanel, { state: 'answered' }> | undefined>}
 */
async function expandPanel(terminal, wait, question) {
  await terminal.keys('tab');
  for (let look = 0; look < scrollLooks; look++) {
    const screen = await terminal.read();
    const panel = screen === undefined ? undefined : agySidePanel(screen, question);
    if (panel?.state === 'answered' && !panel.truncated) return panel;
    await wait(scrollStepMs);
  }
  return undefined;
}

/**
 * Read every line of an expanded /btw overlay: if the footer shows `↑/↓ to scroll (start-end of total)` with more lines
 * below `end`, press `down` in page-sized steps and stitch by exact 1-based line offset (or overlap fallback).
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} question
 * @param {Extract<AgySidePanel, { state: 'answered' }>} first
 * @returns {Promise<readonly string[] | undefined>}
 */
async function readToEnd(terminal, wait, question, first) {
  /** @type {string[]} */
  const all = [...first.lines];
  let view = first;
  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    const range = view.range;
    if (range === undefined || range.end >= range.total) return all;
    const windowSize = Math.max(1, range.end - range.start + 1);
    const remaining = range.total - range.end;
    const step = Math.min(remaining, Math.max(1, windowSize - 2));
    await terminal.keys(...Array.from({ length: step }, () => 'down'));
    const next = await nextScrolledView(terminal, wait, question, view);
    if (next === undefined) return all;
    const added = stitchedTail(all, view, next);
    if (added === undefined) return undefined;
    all.push(...added);
    view = next;
  }
  return all;
}

/**
 * Lines from `next` that follow what `all` already holds: uses `next.range.start` when consistent, else line overlap.
 * @param {readonly string[]} all
 * @param {Extract<AgySidePanel, { state: 'answered' }>} before
 * @param {Extract<AgySidePanel, { state: 'answered' }>} next
 * @returns {readonly string[] | undefined}
 */
function stitchedTail(all, before, next) {
  if (next.range !== undefined) {
    const offset = all.length - (next.range.start - 1);
    if (offset >= 0 && offset <= next.lines.length) return next.lines.slice(offset);
  }
  const overlap = overlapOf(before.lines, next.lines);
  return overlap === 0 ? undefined : next.lines.slice(overlap);
}

/**
 * Wait for the expanded viewport to advance after pressing `down`.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} question
 * @param {Extract<AgySidePanel, { state: 'answered' }>} view
 * @returns {Promise<Extract<AgySidePanel, { state: 'answered' }> | undefined>}
 */
async function nextScrolledView(terminal, wait, question, view) {
  for (let look = 0; look < scrollLooks; look++) {
    const screen = await terminal.read();
    const panel = screen === undefined ? undefined : agySidePanel(screen, question);
    if (panel?.state === 'answered' && (panel.range?.start !== view.range?.start || !sameLines(panel.lines, view.lines))) return panel;
    await wait(scrollStepMs);
  }
  return undefined;
}

/**
 * Whether agy's prompt box already shows the tail of the `/btw …` command typed into it.
 * @param {string | undefined} box
 * @param {string} command
 */
function holdsCommand(box, command) {
  return box !== undefined && (/\[Pasted (text|Content)/.test(box) || squash(box).includes(squash(command).slice(-24)));
}

/**
 * How many lines at the start of `next` repeat the end of `before`.
 * @param {readonly string[]} before
 * @param {readonly string[]} next
 */
function overlapOf(before, next) {
  for (let size = Math.min(before.length, next.length - 1); size > 0; size--) {
    if (sameLines(before.slice(before.length - size), next.slice(0, size))) return size;
  }
  return 0;
}

/** @param {readonly string[]} a @param {readonly string[]} b */
function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** @param {readonly string[]} lines */
function withoutBlankEnds(lines) {
  const first = lines.findIndex((line) => line !== '');
  const last = lines.findLastIndex((line) => line !== '');
  return first < 0 ? [] : lines.slice(first, last + 1);
}

/**
 * Rejoin lines soft-wrapped by agy's /btw overlay at `width`, leaving blank lines, tables, and list starts separate.
 * @param {readonly string[]} lines
 * @param {number} width
 * @returns {string[]}
 */
function unwrapped(lines, width) {
  /** @type {string[]} */
  const joined = [];
  lines.forEach((line, index) => {
    const before = lines[index - 1];
    const word = line.trimStart().split(/\s/, 1)[0] ?? '';
    const wrapped = before !== undefined && before !== '' && word !== '' && !tableLine.test(before) && !tableLine.test(line) && !listLine.test(line) && [...before].length + 1 + [...word].length > width;
    if (wrapped) joined.push(`${joined.pop() ?? ''} ${line.trimStart()}`);
    else joined.push(line);
  });
  return joined;
}
