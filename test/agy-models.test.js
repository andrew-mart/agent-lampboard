import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAgyModel, parseAgyModelsReply, pickAgyEffort, pickAgyModel } from '../public/model/agy-models.js';
import { agyProgramOf, createAgyModels, parseAgyModels } from '../server/agy-models.js';

// The viewer's /api/agy/models reply is parsed strictly at the boundary: valid models (with efforts in canonical order,
// or with none such as Orchestrators) are kept, while malformed entries or unknown effort levels are dropped
test('parseAgyModelsReply_Should_KeepValidModelsAndDropMalformedEntries', () => {
  const parsed = parseAgyModelsReply({
    models: [
      {
        name: 'Gemini 4 Neon',
        defaultId: 'gemini-4-neon-high',
        defaultEffort: 'high',
        efforts: [
          { level: 'high', id: 'gemini-4-neon-high' },
          { level: 'bogus', id: 'gemini-4-neon-bogus' },
          { level: 'low', id: 'gemini-4-neon-low' },
          { level: 'xhigh', id: 'gemini-4-neon-xhigh' },
        ],
      },
      {
        name: 'Orchestrator (Neon)',
        defaultId: 'gemini-pro-orchestrator-neon',
        efforts: [],
      },
      { name: '', defaultId: 'bad', efforts: [] },
      { name: 'Broken', defaultId: 'has spaces', efforts: [] },
      null,
    ],
  });

  assert.deepEqual(parsed, [
    {
      name: 'Gemini 4 Neon',
      defaultId: 'gemini-4-neon-high',
      defaultEffort: 'high',
      efforts: [
        { level: 'low', id: 'gemini-4-neon-low' },
        { level: 'high', id: 'gemini-4-neon-high' },
        { level: 'xhigh', id: 'gemini-4-neon-xhigh' },
      ],
    },
    {
      name: 'Orchestrator (Neon)',
      defaultId: 'gemini-pro-orchestrator-neon',
      efforts: [],
    },
  ]);
  assert.deepEqual(parseAgyModelsReply(undefined), []);
});

// Switching models preserves the current effort when supported, falls back to the nearest effort (never dropping
// from xhigh down to low just because low was listed first), uses the model's default when coming from a model
// without effort, and drops effort when switching to an Orchestrator
test('pickAgyModel_And_pickAgyEffort_Should_ChooseExactOrNearestEffortVariant', () => {
  /** @type {readonly import('../public/model/agy-models.js').AgyModel[]} */
  const models = [
    {
      name: 'Gemini 4 Neon',
      defaultId: 'gemini-4-neon-high',
      defaultEffort: 'high',
      efforts: [
        { level: 'low', id: 'gemini-4-neon-low' },
        { level: 'medium', id: 'gemini-4-neon-medium' },
        { level: 'high', id: 'gemini-4-neon-high' },
        { level: 'xhigh', id: 'gemini-4-neon-xhigh' },
      ],
    },
    {
      name: 'Claude Opus 5.5',
      defaultId: 'claude-opus-5-5-low',
      defaultEffort: 'low',
      efforts: [
        { level: 'low', id: 'claude-opus-5-5-low' },
        { level: 'medium', id: 'claude-opus-5-5-medium' },
        { level: 'high', id: 'claude-opus-5-5-high' },
      ],
    },
    {
      name: 'Orchestrator (Neon)',
      defaultId: 'gemini-pro-orchestrator-neon',
      efforts: [],
    },
  ];
  const [neon, opus, orchestrator] = models;
  assert.ok(neon !== undefined && opus !== undefined && orchestrator !== undefined);

  assert.deepEqual(
    {
      found: findAgyModel(models, 'gemini 4 neon')?.name,
      keepExact: pickAgyModel(neon, 'xhigh'),
      nearestDown: pickAgyModel(opus, 'xhigh'),
      fromNoEffort: pickAgyModel(neon, undefined),
      toOrchestrator: pickAgyModel(orchestrator, 'xhigh'),
      setEffort: pickAgyEffort(opus, 'medium'),
      unsupportedEffort: pickAgyEffort(opus, 'xhigh'),
    },
    {
      found: 'Gemini 4 Neon',
      keepExact: { id: 'gemini-4-neon-xhigh', model: 'Gemini 4 Neon', effort: 'xhigh' },
      nearestDown: { id: 'claude-opus-5-5-high', model: 'Claude Opus 5.5', effort: 'high' },
      fromNoEffort: { id: 'gemini-4-neon-high', model: 'Gemini 4 Neon', effort: 'high' },
      toOrchestrator: { id: 'gemini-pro-orchestrator-neon', model: 'Orchestrator (Neon)', effort: undefined },
      setEffort: { id: 'claude-opus-5-5-medium', model: 'Claude Opus 5.5', effort: 'medium' },
      unsupportedEffort: undefined,
    },
  );
});

// `agy models` prints flat `<slug>\t<Label (Effort)>` lines: grouping by base model keeps catalog order, records
// each model's first-listed variant as its default, orders efforts canonically, and keeps non-effort parentheticals
// like `Orchestrator (Neon)` as distinct models without efforts
test('parseAgyModels_Should_GroupEffortsByBaseModelAndPreserveOrchestrators', () => {
  const output = [
    'Fetching available models...',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
    'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    '',
  ].join('\r\n');

  assert.deepEqual(parseAgyModels(output), [
    {
      name: 'Gemini 4 Neon',
      defaultId: 'gemini-4-neon-high',
      defaultEffort: 'high',
      efforts: [
        { level: 'low', id: 'gemini-4-neon-low' },
        { level: 'medium', id: 'gemini-4-neon-medium' },
        { level: 'high', id: 'gemini-4-neon-high' },
        { level: 'xhigh', id: 'gemini-4-neon-xhigh' },
      ],
    },
    {
      name: 'Orchestrator (Neon)',
      defaultId: 'gemini-pro-orchestrator-neon',
      efforts: [],
    },
    {
      name: 'Orchestrator (Carbon)',
      defaultId: 'gemini-pro-orchestrator',
      efforts: [],
    },
    {
      name: 'Claude Opus 5.5',
      defaultId: 'claude-opus-5-5-low',
      defaultEffort: 'low',
      efforts: [
        { level: 'low', id: 'claude-opus-5-5-low' },
        { level: 'high', id: 'claude-opus-5-5-high' },
      ],
    },
    {
      name: 'GPT-OSS 120B',
      defaultId: 'gpt-oss-120b-medium',
      defaultEffort: 'medium',
      efforts: [{ level: 'medium', id: 'gpt-oss-120b-medium' }],
    },
  ]);

  assert.deepEqual(
    {
      withFlags: agyProgramOf('agy --dangerously-skip-permissions'),
      quoted: agyProgramOf('"C:\\Program Files\\agy\\agy.exe" --flag'),
      wrapper: agyProgramOf('agy-god'),
      blank: agyProgramOf('   '),
    },
    {
      withFlags: 'agy',
      quoted: 'C:\\Program Files\\agy\\agy.exe',
      wrapper: 'agy-god',
      blank: 'agy',
    },
  );
});

// Models are cached across requests, concurrent callers share one `agy models` call, and a later failure keeps the
// last known catalog while backing off before retrying
test('createAgyModels_Should_CacheCoalesceAndKeepPreviousListOnFailure', async () => {
  let clock = 10_000;
  let reads = 0;
  /** @type {(() => Promise<string>)[]} */
  const replies = [
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'gemini-4-neon-high\tGemini 4 Neon (High)\n';
    },
    async () => '',
    async () => 'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n',
  ];
  const models = createAgyModels({
    read: () => {
      reads += 1;
      const next = replies.shift();
      return next === undefined ? Promise.resolve('') : next();
    },
    freshMs: 60_000,
    retryMs: 5_000,
    now: () => clock,
  });

  // Two concurrent callers trigger a single subprocess read
  const [first, second] = await Promise.all([models.list(), models.list()]);
  // Within freshMs, cache serves without reading again
  clock += 30_000;
  const cached = await models.list();
  // Past freshMs, an empty/failed read keeps the last known catalog and backs off for retryMs
  clock += 40_000;
  const onFailure = await models.list();
  clock += 2_000;
  const duringBackoff = await models.list();
  // Past retryMs, a fresh read succeeds and updates the catalog
  clock += 4_000;
  const refreshed = await models.list();

  assert.deepEqual(
    {
      reads,
      first: first.map((one) => one.name),
      second: second.map((one) => one.name),
      cached: cached.map((one) => one.name),
      onFailure: onFailure.map((one) => one.name),
      duringBackoff: duringBackoff.map((one) => one.name),
      refreshed: refreshed.map((one) => one.name),
    },
    {
      reads: 3,
      first: ['Gemini 4 Neon'],
      second: ['Gemini 4 Neon'],
      cached: ['Gemini 4 Neon'],
      onFailure: ['Gemini 4 Neon'],
      duringBackoff: ['Gemini 4 Neon'],
      refreshed: ['Gemini 4 Hydrogen'],
    },
  );
});

// When the viewer cannot run `agy models` directly (for example in a container apart from the agent), it falls back to
// a saved catalog output; when `agy models` answers directly, the fallback is not needed
test('createAgyModels_Should_FallBackToSavedOutput_WhenSubprocessReturnsNothing', async () => {
  let fallbackCalls = 0;
  const fromFallback = createAgyModels({
    read: async () => '',
    fallback: async () => {
      fallbackCalls += 1;
      return 'gemini-4-argon-high\tGemini 4 Argon (High)\n';
    },
  });
  let directFallbackCalls = 0;
  const fromDirect = createAgyModels({
    read: async () => 'gemini-4-neon-high\tGemini 4 Neon (High)\n',
    fallback: async () => {
      directFallbackCalls += 1;
      return 'gemini-4-argon-high\tGemini 4 Argon (High)\n';
    },
  });

  const [fallbackList, directList] = await Promise.all([fromFallback.list(), fromDirect.list()]);

  assert.deepEqual(
    {
      fallbackModels: fallbackList.map((one) => one.name),
      fallbackCalls,
      directModels: directList.map((one) => one.name),
      directFallbackCalls,
    },
    {
      fallbackModels: ['Gemini 4 Argon'],
      fallbackCalls: 1,
      directModels: ['Gemini 4 Neon'],
      directFallbackCalls: 0,
    },
  );
});
