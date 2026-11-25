import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerBlocks, sideAnswerMarkdown } from '../public/model/side-answer.js';

// Claude Code draws a markdown table in the terminal with box lines, a cell's text wrapped over the lines of its row;
// on the page it is a table again, its first row the header, each cell's text whole
test('answerBlocks_Should_TurnTableDrawnInTerminalIntoRowsOfCells_BetweenItsText', () => {
  const answer = [
    'Two of the three parts are in master:',
    '',
    '┌────────┬──────────┬──────────────────────────────┐',
    '│  Part  │    MR    │       State in master        │',
    '├────────┼──────────┼──────────────────────────────┤',
    '│ Album  │ !72      │ Merged on 07.10; the mark no │',
    '│ mark   │          │ longer carries over.         │',
    '├────────┼──────────┼──────────────────────────────┤',
    '│ Photo  │ — (none) │ Not started.                 │',
    '└────────┴──────────┴──────────────────────────────┘',
    '',
    'The third needs its own MR.',
  ].join('\n');

  assert.deepEqual(answerBlocks(answer), [
    { kind: 'text', text: 'Two of the three parts are in master:' },
    {
      kind: 'table',
      rows: [
        ['Part', 'MR', 'State in master'],
        ['Album mark', '!72', 'Merged on 07.10; the mark no longer carries over.'],
        ['Photo', '— (none)', 'Not started.'],
      ],
    },
    { kind: 'text', text: 'The third needs its own MR.' },
  ]);
});

// A box whose rows do not line up — a cell's text with a bar of its own — is no table to rebuild: it stays as drawn
test('answerBlocks_Should_KeepBoxAsDrawn_When_ItsRowsDoNotLineUp', () => {
  const box = ['┌──────┬──────┐', '│ a │ b │ c │', '└──────┴──────┘'].join('\n');

  assert.deepEqual(answerBlocks(box), [{ kind: 'preformatted', text: box }]);
});

// Terminal bullets (•) become Markdown list items (-), and 2-space indented bullets directly under a numbered item
// bump to 3 spaces so CommonMark nests the sublist inside the numbered item; fenced code blocks stay untouched
test('sideAnswerMarkdown_Should_ConvertTerminalBullets_AndNestUnderNumberedItems_OutsideFences', () => {
  const raw = [
    '1. First step',
    '2. Second step:',
    '  • nested one',
    '  • nested two',
    '3. Third step',
    '',
    '• top bullet',
    '',
    '```',
    '• keep bullet in code',
    '```',
  ].join('\n');

  assert.deepEqual(
    [sideAnswerMarkdown(raw), sideAnswerMarkdown('8080.')],
    [
      [
        '1. First step',
        '2. Second step:',
        '   - nested one',
        '   - nested two',
        '3. Third step',
        '',
        '- top bullet',
        '',
        '```',
        '• keep bullet in code',
        '```',
      ].join('\n'),
      '8080\\.',
    ],
  );
});
