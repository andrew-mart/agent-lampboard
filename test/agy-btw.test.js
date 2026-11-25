import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agySidePanel, driveAgyBtw, readAgyBtw, withAgyBtwClosed } from '../server/agy-btw.js';

const banner = ['      ▄▀▀▄        Antigravity CLI 1.5.9', '     ▀▀▀▀▀▀       ann@example.com', '   ▄▀▀    ▀▀▄     ~/shop', ''];

/**
 * A stand-in for Antigravity CLI 1.5.9's terminal with /btw: Enter on "/btw …" in an empty box opens a heavy-bar (┃)
 * overlay directly above the prompt box's top rule — "Working... (Enter/Esc to cancel)" while thinking, then the answer
 * truncated to `preview` lines until Tab expands it into a scrollable viewport of `height` lines (`↑/↓ to scroll (a-b of
 * total)`), and Enter/Esc dismisses it without disturbing an active turn.
 * @param {{ answer: readonly string[], preview?: number, height?: number, answeringLooks?: number, box?: string, asks?: boolean, columns?: number, open?: { question: string, looksLeft?: number }, asking?: boolean }} side
 */
function fakeAgy({ answer, preview = 6, height = 10, answeringLooks = 2, box = '', asks = true, columns = 80, open, asking = false }) {
  const rule = '─'.repeat(columns);
  /** @type {{ box: string, typed: string[], keys: string[], overlay: { question: string, looksLeft: number, expanded: boolean, scroll: number } | undefined }} */
  const state = {
    box,
    typed: [],
    keys: [],
    overlay: open === undefined ? undefined : { question: open.question, looksLeft: open.looksLeft ?? 0, expanded: false, scroll: 0 },
  };
  const screen = () => {
    if (asking) return [...banner, rule, 'Run command?', '  npm test', '', '> Allow once', '  Deny', '', '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', 'esc to cancel'].join('\n');
    const above = [...banner, '─'.repeat(60), '> Reply with just the word: ready', '  ready', ''];
    const prompt = [rule, `> ${state.box}`.trimEnd(), rule, `? for shortcuts${' '.repeat(20)}Gemini 4 Argon · high`];
    const overlay = state.overlay;
    if (overlay === undefined) return [...above, ...prompt].join('\n');
    // wrap long /btw questions across multiple ┃ lines as agy does
    const qWidth = Math.max(20, columns - 6);
    const qLines = wrapSimple(`/btw ${overlay.question}`, qWidth).map((line) => ` ┃ ${line}`);
    if (overlay.looksLeft > 0) {
      overlay.looksLeft -= 1;
      return [...above, ...qLines, ' ┃', ' ┃ ⣽  Working... (Enter/Esc to cancel)', ...prompt].join('\n');
    }
    const truncated = !overlay.expanded && answer.length > preview;
    const shown = truncated ? answer.slice(0, preview) : answer.slice(overlay.scroll, overlay.scroll + height);
    const body = shown.map((line) => (line === '' ? ' ┃' : ` ┃   ${line}`));
    const footer = truncated
      ? ' ┃ ... (truncated) — Tab to expand · ←/→ to navigate · Enter/Esc to dismiss'
      : overlay.expanded && answer.length > height
        ? ` ┃ ↑/↓ to scroll (${overlay.scroll + 1}-${overlay.scroll + shown.length} of ${answer.length}) — Tab to collapse · ←/→ to navigate · Enter/Esc to dismiss`
        : overlay.expanded
          ? ' ┃ Tab to collapse · Enter/Esc to dismiss'
          : ' ┃ Tab to expand · Enter/Esc to dismiss';
    return [...above, ...qLines, ' ┃', ...body, footer, ...prompt].join('\n');
  };
  /** @type {import('../server/claude-screen.js').Terminal} */
  const terminal = {
    read: async () => screen(),
    text: async (text) => {
      state.typed.push(text);
      state.box += text;
      return true;
    },
    keys: async (...keys) => {
      for (const key of keys) {
        state.keys.push(key);
        if (key === 'enter' && state.overlay !== undefined && state.box === '') {
          state.overlay = undefined;
          continue;
        }
        if (key === 'enter' && asks && state.box.startsWith('/btw ')) {
          state.overlay = { question: state.box.slice('/btw '.length), looksLeft: answeringLooks, expanded: false, scroll: 0 };
          state.box = '';
          continue;
        }
        if (key === 'tab' && state.overlay !== undefined && state.overlay.looksLeft === 0) {
          state.overlay.expanded = !state.overlay.expanded;
          state.overlay.scroll = 0;
          continue;
        }
        if (key === 'down' && state.overlay !== undefined && state.overlay.expanded) {
          state.overlay.scroll = Math.min(state.overlay.scroll + 1, Math.max(0, answer.length - height));
        }
        if (key === 'esc' && state.overlay !== undefined) state.overlay = undefined;
      }
      return true;
    },
  };
  return { state, terminal };
}

/** @param {string} text @param {number} width */
function wrapSimple(text, width) {
  /** @type {string[]} */
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

const noWait = async () => undefined;

// agy's /btw overlay sits directly above its prompt box with a heavy vertical bar (┃): Working... while answering,
// multi-line wrapped question header, truncated preview before Tab, scroll range after Tab, and Enter/Esc to dismiss
test('agySidePanel_Should_ReadAnswering_Answered_Truncated_AndScrollRange_ForMatchingQuestion', () => {
  const rule = '─'.repeat(119);
  const prompt = [rule, '>', rule, '? for shortcuts                                                                                   Gemini 4 Argon · high'];
  const longQuestion = 'Explain in two short sentences why very long context question word very long context question word matters here?';
  const answering = [...banner, ' ┃ /btw what is 2+2?', ' ┃', ' ┃ ⣽  Working... (Enter/Esc to cancel)', ...prompt].join('\n');
  const wrappedAnswered = [
    ...banner,
    ' ┃ /btw Explain in two short sentences why very long context question word very long',
    ' ┃ context question word matters here?',
    ' ┃',
    ' ┃   First line of answer.',
    ' ┃',
    ' ┃     indented code',
    ' ┃ Tab to expand · ←/→ to navigate · Enter/Esc to dismiss',
    ...prompt,
  ].join('\n');
  const truncated = [
    ...banner,
    ' ┃ /btw list fruits',
    ' ┃',
    ' ┃   1. Apple',
    ' ┃   2. Banana',
    ' ┃ ... (truncated) — Tab to expand · ←/→ to navigate · Enter/Esc to dismiss',
    ...prompt,
  ].join('\n');
  const scrolled = [
    ...banner,
    ' ┃ /btw list fruits',
    ' ┃',
    ' ┃   2. Banana',
    ' ┃   3. Cherry',
    ' ┃ ↑/↓ to scroll (2-3 of 5) — Tab to collapse · ←/→ to navigate · Enter/Esc to dismiss',
    ...prompt,
  ].join('\n');

  assert.deepEqual(
    {
      answering: agySidePanel(answering, 'what is 2+2?'),
      wrongQuestion: agySidePanel(answering, 'something else'),
      wrappedAnswered: agySidePanel(wrappedAnswered, longQuestion),
      truncated: agySidePanel(truncated, 'list fruits'),
      scrolled: agySidePanel(scrolled, 'list fruits'),
    },
    {
      answering: { state: 'answering' },
      wrongQuestion: undefined,
      wrappedAnswered: { state: 'answered', lines: ['First line of answer.', '', '  indented code'], width: 112, truncated: false, range: undefined },
      truncated: { state: 'answered', lines: ['1. Apple', '2. Banana'], width: 112, truncated: true, range: undefined },
      scrolled: { state: 'answered', lines: ['2. Banana', '3. Cherry'], width: 112, truncated: false, range: { start: 2, end: 3, total: 5 } },
    },
  );
});

// A long /btw answer in agy starts truncated: Tab expands it, ↓ scrolls through the remaining lines using the
// (start-end of total) range, wrapped prose lines are rejoined (leaving bullets and tables intact), and Enter closes
// the overlay cleanly without ever pressing Esc
test('driveAgyBtw_Should_ExpandTruncatedAnswer_ScrollToEnd_UnwrapAndDismissWithEnter', async () => {
  const answer = [
    'This summary explains the',
    'billing numbers in detail:',
    '',
    '• Fact (955k): actual',
    '  revenue in October.',
    '• Forecast (969k): new',
    '  20% commission model.',
    '',
    '┌──────┬──────┐',
    '│ Part │ Sum  │',
    '└──────┴──────┘',
    'Line twelve',
    'Line thirteen',
    'Line fourteen',
    'Line fifteen',
  ];
  // columns 32 => wrap width = 32 - 7 = 25: lines 0, 3, 5 wrap onto 1, 4, 6; short lines and table stay separate
  const agy = fakeAgy({ answer, preview: 5, height: 8, columns: 32 });

  const outcome = await driveAgyBtw(agy.terminal, { question: 'is 955k\nrevenue?', wait: noWait });

  assert.deepEqual(
    { outcome, open: agy.state.overlay !== undefined, typed: agy.state.typed, usedEsc: agy.state.keys.includes('esc'), usedTab: agy.state.keys.includes('tab'), lastKey: agy.state.keys.at(-1) },
    {
      outcome: {
        ok: true,
        answer: [
          'This summary explains the billing numbers in detail:',
          '',
          '• Fact (955k): actual revenue in October.',
          '• Forecast (969k): new 20% commission model.',
          '',
          '┌──────┬──────┐',
          '│ Part │ Sum  │',
          '└──────┴──────┘',
          'Line twelve',
          'Line thirteen',
          'Line fourteen',
          'Line fifteen',
        ].join('\n'),
      },
      open: false,
      typed: ['/btw is 955k revenue?'],
      usedEsc: false,
      usedTab: true,
      lastKey: 'enter',
    },
  );
});

// Short answer needs neither Tab nor ↓; an earlier /btw panel left open is closed first with Enter; a draft in the box
// or an open dialog refuses without typing anything; a question that never opens a panel presses no dismiss key
test('driveAgyBtw_Should_HandleShortAnswer_ExistingPanel_Draft_Dialog_AndUnopenedPanel', async () => {
  const short = fakeAgy({ answer: ['It equals four.'] });
  const hadOpen = fakeAgy({ answer: ['Yes, four.'], open: { question: 'earlier question' } });
  const withDraft = fakeAgy({ answer: ['It equals four.'], box: 'half typed' });
  const withDialog = fakeAgy({ answer: ['It equals four.'], asking: true });
  const neverOpens = fakeAgy({ answer: ['It equals four.'], asks: false });

  const outcomes = {
    short: await driveAgyBtw(short.terminal, { question: 'what is 2+2?', wait: noWait }),
    hadOpen: await driveAgyBtw(hadOpen.terminal, { question: 'still four?', wait: noWait }),
    withDraft: await driveAgyBtw(withDraft.terminal, { question: 'what is 2+2?', wait: noWait }),
    withDialog: await driveAgyBtw(withDialog.terminal, { question: 'what is 2+2?', wait: noWait }),
    neverOpens: await driveAgyBtw(neverOpens.terminal, { question: 'what is 2+2?', wait: noWait }),
  };

  assert.deepEqual(
    {
      outcomes,
      shortKeys: short.state.keys,
      hadOpenKeys: hadOpen.state.keys,
      draftTyped: withDraft.state.typed,
      dialogTyped: withDialog.state.typed,
      neverOpensKeys: neverOpens.state.keys,
    },
    {
      outcomes: {
        short: { ok: true, answer: 'It equals four.' },
        hadOpen: { ok: true, answer: 'Yes, four.' },
        withDraft: { ok: false, error: 'box-not-empty' },
        withDialog: { ok: false, error: 'screen-unreadable' },
        neverOpens: { ok: false, error: 'not-asked' },
      },
      shortKeys: ['enter', 'enter'],
      hadOpenKeys: ['enter', 'enter', 'enter'],
      draftTyped: [],
      dialogTyped: [],
      neverOpensKeys: ['enter'],
    },
  );
});

// Reconnecting while agy is answering a /btw reads its answer off the open overlay without re-asking; if the panel is
// already gone, reports panel-closed without pressing any key
test('readAgyBtw_Should_ReadOpenOverlay_AndReportPanelClosedWhenMissing', async () => {
  const running = fakeAgy({ answer: ['In src/config.ts.'], open: { question: 'where is config?', looksLeft: 2 } });
  const closed = fakeAgy({ answer: ['In src/config.ts.'] });

  const resumed = await readAgyBtw(running.terminal, { question: 'where is config?', wait: noWait });
  const missing = await readAgyBtw(closed.terminal, { question: 'where is config?', wait: noWait });

  assert.deepEqual(
    { resumed, typed: running.state.typed, openAfter: running.state.overlay !== undefined, missing, closedKeys: closed.state.keys },
    { resumed: { ok: true, answer: 'In src/config.ts.' }, typed: [], openAfter: false, missing: { ok: false, error: 'panel-closed' }, closedKeys: [] },
  );
});

// withAgyBtwClosed closes an open /btw overlay with Enter only when the prompt box is empty (never submitting a draft
// and never pressing anything when no overlay is open)
test('withAgyBtwClosed_Should_DismissOnlyWhenOverlayOpenAndBoxEmpty', async () => {
  const openEmpty = fakeAgy({ answer: ['ok'], open: { question: 'old' } });
  const openWithDraft = fakeAgy({ answer: ['ok'], open: { question: 'old' }, box: 'my draft' });
  const clean = fakeAgy({ answer: ['ok'] });

  await withAgyBtwClosed(openEmpty.terminal, noWait);
  await withAgyBtwClosed(openWithDraft.terminal, noWait);
  await withAgyBtwClosed(clean.terminal, noWait);

  assert.deepEqual(
    {
      openEmpty: { open: openEmpty.state.overlay !== undefined, keys: openEmpty.state.keys },
      openWithDraft: { open: openWithDraft.state.overlay !== undefined, keys: openWithDraft.state.keys },
      clean: { keys: clean.state.keys },
    },
    {
      openEmpty: { open: false, keys: ['enter'] },
      openWithDraft: { open: true, keys: [] },
      clean: { keys: [] },
    },
  );
});
