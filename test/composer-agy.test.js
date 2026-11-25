import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposer } from '../server/composer.js';
import { dialogPrint } from '../public/model/dialog.js';

const conversation = 'c2da1db1-1271-4baa-aac2-0f4026b2453a';
const rule = '─'.repeat(60);
const banner = ['      ▄▀▀▄        Antigravity CLI 1.5.4', '     ▀▀▀▀▀▀       ann@example.com (Google AI Pro)', '   ▄▀▀    ▀▀▄     ~/shop', ''];
/** @param {string} box */
const agyScreen = (box) => [...banner, rule, `> ${box}`.trimEnd(), rule, `? for shortcuts${' '.repeat(30)}Gemini 4 Argon · high`].join('\n');
const permission = [...banner, rule, 'Run command?', '  npm test', '', '> Allow once', '  Deny', '', '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', 'esc to cancel'].join('\n');

/**
 * A fake herdr whose pane shows agy's screen: its box empty until text is typed, then with the text, until Enter takes
 * it — or a permission dialog in its place. Records the calls that change something.
 * @param {{ asking?: true, takes?: number, scrolled?: true, panel?: readonly string[] }} [options] - asking: agy asks to
 *   run a command; panel: the lines of a panel of agy's under its box — /mcp — the keys going to it; takes: the
 *   characters typed that agy's box takes between two looks at the screen — all at once if not told; scrolled: the pane
 *   scrolled up in herdr, what is in view its earlier lines, its box under them — the screen's last lines are as ever
 */
function fakeHerdr({ asking, takes = Number.POSITIVE_INFINITY, scrolled, panel } = {}) {
  let box = '';
  // typed, not in the box yet
  let coming = '';
  /** @type {string[]} */
  const changes = [];
  /** @param {readonly string[]} args @returns {Promise<import('../server/composer.js').HerdrReply>} */
  const run = async (args) => {
    const [, command, pane, argument] = args;
    const keys = args.slice(3);
    if (command === 'list') return { ok: true, json: { result: { panes: [{ agent: 'agy', pane_id: 'w2:p1' }] } }, text: '' };
    if (command === 'read') {
      box += coming.slice(0, takes);
      coming = coming.slice(takes);
      const inView = scrolled === true && args.includes('visible');
      return { ok: true, json: undefined, text: asking === true ? permission : inView ? banner.join('\n') : panel !== undefined ? [agyScreen(box), ...panel].join('\n') : agyScreen(box) };
    }
    if ((command === 'send-text' || command === 'paste-text') && argument !== undefined) coming += argument;
    if (command === 'send-keys' && (keys.includes('enter') || keys.includes('alt+m'))) box = '';
    changes.push(`${command} ${pane} ${keys.join(' ')}`);
    return { ok: true, json: { result: { type: 'ok' } }, text: '' };
  };
  return { run, changes };
}

/**
 * @param {import('../server/herdr-view.js').AgentPlace} place — where agy runs the conversation
 * @param {ReturnType<typeof fakeHerdr>} herdr
 */
const composerOf = (place, herdr) => createComposer({ readRecords: async () => [], herdr: herdr.run, codexPlace: async () => ({ found: 'none' }), agyPlace: async (id) => (id === conversation ? place : { found: 'none' }) });

// An agy conversation runs in its herdr pane, at work or waiting for a prompt — what agy asks there read off its screen;
// agy holds it open outside herdr — a program's run, a terminal not told apart; or it is closed
test('liveState_Should_FindAgyConversationInItsPane_WithWhatAgyAsks_OrTellItRunsElsewhere_OrIsClosed', async () => {
  /** @type {readonly import('../server/herdr-view.js').AgentPlace[]} */
  const places = [{ found: 'pane', pane: 'w2:p1', working: true }, { found: 'pane', pane: 'w2:p1', working: false }, { found: 'elsewhere' }, { found: 'none' }];

  const states = await Promise.all(places.map((place) => composerOf(place, fakeHerdr()).liveState(conversation)));
  const asking = await composerOf({ found: 'pane', pane: 'w2:p1', working: false }, fakeHerdr({ asking: true })).liveState(conversation);

  assert.deepEqual(
    { states, asking },
    {
      states: [{ state: 'live', status: 'busy', pane: 'w2:p1', dialog: undefined, queued: [] }, { state: 'live', status: 'idle', pane: 'w2:p1', dialog: undefined, queued: [] }, { state: 'outside-herdr', status: 'idle' }, { state: 'offline' }],
      asking: {
        state: 'live',
        status: 'idle',
        pane: 'w2:p1',
        dialog: {
          lines: ['Run command?', 'npm test'],
          options: [
            { key: '', label: 'Allow once', detail: undefined, checked: undefined, current: true },
            { key: '', label: 'Deny', detail: undefined, checked: undefined, current: false },
          ],
          tabs: false,
          previews: true,
        },
        queued: [],
      },
    },
  );
});

// A prompt goes into agy's box and in with Enter, whether agy works or not — agy queues one that comes while it works;
// sent now while agy works, it goes in with alt+m (agy's immediate send); a stop is Esc, as in its terminal. The prompt
// goes in as a paste: typed, agy takes it a few characters at a time
test('send_sendNow_And_interrupt_Should_TypePromptIntoAgyWithEnter_SendNowWithAltM_AndStopItWithEsc', async () => {
  const idle = fakeHerdr();
  const busy = fakeHerdr();

  const outcomes = [
    await composerOf({ found: 'pane', pane: 'w2:p1', working: false }, idle).send(conversation, 'Add the price filter'),
    await composerOf({ found: 'pane', pane: 'w2:p1', working: true }, busy).send(conversation, 'Then cover it with a test'),
    await composerOf({ found: 'pane', pane: 'w2:p1', working: true }, busy).sendNow(conversation, 'Keep the old sort'),
    await composerOf({ found: 'pane', pane: 'w2:p1', working: true }, busy).interrupt(conversation),
  ];

  assert.deepEqual(
    { outcomes, idle: idle.changes, busy: busy.changes },
    {
      outcomes: [{ ok: true, pane: 'w2:p1' }, { ok: true, pane: 'w2:p1' }, { ok: true, pane: 'w2:p1' }, { ok: true, pane: 'w2:p1', prompt: undefined }],
      idle: ['paste-text w2:p1 Add the price filter', 'send-keys w2:p1 enter'],
      busy: ['paste-text w2:p1 Then cover it with a test', 'send-keys w2:p1 enter', 'paste-text w2:p1 Keep the old sort', 'send-keys w2:p1 alt+m', 'send-keys w2:p1 esc'],
    },
  );
});

// agy takes a long prompt a few characters at a time, drawing its box anew for each, when it comes typed — herdr's
// program has no paste — on Windows tens of seconds: while its box keeps growing the prompt is still coming, and Enter
// follows once its end is there
test('send_Should_WaitWhileAgyTakesALongPromptSlowly_ThenPressEnter', async () => {
  const slow = fakeHerdr({ takes: 4 });
  const prompt = 'Add the price filter to the catalogue page, the cheapest first, and keep the old sort for the admin list';

  const outcome = await composerOf({ found: 'pane', pane: 'w2:p1', working: false }, slow).send(conversation, prompt);

  assert.deepEqual({ outcome, typed: slow.changes }, { outcome: { ok: true, pane: 'w2:p1' }, typed: [`paste-text w2:p1 ${prompt}`, 'send-keys w2:p1 enter'] });
});

// agy's pane scrolled up in herdr — someone read its earlier lines there — shows its box out of view: a prompt still
// goes in, the screen's last lines read as they are
test('send_Should_TypePromptIntoAgy_ThoughItsPaneIsScrolledUp', async () => {
  const scrolled = fakeHerdr({ scrolled: true });

  const outcome = await composerOf({ found: 'pane', pane: 'w2:p1', working: false }, scrolled).send(conversation, 'Add the price filter');

  assert.deepEqual({ outcome, typed: scrolled.changes }, { outcome: { ok: true, pane: 'w2:p1' }, typed: ['paste-text w2:p1 Add the price filter', 'send-keys w2:p1 enter'] });
});

// agy rewound — its conversation and the files changed since — through its /rewind, typed into its box; not while it
// works: the keys would go into its turn
test('rewind_Should_TypeRewindIntoIdleAgy_AndNothingWhileItWorks', async () => {
  const idle = fakeHerdr();
  const busy = fakeHerdr();
  const request = { stepsUp: 1, prompt: 'Add the price filter', sentAt: undefined, action: /** @type {const} */ ('both') };

  const outcomes = [await composerOf({ found: 'pane', pane: 'w2:p1', working: true }, busy).rewind(conversation, request), await composerOf({ found: 'pane', pane: 'w2:p1', working: false }, idle).rewind(conversation, request)];

  // this agy shows no /rewind panel: the rewind gives up, nothing chosen in it
  assert.deepEqual({ outcomes, busy: busy.changes, idle: idle.changes }, { outcomes: [{ ok: false, error: 'busy' }, { ok: false, error: 'menu-not-shown' }], busy: [], idle: ['send-text w2:p1 /rewind', 'send-keys w2:p1 enter'] });
});

// agy's /mcp open under its box takes the keys, the box still on the screen: the page is told what it shows — its
// servers — and answers it with keys; a prompt is not typed into it
test('liveState_answer_And_send_Should_ShowAgysMcpServers_AnswerThemWithKeys_AndTypeNoPromptIntoThem', async () => {
  const herdr = fakeHerdr({ panel: ['MCP Servers', '>  ✓ shop-db  Tools: list_orders, +12 more', '   ✓ browser  Tools: browser_open, +30 more', 'Keyboard: ↑/↓ Navigate  enter Actions  esc Exit'] });
  const composer = composerOf({ found: 'pane', pane: 'w2:p1', working: false }, herdr);

  const live = await composer.liveState(conversation);
  const answered = await composer.answer(conversation, [{ key: 'down' }, { key: 'enter' }], live.state === 'live' && live.dialog !== undefined ? dialogPrint(live.dialog) : '', async () => []);
  const sent = await composer.send(conversation, 'Add the price filter');

  assert.deepEqual(
    { servers: live.state === 'live' ? live.dialog?.options.map((option) => option.label) : undefined, answered, sent, typed: herdr.changes },
    { servers: ['✓ shop-db', '✓ browser'], answered: { ok: true }, sent: { ok: false, error: 'asking' }, typed: ['send-keys w2:p1 down', 'send-keys w2:p1 enter'] },
  );
});

// An answer of one's own to an agy question — its "Write-in..." opened with Enter, the words, Enter — pastes the words
// into "Your answer:" as a prompt is pasted into agy's box, so Enter does not come before the words finish arriving
test('answer_Should_PasteOwnWordsIntoAgysWriteInQuestion', async () => {
  const herdr = fakeHerdr({ panel: ['Question', rule, '', 'Question 1/1: Which page?', '', '> 1. Catalog', '  2. Write-in...', '', '  ↑/↓ Navigate · enter Submit · esc Skip', 'esc to cancel'] });
  const composer = composerOf({ found: 'pane', pane: 'w2:p1', working: false }, herdr);

  const live = await composer.liveState(conversation);
  const dialog = live.state === 'live' ? live.dialog : undefined;
  const answered = await composer.answer(
    conversation,
    [{ key: 'down' }, { key: 'enter' }, { text: 'The checkout summary' }, { key: 'enter' }],
    dialog === undefined ? '' : dialogPrint(dialog),
    async () => [],
  );

  assert.deepEqual(
    { answered, typed: herdr.changes },
    {
      answered: { ok: true },
      typed: ['send-keys w2:p1 down', 'send-keys w2:p1 enter', 'paste-text w2:p1 The checkout summary', 'send-keys w2:p1 enter'],
    },
  );
});

// While agy asks something — a permission, a question — neither a prompt nor /btw is typed: its keys would answer it.
// agy rewinds its conversation only with the files changed since: nothing is typed for conversation-only rewind
test('send_btw_And_rewind_Should_TypeNothingIntoAgy_WhileItAsks_OrForWhatAgyHasNot', async () => {
  const asking = fakeHerdr({ asking: true });
  const idle = fakeHerdr();
  const askingComposer = composerOf({ found: 'pane', pane: 'w2:p1', working: false }, asking);
  const idleComposer = composerOf({ found: 'pane', pane: 'w2:p1', working: false }, idle);

  const outcomes = [
    await askingComposer.send(conversation, 'Add the price filter'),
    await askingComposer.btw(conversation, 'Which page is busiest?'),
    await idleComposer.rewind(conversation, { stepsUp: 1, prompt: 'Add the price filter', sentAt: undefined, action: 'conversation' }),
  ];

  assert.deepEqual(
    { outcomes, typed: [...asking.changes, ...idle.changes] },
    {
      outcomes: [
        { ok: false, error: 'asking' },
        { ok: false, error: 'screen-unreadable' },
        { ok: false, error: 'option-not-found' },
      ],
      typed: [],
    },
  );
});

// Messages queued in agy while it works come back in liveState.queued; sendNow with an empty box presses alt+m to flush
// them into the current turn, or returns empty when nothing is queued
test('liveState_And_sendNow_Should_ExposeAgyQueuedMessages_AndFlushThemWithAltM_WhenBoxIsEmpty', async () => {
  /** @param {readonly string[]} initial */
  const queuedHerdr = (initial) => {
    let sending = false;
    /** @type {string[]} */
    const changes = [];
    /** @param {readonly string[]} args @returns {Promise<import('../server/composer.js').HerdrReply>} */
    const run = async (args) => {
      const [, command, pane] = args;
      const keys = args.slice(3);
      if (command === 'list') return { ok: true, json: { result: { panes: [{ agent: 'agy', pane_id: 'w2:p1' }] } }, text: '' };
      if (command === 'read') {
        const queuedLines = initial.length === 0
          ? []
          : sending
            ? [...initial.map((item) => `▸ ${item}`), '  ⎿  Sending to agent...']
            : initial.map((item, at) => (at === initial.length - 1 ? `▸ ${item} (alt+m to send immediately)` : `▸ ${item}`));
        const footer = initial.length === 0 ? `esc to cancel${' '.repeat(25)}Gemini 4 Neon · xhigh` : `  Press up to edit queued messages${' '.repeat(10)}Gemini 4 Neon · xhigh`;
        return { ok: true, json: undefined, text: [...banner, '⢿  Generating...', ...queuedLines, rule, '>', rule, footer].join('\n') };
      }
      if (command === 'send-keys' && keys.includes('alt+m')) sending = true;
      changes.push(`${command} ${pane} ${keys.join(' ')}`);
      return { ok: true, json: { result: { type: 'ok' } }, text: '' };
    };
    return { run, changes };
  };

  const withQueue = queuedHerdr(['Use no_proxy for browser', 'Also save raw JSON']);
  const withoutQueue = queuedHerdr([]);
  const busy = /** @type {const} */ ({ found: 'pane', pane: 'w2:p1', working: true });
  const composerWithQueue = createComposer({ readRecords: async () => [], herdr: withQueue.run, codexPlace: async () => ({ found: 'none' }), agyPlace: async () => busy });
  const composerWithoutQueue = createComposer({ readRecords: async () => [], herdr: withoutQueue.run, codexPlace: async () => ({ found: 'none' }), agyPlace: async () => busy });

  const liveBefore = await composerWithQueue.liveState(conversation);
  const flushed = await composerWithQueue.sendNow(conversation, '');
  const liveAfter = await composerWithQueue.liveState(conversation);
  const emptyOutcome = await composerWithoutQueue.sendNow(conversation, '');

  assert.deepEqual(
    {
      queuedBefore: liveBefore.state === 'live' ? liveBefore.queued : undefined,
      flushed,
      queuedAfter: liveAfter.state === 'live' ? liveAfter.queued : undefined,
      pressed: withQueue.changes,
      emptyOutcome,
      emptyPressed: withoutQueue.changes,
    },
    {
      queuedBefore: ['Use no_proxy for browser', 'Also save raw JSON'],
      flushed: { ok: true, pane: 'w2:p1' },
      queuedAfter: [],
      pressed: ['send-keys w2:p1 alt+m'],
      emptyOutcome: { ok: false, error: 'empty' },
      emptyPressed: [],
    },
  );
});

// When agy's settings.json has queuedMessages set to "send-immediately", Enter sends immediately and alt+m queues:
// while agy works, send uses alt+m and sendNow uses enter; while idle, Enter always sends
test('send_And_sendNow_Should_SwapEnterAndAltM_WhenAgyIsInSendImmediatelyMode', async () => {
  const busyHerdr = fakeHerdr();
  const idleHerdr = fakeHerdr();
  const busy = /** @type {const} */ ({ found: 'pane', pane: 'w2:p1', working: true });
  const idle = /** @type {const} */ ({ found: 'pane', pane: 'w2:p1', working: false });
  const mode = async () => /** @type {const} */ ('send-immediately');
  const busyComposer = createComposer({ readRecords: async () => [], herdr: busyHerdr.run, codexPlace: async () => ({ found: 'none' }), agyPlace: async () => busy, agyQueuedMode: mode });
  const idleComposer = createComposer({ readRecords: async () => [], herdr: idleHerdr.run, codexPlace: async () => ({ found: 'none' }), agyPlace: async () => idle, agyQueuedMode: mode });

  await busyComposer.send(conversation, 'Queue this one');
  await busyComposer.sendNow(conversation, 'Send this right away');
  await idleComposer.send(conversation, 'Idle message');

  assert.deepEqual(
    { busy: busyHerdr.changes, idle: idleHerdr.changes },
    {
      busy: ['paste-text w2:p1 Queue this one', 'send-keys w2:p1 alt+m', 'paste-text w2:p1 Send this right away', 'send-keys w2:p1 enter'],
      idle: ['paste-text w2:p1 Idle message', 'send-keys w2:p1 enter'],
    },
  );
});

// agy answers /btw in a heavy-bar (┃) overlay above its prompt box: composer.btw pastes /btw <question>, reads the
// answer and dismisses with Enter; composer.resumeBtw picks up an already-open overlay without re-typing
test('btw_And_resumeBtw_Should_DriveAgySideQuestion_AndResumeOpenOverlay', async () => {
  /** @param {string | undefined} preOpen */
  const btwHerdr = (preOpen) => {
    let box = '';
    /** @type {string | undefined} */
    let overlay = preOpen;
    let looks = 0;
    /** @type {string[]} */
    const changes = [];
    /** @param {readonly string[]} args @returns {Promise<import('../server/composer.js').HerdrReply>} */
    const run = async (args) => {
      const [, command, pane, argument] = args;
      const keys = args.slice(3);
      if (command === 'list') return { ok: true, json: { result: { panes: [{ agent: 'agy', pane_id: 'w2:p1' }] } }, text: '' };
      if (command === 'read') {
        const isAnsi = args.includes('ansi');
        const ready = isAnsi ? looks > 0 : looks++ > 0;
        const panel =
          overlay === undefined
            ? []
            : !ready
              ? [` ┃ /btw ${overlay}`, ' ┃', ' ┃ ⣽  Working... (Enter/Esc to cancel)']
              : isAnsi
                ? [` \x1b[38;5;3m┃\x1b[0m \x1b[1m/btw ${overlay}\x1b[0m`, ' \x1b[38;5;3m┃\x1b[0m', ' \x1b[38;5;3m┃\x1b[0m   Yes, \x1b[1m955k\x1b[0m is \x1b[38;5;12mrevenue\x1b[0m.', ' \x1b[38;5;3m┃\x1b[0m Tab to expand · Enter/Esc to dismiss']
                : [` ┃ /btw ${overlay}`, ' ┃', ' ┃   Yes, 955k is revenue.', ' ┃ Tab to expand · Enter/Esc to dismiss'];
        return { ok: true, json: undefined, text: [...banner, ...panel, rule, `> ${box}`.trimEnd(), rule, `? for shortcuts${' '.repeat(20)}Gemini 4 Argon · high`].join('\n') };
      }
      if ((command === 'send-text' || command === 'paste-text') && argument !== undefined) box += argument;
      if (command === 'send-keys' && keys.includes('enter')) {
        if (overlay !== undefined && box === '') overlay = undefined;
        else if (box.startsWith('/btw ')) {
          overlay = box.slice('/btw '.length);
          looks = 0;
          box = '';
        }
      }
      changes.push(`${command} ${pane} ${keys.join(' ')}`);
      return { ok: true, json: { result: { type: 'ok' } }, text: '' };
    };
    return { run, changes };
  };

  const ask = btwHerdr(undefined);
  const resume = btwHerdr('Is 955k revenue?');
  const place = /** @type {const} */ ({ found: 'pane', pane: 'w2:p1', working: true });

  const asked = await composerOf(place, ask).btw(conversation, 'Is 955k revenue?');
  const resumed = await composerOf(place, resume).resumeBtw(conversation, 'Is 955k revenue?');

  assert.deepEqual(
    { asked, askChanges: ask.changes, resumed, resumeChanges: resume.changes },
    {
      asked: { ok: true, answer: 'Yes, **955k** is `revenue`.' },
      askChanges: ['paste-text w2:p1 /btw Is 955k revenue?', 'send-keys w2:p1 enter', 'send-keys w2:p1 enter'],
      resumed: { ok: true, answer: 'Yes, **955k** is `revenue`.' },
      resumeChanges: ['send-keys w2:p1 enter'],
    },
  );
});
