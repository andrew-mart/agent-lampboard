// @ts-check
// A side question from the page, as Antigravity CLI's (agy) own /btw: agy answers from the conversation without adding
// to it, showing the answer in a heavy-bar (┃) overlay directly above its prompt box — works before the first message,
// while idle, and while a main turn is running. Long answers start truncated (`... (truncated) — Tab to expand`) and
// expand on Tab into a scrollable viewport (`↑/↓ to scroll (start-end of total)`). Enter on an empty box dismisses the
// overlay cleanly without ever interrupting a main turn in progress. When a styled ANSI read is supplied, agy's SGR
// formatting (bold headings/prose, italic, color-12 inline code, syntax-highlighted code blocks, bullets) is recovered
// back into Markdown for the web page.
import { plainScreen, settleOn, squash } from './claude-screen.js';
import { agyBoxBounds, agyInputBox } from './agy-screen.js';

/**
 * @typedef {{ start: number, end: number, total: number }} ScrollRange — 1-based line range in agy's expanded /btw view
 * @typedef {{ state: 'answering' } | { state: 'answered', lines: readonly string[], width: number, truncated: boolean, range: ScrollRange | undefined }} AgySidePanel
 * @typedef {{ plain: string, ansi: string | undefined }} StyledLine
 * @typedef {{ text: string, bold: boolean, italic: boolean, fg: number | undefined }} AnsiRun
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
/** Lines never joined onto an adjacent line during soft-wrap unwrapping. */
const tableLine = /^\s*[┌│├└]/;
const listLine = /^\s*(?:[•*-]|\d+\.)\s/;
const headingLine = /^\s*#{1,6}\s/;
/** ANSI SGR escape sequence. */
const sgrToken = /\x1b\[([0-9;]*)m/g;

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
 * Ask a side question in agy's terminal via /btw, expand/scroll if needed, recover Markdown from ANSI when available,
 * unwrap wrapped prose lines, and dismiss the overlay with Enter so the terminal is left clean.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {{ question: string, wait: (ms: number) => Promise<void>, styled?: () => Promise<string | undefined> }} options
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
export async function driveAgyBtw(terminal, { question, wait, styled }) {
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
  return answerOf(terminal, wait, asked, styled);
}

/**
 * Read the answer of a /btw question already open in agy's terminal (e.g. after a reload or reconnect): nothing is
 * typed, and nothing is pressed if no overlay for that question is open.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {{ question: string, wait: (ms: number) => Promise<void>, styled?: () => Promise<string | undefined> }} options
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
export async function readAgyBtw(terminal, { question, wait, styled }) {
  const asked = question.replace(/\s+/g, ' ').trim();
  const screen = await terminal.read();
  if (screen === undefined || agySidePanel(screen, asked) === undefined) return { ok: false, error: 'panel-closed' };
  return answerOf(terminal, wait, asked, styled);
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
 * the viewport, dismiss with Enter, and return the unwrapped (and Markdown-recovered) text.
 * @param {import('./claude-screen.js').Terminal} terminal
 * @param {(ms: number) => Promise<void>} wait
 * @param {string} asked
 * @param {(() => Promise<string | undefined>) | undefined} styled
 * @returns {Promise<import('./btw.js').BtwOutcome>}
 */
async function answerOf(terminal, wait, asked, styled) {
  const first = await answerShown(terminal, wait, asked);
  if (first === undefined) {
    await closePanel(terminal, wait, asked);
    return { ok: false, error: 'no-answer' };
  }
  const expanded = first.truncated ? (await expandPanel(terminal, wait, asked)) ?? first : first;
  const lines = await readToEnd(terminal, wait, asked, expanded, styled);
  await closePanel(terminal, wait, asked);
  if (lines === undefined) return { ok: false, error: 'answer-unreadable' };
  return { ok: true, answer: styledLinesToMarkdown(unwrappedStyled(withoutBlankEnds(lines), expanded.width)).join('\n') };
}

/**
 * Parse agy's /btw heavy-bar (┃) overlay directly above the prompt box for `question`; undefined when absent or for
 * another question.
 * @param {string} screen
 * @param {string} question
 * @returns {AgySidePanel | undefined}
 */
export function agySidePanel(screen, question) {
  const block = panelBlock(screen.split('\n'));
  if (block === undefined) return undefined;
  const parsed = parsePanelBlock(block, question);
  if (parsed === undefined) return undefined;
  if (parsed.state === 'answering') return { state: 'answering' };
  return { state: 'answered', lines: parsed.lines, width: block.width, truncated: parsed.truncated, range: parsed.range };
}

/**
 * Extract the answered body's raw ANSI lines (with overlay prefix stripped) when the visible ANSI screen shows the
 * matching finished /btw overlay.
 * @param {string} ansiScreen
 * @param {string} question
 * @returns {string[] | undefined}
 */
function extractStyledBody(ansiScreen, question) {
  const ansiLines = ansiScreen.replace(/\r?\n$/, '').split(/\r?\n/);
  const plainLines = plainScreen(ansiScreen).replace(/\n$/, '').split('\n');
  if (ansiLines.length !== plainLines.length) return undefined;
  const block = panelBlock(plainLines);
  if (block === undefined) return undefined;
  const parsed = parsePanelBlock(block, question);
  if (parsed === undefined || parsed.state !== 'answered') return undefined;
  const bodyStart = block.start + parsed.bodyOffset;
  const bodyEnd = block.end; // exclusive of footer line at block.end
  return ansiLines.slice(bodyStart, bodyEnd).map(stripOverlayPrefix);
}

/**
 * Validate a `┃` block against `question` and classify it as answering or answered.
 * @param {{ start: number, end: number, content: string[], width: number }} block
 * @param {string} question
 * @returns {{ state: 'answering' } | { state: 'answered', lines: string[], bodyOffset: number, truncated: boolean, range: ScrollRange | undefined } | undefined}
 */
function parsePanelBlock(block, question) {
  const { content } = block;
  if (!(content[0] ?? '').trimStart().startsWith('/btw')) return undefined;
  const blankAt = content.findIndex((line, at) => at > 0 && line.trim() === '');
  if (blankAt < 0) return undefined;
  const echoed = squash(content.slice(0, blankAt).join(' '));
  const asked = squash(`/btw ${question}`);
  if (echoed !== asked) return undefined;
  const rest = content.slice(blankAt + 1);
  if (rest.length === 0) return { state: 'answering' };
  const footer = rest.at(-1) ?? '';
  if (cancelWorking.test(footer) || !dismissFooter.test(footer)) return { state: 'answering' };
  const lines = rest.slice(0, -1).map((line) => line.replace(/^ {1,3}/, '').trimEnd());
  const rangeMatch = scrollRange.exec(footer);
  const range = rangeMatch === null ? undefined : { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]), total: Number(rangeMatch[3]) };
  return { state: 'answered', lines, bodyOffset: blankAt + 1, truncated: truncatedCue.test(footer), range };
}

/**
 * Whether any agy /btw overlay is currently drawn above the prompt box.
 * @param {string} screen
 */
function hasAgyBtwPanel(screen) {
  const block = panelBlock(screen.split('\n'));
  return block !== undefined && (block.content[0] ?? '').trimStart().startsWith('/btw');
}

/**
 * Contiguous block of `┃` lines directly above agy's prompt box (allowing blank or queued lines immediately below the
 * overlay) and the panel's body wrap width derived from the prompt box rule.
 * @param {readonly string[]} lines
 * @returns {{ start: number, end: number, content: string[], width: number } | undefined}
 */
function panelBlock(lines) {
  const box = agyBoxBounds(lines);
  if (box === undefined) return undefined;
  let end = box.top - 1;
  while (end >= 0 && ((lines[end] ?? '').trim() === '' || queueBelow.test(lines[end] ?? ''))) end -= 1;
  if (end < 0 || !barLine.test(lines[end] ?? '')) return undefined;
  let start = end;
  while (start > 0 && barLine.test(lines[start - 1] ?? '')) start -= 1;
  const content = lines.slice(start, end + 1).map((line) => barLine.exec(line)?.[1] ?? '');
  const ruleWidth = [...(lines[box.top] ?? '').trimEnd()].length;
  return { start, end, content, width: Math.max(10, ruleWidth - panelChromeCols) };
}

/**
 * Pair plain body lines with their ANSI counterparts from `styled()`, falling back to plain lines whenever the styled
 * read is absent, scrolled away, or out of sync with the plain frame.
 * @param {(() => Promise<string | undefined>) | undefined} styled
 * @param {string} question
 * @param {readonly string[]} plainLines
 * @returns {Promise<StyledLine[]>}
 */
async function captureStyled(styled, question, plainLines) {
  if (styled === undefined) return plainLines.map((plain) => ({ plain, ansi: undefined }));
  const raw = await styled();
  const ansiBody = raw === undefined ? undefined : extractStyledBody(raw, question);
  const aligned =
    ansiBody !== undefined &&
    ansiBody.length === plainLines.length &&
    ansiBody.every((ansi, i) => plainScreen(ansi).trimEnd() === plainLines[i]);
  return plainLines.map((plain, i) => ({ plain, ansi: aligned ? ansiBody[i] : undefined }));
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
 * @param {(() => Promise<string | undefined>) | undefined} styled
 * @returns {Promise<readonly StyledLine[] | undefined>}
 */
async function readToEnd(terminal, wait, question, first, styled) {
  /** @type {StyledLine[]} */
  const all = await captureStyled(styled, question, first.lines);
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
    const nextStyled = await captureStyled(styled, question, next.lines);
    const tailOffset = stitchedOffset(all.length, view.lines, next);
    if (tailOffset === undefined) return undefined;
    all.push(...nextStyled.slice(tailOffset));
    view = next;
  }
  return all;
}

/**
 * Slice index into `next.lines` where unseen lines start: uses `next.range.start` when consistent, else line overlap.
 * @param {number} totalSoFar
 * @param {readonly string[]} beforeLines
 * @param {Extract<AgySidePanel, { state: 'answered' }>} next
 * @returns {number | undefined}
 */
function stitchedOffset(totalSoFar, beforeLines, next) {
  if (next.range !== undefined) {
    const offset = totalSoFar - (next.range.start - 1);
    if (offset >= 0 && offset <= next.lines.length) return offset;
  }
  const overlap = overlapOf(beforeLines, next.lines);
  return overlap === 0 ? undefined : overlap;
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

/** @param {readonly StyledLine[]} lines */
function withoutBlankEnds(lines) {
  const first = lines.findIndex((line) => line.plain !== '');
  const last = lines.findLastIndex((line) => line.plain !== '');
  return first < 0 ? [] : lines.slice(first, last + 1);
}

/**
 * Rejoin lines soft-wrapped by agy's /btw overlay at `width`, measuring against plain text while preserving paired
 * ANSI strings. Blank lines, headings, tables, list starts, and syntax-highlighted code lines stay separate.
 * @param {readonly StyledLine[]} lines
 * @param {number} width
 * @returns {StyledLine[]}
 */
function unwrappedStyled(lines, width) {
  /** @type {StyledLine[]} */
  const joined = [];
  lines.forEach((entry, index) => {
    const before = lines[index - 1];
    const word = entry.plain.trimStart().split(/\s/, 1)[0] ?? '';
    const wrapped =
      before !== undefined &&
      before.plain !== '' &&
      word !== '' &&
      !tableLine.test(before.plain) &&
      !tableLine.test(entry.plain) &&
      !headingLine.test(before.plain) &&
      !headingLine.test(entry.plain) &&
      !listLine.test(entry.plain) &&
      !isCodeBlockLine(before) &&
      !isCodeBlockLine(entry) &&
      [...before.plain].length + 1 + [...word].length > width;
    if (wrapped) {
      const prev = joined.pop();
      if (prev !== undefined) {
        const plain = `${prev.plain} ${entry.plain.trimStart()}`;
        const ansi = prev.ansi !== undefined && entry.ansi !== undefined ? `${prev.ansi} ${trimLeadingSpacesAnsi(entry.ansi)}` : undefined;
        joined.push({ plain, ansi });
        return;
      }
    }
    joined.push(entry);
  });
  return joined;
}

/**
 * Strip agy's overlay prefix (` ┃` + up to 3 spaces of body padding) from a raw ANSI line, preserving trailing SGR
 * state on the remaining body text.
 * @param {string} ansiLine
 * @returns {string}
 */
function stripOverlayPrefix(ansiLine) {
  let seenBar = false;
  let spacesLeft = 3;
  let result = '';
  let last = 0;
  for (const match of ansiLine.matchAll(sgrToken)) {
    const idx = match.index ?? 0;
    const chunk = ansiLine.slice(last, idx);
    for (const ch of chunk) {
      if (!seenBar) {
        if (ch === '┃') seenBar = true;
      } else if (spacesLeft > 0 && ch === ' ') {
        spacesLeft -= 1;
      } else {
        spacesLeft = 0;
        result += ch;
      }
    }
    if (seenBar && spacesLeft === 0) result += match[0];
    else if (seenBar) result += match[0];
    last = idx + match[0].length;
  }
  const tail = ansiLine.slice(last);
  for (const ch of tail) {
    if (!seenBar) {
      if (ch === '┃') seenBar = true;
    } else if (spacesLeft > 0 && ch === ' ') {
      spacesLeft -= 1;
    } else {
      spacesLeft = 0;
      result += ch;
    }
  }
  return result.trimEnd();
}

/**
 * Strip leading visible spaces from an ANSI string (when joining a wrapped continuation line), keeping SGR escapes.
 * @param {string} ansi
 */
function trimLeadingSpacesAnsi(ansi) {
  let started = false;
  let out = '';
  let last = 0;
  for (const match of ansi.matchAll(sgrToken)) {
    const idx = match.index ?? 0;
    for (const ch of ansi.slice(last, idx)) {
      if (!started && ch === ' ') continue;
      started = true;
      out += ch;
    }
    out += match[0];
    last = idx + match[0].length;
  }
  for (const ch of ansi.slice(last)) {
    if (!started && ch === ' ') continue;
    started = true;
    out += ch;
  }
  return out;
}

/**
 * Parse an ANSI string into coalesced styled runs (`bold`, `italic`, 256/basic `fg` color).
 * @param {string} ansi
 * @returns {AnsiRun[]}
 */
function parseAnsiRuns(ansi) {
  let bold = false;
  let italic = false;
  /** @type {number | undefined} */
  let fg;
  /** @type {AnsiRun[]} */
  const runs = [];
  const push = (/** @type {string} */ text) => {
    if (text === '') return;
    const prev = runs.at(-1);
    if (prev !== undefined && prev.bold === bold && prev.italic === italic && prev.fg === fg) prev.text += text;
    else runs.push({ text, bold, italic, fg });
  };
  let last = 0;
  for (const match of ansi.matchAll(sgrToken)) {
    const idx = match.index ?? 0;
    push(ansi.slice(last, idx));
    const params = match[1] ?? '';
    const codes = params === '' ? [0] : params.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        bold = false;
        italic = false;
        fg = undefined;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 3) {
        italic = true;
      } else if (code === 23) {
        italic = false;
      } else if (code === 39) {
        fg = undefined;
      } else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        fg = codes[i + 2];
        i += 2;
      } else if (code === 38 && codes[i + 1] === 2) {
        fg = -1;
        i += 4;
      } else if (code !== undefined && ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))) {
        fg = code;
      }
    }
    last = idx + match[0].length;
  }
  push(ansi.slice(last));
  return mergeWrappedStyleSpaces(runs);
}

/**
 * When a bold/italic phrase was soft-wrapped across two terminal lines, joining them inserts a single plain space
 * between two identically styled runs — merge them into one clean run so we emit `**a b**` instead of `**a** **b**`.
 * @param {AnsiRun[]} runs
 * @returns {AnsiRun[]}
 */
function mergeWrappedStyleSpaces(runs) {
  /** @type {AnsiRun[]} */
  const merged = [];
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i];
    if (cur === undefined) continue;
    const prev = merged.at(-1);
    const next = runs[i + 1];
    const plainSpace = cur.text === ' ' && !cur.bold && !cur.italic && cur.fg === undefined;
    if (plainSpace && prev !== undefined && next !== undefined && prev.fg === undefined && next.fg === undefined && (prev.bold || prev.italic) && prev.bold === next.bold && prev.italic === next.italic) {
      prev.text += ` ${next.text}`;
      i += 1;
      continue;
    }
    merged.push({ ...cur });
  }
  return merged;
}

/**
 * agy renders fenced code blocks indented by 2 spaces inside the body with chroma syntax-highlighting colors (anything
 * other than inline-code blue 12 and muted gray 8).
 * @param {StyledLine} entry
 */
function isCodeBlockLine(entry) {
  if (entry.ansi === undefined || !entry.plain.startsWith('  ') || entry.plain.trim() === '') return false;
  return parseAnsiRuns(entry.ansi).some((run) => run.text.trim() !== '' && run.fg !== undefined && run.fg !== 12 && run.fg !== 8);
}

/**
 * Convert unwrapped styled lines into Markdown, wrapping contiguous syntax-highlighted code lines in fenced blocks.
 * @param {readonly StyledLine[]} lines
 * @returns {string[]}
 */
function styledLinesToMarkdown(lines) {
  const codeFlags = lines.map(isCodeBlockLine);
  // keep blank lines sandwiched directly between two code lines inside the same fenced block
  for (let i = 1; i < lines.length - 1; i++) {
    if (!codeFlags[i] && lines[i]?.plain === '' && codeFlags[i - 1] && codeFlags[i + 1]) codeFlags[i] = true;
  }
  /** @type {string[]} */
  const out = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (entry === undefined) continue;
    const isCode = codeFlags[i] === true;
    if (isCode && !inCode) {
      out.push('```');
      inCode = true;
    } else if (!isCode && inCode) {
      out.push('```');
      inCode = false;
    }
    if (isCode) {
      out.push(entry.plain.replace(/^  /, ''));
    } else if (entry.ansi === undefined) {
      out.push(entry.plain);
    } else {
      out.push(ansiProseLineToMarkdown(entry.plain, entry.ansi));
    }
  }
  if (inCode) out.push('```');
  return out;
}

/**
 * Convert a single non-code ANSI line into Markdown (headings, bold, italic, color-12 inline code, bullets).
 * @param {string} plain
 * @param {string} ansi
 * @returns {string}
 */
function ansiProseLineToMarkdown(plain, ansi) {
  if (plain === '') return '';
  const runs = parseAnsiRuns(ansi);
  const isHeading = headingLine.test(plain);
  // replace leading "• " bullet with "- " directly in the runs so inline styles after the bullet stay intact
  if (!isHeading) replaceLeadingBullet(runs);
  return runs
    .map((run) => {
      const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text);
      const lead = parts?.[1] ?? '';
      const core = parts?.[2] ?? '';
      const trail = parts?.[3] ?? '';
      if (core === '') return run.text;
      if (run.fg === 12) return `${lead}${codeSpan(core)}${trail}`;
      if (isHeading) return run.text;
      if (run.bold && run.italic) return `${lead}***${core}***${trail}`;
      if (run.bold) return `${lead}**${core}**${trail}`;
      if (run.italic) return `${lead}*${core}*${trail}`;
      return run.text;
    })
    .join('')
    .trimEnd();
}

/**
 * Turn a leading terminal bullet (`• `) in the first non-empty run into a Markdown `- ` list marker.
 * @param {AnsiRun[]} runs
 */
function replaceLeadingBullet(runs) {
  for (const run of runs) {
    if (run.text === '') continue;
    if (/^\s*$/.test(run.text)) continue;
    if (/^\s*•\s+/.test(run.text)) run.text = run.text.replace(/^(\s*)•\s+/, '$1- ');
    return;
  }
}

/**
 * Wrap text in backticks safely even if it contains backticks.
 * @param {string} text
 */
function codeSpan(text) {
  if (!text.includes('`')) return `\`${text}\``;
  const fence = '`'.repeat(Math.max(...(text.match(/`+/g) ?? ['']).map((m) => m.length)) + 1);
  return `${fence} ${text} ${fence}`;
}
