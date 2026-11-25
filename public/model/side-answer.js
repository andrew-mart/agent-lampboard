// @ts-check
// The answer to a side question (/btw), as read off Claude Code's terminal, in blocks the page can show. Claude Code
// draws a markdown table with box lines, a rule between every two rows and a cell's text wrapped over the lines of its
// row: the page shows it as a table again, its first row the header.

/**
 * @typedef {{ kind: 'text', text: string } | { kind: 'table', rows: readonly (readonly string[])[] } | { kind: 'preformatted', text: string }} AnswerBlock
 *   preformatted: box lines that do not make a table, shown as drawn
 */

const tableTop = /^\s*┌[─┬]*┐\s*$/;
const tableBottom = /^\s*└[─┴]*┘\s*$/;
const rowRule = /^\s*├[─┼]*┤\s*$/;
const rowLine = /^\s*│.*│\s*$/;

/**
 * @param {string} answer
 * @returns {AnswerBlock[]}
 */
export function answerBlocks(answer) {
  const lines = answer.split('\n');
  /** @type {AnswerBlock[]} */
  const blocks = [];
  /** @type {string[]} */
  const text = [];
  const endText = () => {
    const kept = withoutBlankEnds(text.splice(0));
    if (kept.length > 0) blocks.push({ kind: 'text', text: kept.join('\n') });
  };
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    const end = tableTop.test(line) ? lines.findIndex((next, index) => index > at && tableBottom.test(next)) : -1;
    if (end < 0) {
      text.push(line);
      continue;
    }
    endText();
    const rows = rowsOf(line, lines.slice(at + 1, end));
    blocks.push(rows === undefined ? { kind: 'preformatted', text: lines.slice(at, end + 1).join('\n') } : { kind: 'table', rows });
    at = end;
  }
  endText();
  return blocks;
}

/**
 * The rows of a table from the lines inside its box: the cells of each row, a cell's wrapped text joined. Undefined
 * when the lines do not make one: a line that is not a row or a rule, a row with more or fewer cells than the top
 * edge has columns.
 * @param {string} top — the box's top edge: a ┬ over every border between columns
 * @param {readonly string[]} inside
 * @returns {string[][] | undefined}
 */
function rowsOf(top, inside) {
  const columns = (top.match(/┬/g)?.length ?? 0) + 1;
  /** @type {string[][][]} — rows, each of its lines, each of their cells */
  const rows = [[]];
  for (const line of inside) {
    if (rowRule.test(line)) rows.push([]);
    else if (rowLine.test(line)) rows.at(-1)?.push(line.trim().slice(1, -1).split('│'));
    else return undefined;
  }
  const filled = rows.filter((row) => row.length > 0);
  if (filled.length === 0 || filled.some((row) => row.some((cells) => cells.length !== columns))) return undefined;
  return filled.map((row) => Array.from({ length: columns }, (_, column) => row.map((cells) => (cells[column] ?? '').trim()).filter((part) => part !== '').join(' ')));
}

/** @param {readonly string[]} lines */
function withoutBlankEnds(lines) {
  const first = lines.findIndex((line) => line.trim() !== '');
  const last = lines.findLastIndex((line) => line.trim() !== '');
  return first < 0 ? [] : lines.slice(first, last + 1);
}

const fenceToggle = /^\s*```/;
const loneNumberDot = /^(\s*\d+)\.\s*$/;
const orderedItem = /^(\s*)(\d+\.\s)/;
const bulletItem = /^(\s*)([•-])\s+(.*)$/;

/**
 * Prepare a side-answer text block for Markdown rendering: convert terminal bullets (`• `) to Markdown list markers
 * (`- `) outside fenced code blocks, bump 2-space indented bullets immediately under a numbered item to match the
 * numbered item's content column so CommonMark nests the sublist inside the `<ol><li>`, and escape a lone number with
 * a period (e.g. `8080.`) so CommonMark does not swallow it as an empty ordered list.
 * @param {string} source
 * @returns {string}
 */
export function sideAnswerMarkdown(source) {
  let inFence = false;
  /** Content column of the active ordered list item (e.g. 3 for `1. `), or undefined outside one. */
  /** @type {number | undefined} */
  let orderedIndent;
  return source
    .split('\n')
    .map((line) => {
      if (fenceToggle.test(line)) {
        inFence = !inFence;
        orderedIndent = undefined;
        return line;
      }
      if (inFence) return line;
      if (loneNumberDot.test(line)) {
        orderedIndent = undefined;
        return line.replace(loneNumberDot, '$1\\.');
      }
      const ordered = orderedItem.exec(line);
      if (ordered !== null) {
        orderedIndent = (ordered[1]?.length ?? 0) + (ordered[2]?.length ?? 0);
        return line;
      }
      const bullet = bulletItem.exec(line);
      if (bullet !== null) {
        const spaces = bullet[1] ?? '';
        const text = bullet[3] ?? '';
        const indent = orderedIndent !== undefined && spaces.length > 0 && spaces.length < orderedIndent ? ' '.repeat(orderedIndent) : spaces;
        if (spaces.length === 0) orderedIndent = undefined;
        return `${indent}- ${text}`;
      }
      if (line.trim() === '') orderedIndent = undefined;
      return line;
    })
    .join('\n');
}
