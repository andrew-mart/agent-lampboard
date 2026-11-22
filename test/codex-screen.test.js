import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexDialog, codexInputBox, codexQueued, showsQueuedQuestion, showsSideConversation, showsSubagent, showsWorking } from '../server/codex-screen.js';

const footer = ['', '  D:\\gits\\shop · main · No changes · GPT-6-Astra xhigh · 411K used · Context 42% used', '  ← for agents · ? for shortcuts'];

// Codex's prompt box is the last line marked › on its screen — earlier ones are prompts in the conversation — with the
// lines it wraps onto, up to the blank line above the footer; no box — a picker or a dialog in its place, its chosen
// option marked › as well — none
test('codexInputBox_Should_ReadTextOfCodexsPromptBox_WrappedLinesIncluded', () => {
  const typed = ['› Add a rate limit', '', '• Added it to POST /orders.', '', 'Working (2m 03s • esc to interrupt)', '', '', '› Now cover it with a test that sends', '  a hundred requests', ...footer].join('\n');
  const empty = ['› Add a rate limit', '', '• Added.', '', '', '› Ask Codex to do anything', ...footer].join('\n');
  const picker = ['  Select model', '  1. GPT-6-Astra', '  2. GPT-6-mini'].join('\n');
  // its pickers mark the chosen option with › too
  const update = ['  Update available · 0.162.0 → 0.162.1', '› 1. Update now (runs `npm install -g @openai/codex`)', '  2. Skip', '  3. Skip until next version', '  enter continue · esc skip'].join('\n');

  assert.deepEqual([codexInputBox(typed), codexInputBox(empty), codexInputBox(picker), codexInputBox(update)], ['Now cover it with a test that sends\na hundred requests', 'Ask Codex to do anything', undefined, undefined]);
});

// What Codex's screen tells of itself is read where Codex draws it — a sub-agent's box and the banner over it, a side
// conversation's footer, its working line over the box — not anywhere in the conversation, which may quote the words
test('codexScreen_Should_ReadSubagentSideAndWorking_WhereCodexDrawsThem_NotInTheConversation', () => {
  const quoting = ['› What does the viewer do with a sub-agent?', '', '• It says "direct input is disabled" and "Side from main thread"; Working (2s • esc to interrupt) is what it waits on.', '', '› Ask Codex to do anything', ...footer].join('\n');
  const subagentBox = ['• Spawned a helper.', '', '› Viewing sub-agent — direct input is disabled', ...footer].join('\n');
  const subagentBanner = ['• Spawned a helper.', '', '■ This sub-agent is controlled by its parent. Direct input is', 'disabled.', '', '› fix the test', ...footer].join('\n');
  const side = ['› which word?', '• one', '', '› Ask a follow-up question', '', '  ~ · GPT-6-Astra low', '  Side from main thread · f12 to switch'].join('\n');
  const working = ['› Add a rate limit', '', 'Working (2m 03s • esc to interrupt)', '', '', '› Ask Codex to do anything', ...footer].join('\n');
  const read = (/** @type {string} */ screen) => ({ subagent: showsSubagent(screen), side: showsSideConversation(screen), working: showsWorking(screen) });

  assert.deepEqual([quoting, subagentBox, subagentBanner, side, working].map(read), [
    { subagent: false, side: false, working: false },
    { subagent: true, side: false, working: false },
    { subagent: true, side: false, working: false },
    { subagent: false, side: true, working: false },
    { subagent: false, side: false, working: true },
  ]);
});

// A numbered list typed into Codex's box is the box's text, not a picker's options: Codex's footer under it — its
// status and shortcuts lines — tells its box; nothing is asked then
test('codexInputBox_Should_ReadNumberedDraftAsBoxText_ByCodexsFooterUnderIt', () => {
  const draft = ['• Done.', '', '› 1. add a test', '  2. update the docs', ...footer].join('\n');

  assert.deepEqual({ box: codexInputBox(draft), dialog: codexDialog(draft) }, { box: '1. add a test\n2. update the docs', dialog: undefined });
});

// What Codex asks in its terminal — whether to trust a folder, to run a command — read as a dialog: what it says above
// its numbered options, the options, the one under its cursor; picked as Codex picks — the arrows to it, then Enter. Its
// prompt box on the screen: nothing asked
test('codexDialog_Should_ReadWhatCodexAsks_WithItsOptions_AndNothingWhileItsBoxShows', () => {
  const trust = [
    '  >_ OpenAI Codex (v0.162.0)',
    '',
    '  Trust this folder? Codex can read, edit, and run files here,',
    '  subject to your permission settings.',
    '',
    '› 1. Trust and continue',
    '  2. Quit',
    '',
    '  enter continue · esc quit',
  ].join('\n');
  const box = ['› Add a rate limit', '', '• Added.', '', '› Ask Codex to do anything', ...footer].join('\n');

  assert.deepEqual([codexDialog(trust), codexDialog(box)], [
    {
      lines: ['Trust this folder? Codex can read, edit, and run files here,', 'subject to your permission settings.'],
      options: [
        { key: '1', label: 'Trust and continue', detail: undefined, checked: undefined, current: true },
        { key: '2', label: 'Quit', detail: undefined, checked: undefined, current: false },
      ],
      tabs: false,
      previews: true,
    },
    undefined,
  ]);
});

// Codex lists the follow-up inputs it queued — Tab while it works — above its box, each a line or more: none without
test('codexQueued_Should_ReadFollowUpInputsCodexQueued', () => {
  const queued = [
    '› Run the shell command `ping -n 12 127.0.0.1`, then reply.',
    'Working (7s • esc to interrupt)',
    '• Queued follow-up inputs',
    '  ↳ Then reply with the single word queued.',
    '  ↳ And cover it with a test that sends a hundred',
    '    requests',
    '    shift+← edit last queued message',
    '› Ask Codex to do anything',
    ...footer,
  ].join('\n');

  assert.deepEqual([codexQueued(queued), codexQueued(queued.replace('• Queued follow-up inputs', '• Ran ls'))], [['Then reply with the single word queued.', 'And cover it with a test that sends a hundred requests'], []]);
});

// A question Codex asks while it works — or with descriptions under its options, or with no options at all — is read as
// a dialog: the counter at the top right of the question's first line left off, each option's indented description kept
// with it, and ←/→ between several questions told from its footer; its free-text line is no prompt box
test('codexDialog_Should_ReadAsyncAndDetailedQuestions_AndOpenEndedQuestionAsDialog_NotPromptBox', () => {
  const asyncQuestion = [
    '• Waiting for background terminal (32m 38s • esc to interrupt)',
    '',
    '👉 После успешного импорта музыки оставить исходные файлы           1 of 1',
    'на ПК или удалить проверенные?',
    '',
    '› 1. Оставить исходники на ПК',
    '  2. Удалить после проверки переноса',
    '  3. Other',
    '',
    'option 1/3 · enter submit · esc skip · shift+→ main prompt',
  ].join('\n');
  const detailed = [
    'Question 1/2 (2 unanswered)',
    'Which path should we use?',
    '',
    '  1. Fast path',
    '     Skip validation and write directly.',
    '› 2. Safe path',
    '     Validate every file before moving.',
    '',
    'enter to submit answer · ←/→ to navigate questions · esc to interrupt',
  ].join('\n');
  const openEnded = [
    'What should we name the playlist?                                   1 of 1',
    '',
    '› Type your answer',
    '',
    'No options · enter submit · esc skip · shift+→ main prompt',
  ].join('\n');

  assert.deepEqual(
    {
      boxes: [codexInputBox(asyncQuestion), codexInputBox(detailed), codexInputBox(openEnded)],
      dialogs: [codexDialog(asyncQuestion), codexDialog(detailed), codexDialog(openEnded)],
    },
    {
      boxes: [undefined, undefined, undefined],
      dialogs: [
        {
          lines: ['👉 После успешного импорта музыки оставить исходные файлы', 'на ПК или удалить проверенные?'],
          options: [
            { key: '1', label: 'Оставить исходники на ПК', detail: undefined, checked: undefined, current: true },
            { key: '2', label: 'Удалить после проверки переноса', detail: undefined, checked: undefined, current: false },
            { key: '3', label: 'Other', detail: undefined, checked: undefined, current: false },
          ],
          tabs: false,
          previews: true,
        },
        {
          lines: ['Question 1/2 (2 unanswered)', 'Which path should we use?'],
          options: [
            { key: '1', label: 'Fast path', detail: 'Skip validation and write directly.', checked: undefined, current: false },
            { key: '2', label: 'Safe path', detail: 'Validate every file before moving.', checked: undefined, current: true },
          ],
          tabs: true,
          previews: true,
        },
        {
          lines: ['What should we name the playlist?'],
          options: [{ key: '1', label: 'Type your answer', detail: undefined, checked: undefined, current: true }],
          tabs: false,
          previews: true,
        },
      ],
    },
  );
});

// A question waiting in Codex's queued follow-up inputs — "? 1 question / shift+← to answer" over an empty prompt box —
// is ready for shift+← to open; not while a queued message stands ahead of it or text is typed in the box
test('showsQueuedQuestion_Should_TellWhenQueuedQuestionWaitsForShiftLeftOverEmptyBox', () => {
  const ready = ['• Working (12s • esc to interrupt)', '', '• Queued follow-up inputs', '  ? 1 question', '  shift+← to answer', '', '› Ask Codex to do anything', ...footer].join('\n');
  const countdown = ['• Queued follow-up inputs', '  ? 2 questions', '  18s · shift+← to answer', '', '› Ask Codex to do anything', ...footer].join('\n');
  const behindMessage = ['• Queued follow-up inputs', '  ↳ Then update the docs.', '    shift+← edit last queued message', '  ? 1 question', '', '› Ask Codex to do anything', ...footer].join('\n');
  const draftInBox = ['• Queued follow-up inputs', '  ? 1 question', '  shift+← to answer', '', '› Wait a second', ...footer].join('\n');

  assert.deepEqual([ready, countdown, behindMessage, draftInBox].map(showsQueuedQuestion), [true, true, false, false]);
});
