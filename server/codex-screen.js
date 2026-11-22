// @ts-check
// What Codex's terminal shows, read from its screen: its prompt box — the last line marked › (the earlier ones are the
// prompts of the conversation) and the lines it wraps onto, indented under it, up to the blank line over the footer. A
// picker — an update offer, a choice of model — marks its chosen option with › as well, numbered: no box then, unless
// Codex's footer is under it — a numbered list typed into the box.

/** The mark of a prompt, in the box and in the conversation. */
const promptMark = '› ';

/** How far over its box Codex draws what it says of itself: its working line, a banner, its queued inputs. */
const overBox = 8;

/**
 * The lines of Codex's screen, and where its box starts: its last line marked ›; none without one. What Codex says of
 * itself is read about the box — the conversation over it may quote the same words.
 * @param {string} screen
 */
function aroundBox(screen) {
  const lines = screen.split('\n');
  return { lines, top: lines.findLastIndex((line) => line.startsWith(promptMark)) };
}

/**
 * Whether Codex shows a sub-agent's thread, whose input its parent controls: its box says so, and a banner over the box
 * does once something is typed there.
 * @param {string} screen
 */
export function showsSubagent(screen) {
  const { lines, top } = aroundBox(screen);
  if (top === -1) return false;
  const end = lines.findIndex((line, index) => index > top && line.trim() === '');
  const box = lines.slice(top, end === -1 ? undefined : end).join(' ');
  const over = lines.slice(Math.max(0, top - overBox), top).join(' ');
  return /Viewing sub-agent/i.test(box) || /controlled by its parent\.\s+Direct input is\s+disabled/i.test(over);
}

/**
 * Whether Codex's terminal shows a side conversation — its /btw — not the main thread: its footer, under the box, says
 * so.
 * @param {string} screen
 */
export function showsSideConversation(screen) {
  const { lines, top } = aroundBox(screen);
  return top !== -1 && lines.slice(top).some((line) => /Side from main thread/.test(line));
}

/**
 * Whether Codex works: its working line over the box — "Working (2s • esc to interrupt)", "Starting MCP servers (0s •
 * esc to interrupt)".
 * @param {string} screen
 */
export function showsWorking(screen) {
  const { lines, top } = aroundBox(screen);
  return top !== -1 && lines.slice(Math.max(0, top - overBox), top).some((line) => /\([^()]*•\s*esc to [^()]*\)\s*$/.test(line));
}

/** A line of the footer under Codex's prompt box: its status — how much of the context is used — or its shortcuts. */
const boxFooter = /Context \d+% (?:used|left)|\? for shortcuts/;
/** A line of the footer under a question Codex asks without choices: its own-words line is marked › as the box is. */
const noOptionsFooter = /\bNo options · enter (?:submit|accept|queue) · esc skip\b/;

/** An option of a picker: the chosen one marked ›, the others indented as far. */
const optionLine = /^(›| ) (\d)\. (.+)$/;
/** A line under an option, indented past its number: its description. */
const detailLine = /^ {5}(\S.*)$/;

/**
 * What Codex asks in its terminal, as the page answers it: the block of lines over its numbered options, and
 * the options, the chosen one under its cursor. Picked as Codex picks — the arrows to it, then Enter — as a dialog's
 * answers beside previews are (dialog.js). None while its prompt box shows.
 * @param {string} screen
 * @returns {import('../public/model/dialog.js').Dialog | undefined}
 */
export function codexDialog(screen) {
  if (codexInputBox(screen) !== undefined) return undefined;
  const lines = screen.split('\n');
  const chosen = lines.findLastIndex((line) => line.startsWith(`${promptMark}`) && optionLine.test(line));
  const openEnded = chosen === -1 && lines.some((line) => noOptionsFooter.test(line)) ? lines.findLastIndex((line) => line.startsWith(promptMark)) : -1;
  if (chosen === -1 && openEnded === -1) return undefined;
  // the options around the chosen one, with any indented description lines under each
  let first = chosen === -1 ? openEnded : chosen;
  while (first > 0) {
    if (optionLine.test(lines[first - 1] ?? '')) first -= 1;
    else if (detailLine.test(lines[first - 1] ?? '')) {
      let above = first - 1;
      while (above > 0 && detailLine.test(lines[above - 1] ?? '')) above -= 1;
      if (above > 0 && optionLine.test(lines[above - 1] ?? '')) first = above - 1;
      else break;
    } else break;
  }
  let last = chosen === -1 ? openEnded : chosen;
  while (chosen !== -1 && last < lines.length - 1 && (optionLine.test(lines[last + 1] ?? '') || detailLine.test(lines[last + 1] ?? ''))) last++;
  const options =
    chosen === -1
      ? [{ key: '1', label: (lines[openEnded] ?? '').slice(promptMark.length).trim(), detail: undefined, checked: undefined, current: true }]
      : optionsOf(lines.slice(first, last + 1));
  // the question: the block of lines over the options, a blank line or two between them
  let end = first;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  let top = end;
  while (top > 0 && (lines[top - 1] ?? '').trim() !== '') top--;
  const asked = lines.slice(top, end).map((line, index) => (index === 0 ? line.trim().replace(/\s{2,}\d+ of \d+$/, '') : line.trim()));
  const tabs = lines.slice(last + 1).some((line) => /←\/→ to navigate questions/.test(line));
  return { lines: asked, options, tabs, previews: true };
}

/**
 * @param {readonly string[]} lines
 * @returns {import('../public/model/dialog.js').DialogOption[]}
 */
function optionsOf(lines) {
  /** @type {import('../public/model/dialog.js').DialogOption[]} */
  const options = [];
  for (const line of lines) {
    const [, mark, key, label] = optionLine.exec(line) ?? [];
    const [, detail] = detailLine.exec(line) ?? [];
    const previous = options.at(-1);
    if (key !== undefined && label !== undefined) options.push({ key, label: label.trim(), detail: undefined, checked: undefined, current: mark === '›' });
    else if (detail !== undefined && previous !== undefined) options[options.length - 1] = { ...previous, detail: previous.detail === undefined ? detail.trim() : `${previous.detail} ${detail.trim()}` };
  }
  return options;
}

/**
 * The text in Codex's prompt box — or its placeholder, while it is empty; none while a picker or a dialog takes its
 * place.
 * @param {string} screen
 * @returns {string | undefined}
 */
export function codexInputBox(screen) {
  const lines = screen.split('\n');
  const top = lines.findLastIndex((line) => line.startsWith(promptMark));
  if (top === -1) return undefined;
  const end = lines.findIndex((line, index) => index > top && line.trim() === '');
  const under = end === -1 ? [] : lines.slice(end);
  // a picker's chosen option is marked as the box is — "› 1. Update now" — a numbered list typed into the box too: the
  // box has Codex's footer under it; an open-ended question's line has its own footer under it
  if ((/^\d+\. /.test(lines[top]?.slice(promptMark.length) ?? '') && !under.some((line) => boxFooter.test(line))) || under.some((line) => noOptionsFooter.test(line))) return undefined;
  const box = lines.slice(top, end === -1 ? undefined : end);
  return box.map((line, index) => (index === 0 ? line.slice(promptMark.length) : line.replace(/^ {2}/, '')).trimEnd()).join('\n');
}

/** Text in reverse video, up to where the style is reset. */
const reverseVideo = /\u001b\[7m(.*?)\u001b\[(?:0|27)m/gs;

/**
 * The prompt Codex shows browsed while it browses its prompts to rewind to one: the one drawn in reverse video — a
 * long one on its lines in turn. None without one.
 * @param {string} styled — the screen with its styles: herdr's read in ansi
 * @returns {string | undefined}
 */
export function codexBrowsedPrompt(styled) {
  const parts = [...styled.matchAll(reverseVideo)].map((match) => (match[1] ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim());
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * The follow-up inputs Codex queued — Tab while it works — as it lists them over its box: each after ↳, wrapped onto
 * lines indented under it, up to its hint about editing them. None without the list.
 * @param {string} screen
 * @returns {string[]}
 */
export function codexQueued(screen) {
  const lines = screen.split('\n');
  const top = lines.findLastIndex((line) => line.startsWith('• Queued follow-up inputs'));
  if (top === -1) return [];
  /** @type {string[]} */
  const queued = [];
  for (const line of lines.slice(top + 1)) {
    const input = /^\s*↳ (.*)$/.exec(line);
    if (input !== null) queued.push((input[1] ?? '').trim());
    else if (/^ {4}\S/.test(line) && !/edit last queued message/.test(line) && queued.length > 0) queued[queued.length - 1] = `${queued.at(-1)} ${line.trim()}`;
    else break;
  }
  return queued;
}

/** The placeholder in Codex's prompt box while nothing is typed there. */
const boxPlaceholder = 'Ask Codex to do anything';

/**
 * Whether Codex holds a question in its queued follow-up inputs, ready to open with shift+←: its box is empty, and no
 * queued message stands ahead of the question to take the key first.
 * @param {string} screen
 */
export function showsQueuedQuestion(screen) {
  const { lines, top } = aroundBox(screen);
  if (top === -1 || codexInputBox(screen) !== boxPlaceholder) return false;
  const over = lines.slice(Math.max(0, top - overBox), top);
  const header = over.findLastIndex((line) => line.startsWith('• Queued follow-up inputs'));
  return header !== -1 && over.slice(header + 1).some((line) => /\bshift\+← to answer\s*$/.test(line));
}
