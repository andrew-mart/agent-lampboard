// @ts-check
// Antigravity CLI's (agy) available models, read from `agy models` and cached in memory so the page's model picker
// opens without waiting on a subprocess.
import { execFile } from 'node:child_process';
import { agyEfforts, parseAgyEffort } from '../public/model/agy-models.js';

/**
 * @typedef {import('../public/model/agy-models.js').AgyEffort} AgyEffort
 * @typedef {import('../public/model/agy-models.js').AgyModel} AgyModel
 */

/** Trailing effort tag in an agy model label — e.g. "Gemini 4 Neon (XHigh)"; other parentheticals stay in the name. */
const trailingEffort = /^(.*?)\s*\((low|medium|high|xhigh|max)\)\s*$/i;

/**
 * Parse `agy models` stdout (`<slug>\t<Display Name>`) into grouped base models with canonically ordered effort
 * variants. Each model's first-listed variant becomes its default, matching agy's catalog order.
 * @param {string} output
 * @returns {readonly AgyModel[]}
 */
export function parseAgyModels(output) {
  /** @type {Map<string, { name: string, defaultId: string, defaultEffort: AgyEffort | undefined, byEffort: Map<AgyEffort, string> }>} */
  const groups = new Map();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const id = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (id === '' || label === '' || /\s/.test(id)) continue;
    const parts = trailingEffort.exec(label);
    const base = parts?.[1]?.trim();
    const effort = base !== undefined && base !== '' ? parseAgyEffort(parts?.[2]) : undefined;
    const name = effort !== undefined && base !== undefined ? base : label;
    let group = groups.get(name);
    if (group === undefined) {
      group = { name, defaultId: id, defaultEffort: effort, byEffort: new Map() };
      groups.set(name, group);
    }
    if (effort !== undefined && !group.byEffort.has(effort)) group.byEffort.set(effort, id);
  }
  return [...groups.values()].map(({ name, defaultId, defaultEffort, byEffort }) => ({
    name,
    defaultId,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    efforts: agyEfforts.flatMap((level) => {
      const id = byEffort.get(level);
      return id === undefined ? [] : [{ level, id }];
    }),
  }));
}

/**
 * The executable token of an `--agy-command` string (e.g. `"agy --dangerously-skip-permissions"` -> `"agy"`).
 * @param {string} command
 * @returns {string}
 */
export function agyProgramOf(command) {
  const trimmed = command.trim();
  if (trimmed === '') return 'agy';
  const quoted = /^"([^"]+)"|^'([^']+)'/.exec(trimmed);
  const first = quoted?.[1] ?? quoted?.[2] ?? trimmed.split(/\s+/)[0];
  return first === undefined || first === '' ? 'agy' : first;
}

/**
 * Cached and coalesced reader for agy's model list: reuses a fresh non-empty catalog for `freshMs`, merges concurrent
 * requests into one `agy models` call, falls back to a saved catalog output when the subprocess yields nothing (for
 * example when the viewer runs in a container apart from the agent), and keeps the last known list while backing off
 * for `retryMs` on failure.
 * @param {{ read: () => Promise<string>, fallback?: () => Promise<string>, freshMs?: number, retryMs?: number, now?: () => number }} deps
 * @returns {{ list: () => Promise<readonly AgyModel[]> }}
 */
export function createAgyModels({ read, fallback, freshMs = 10 * 60_000, retryMs = 30_000, now = Date.now }) {
  /** @type {readonly AgyModel[]} */
  let kept = [];
  /** @type {number | undefined} */
  let freshUntil;
  /** @type {Promise<readonly AgyModel[]> | undefined} */
  let loading;

  const loadOnce = async () => {
    const direct = parseAgyModels(await read().catch(() => ''));
    if (direct.length > 0) return direct;
    return fallback === undefined ? [] : parseAgyModels(await fallback().catch(() => ''));
  };

  return {
    list() {
      if (freshUntil !== undefined && now() < freshUntil) return Promise.resolve(kept);
      if (loading !== undefined) return loading;
      loading = loadOnce()
        .then((models) => {
          if (models.length > 0) {
            kept = models;
            freshUntil = now() + freshMs;
          } else {
            freshUntil = now() + retryMs;
          }
          return kept;
        })
        .finally(() => {
          loading = undefined;
        });
      return loading;
    },
  };
}

/**
 * Run `agy models` and return its stdout, or an empty string if agy is unavailable.
 * @param {string} agyCommand
 * @returns {Promise<string>}
 */
export async function readAgyModelsOutput(agyCommand) {
  const program = agyProgramOf(agyCommand);
  const first = await runModels(program);
  if (first.ok) return first.stdout;
  if (process.platform === 'win32' && first.missing && program.toLowerCase() !== 'agy') {
    const fallback = await runModels('agy');
    if (fallback.ok) return fallback.stdout;
  }
  return '';
}

/**
 * @param {string} program
 * @returns {Promise<{ ok: true, stdout: string } | { ok: false, missing: boolean }>}
 */
function runModels(program) {
  return new Promise((resolve) => {
    execFile(program, ['models'], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) {
        resolve({ ok: true, stdout: String(stdout) });
        return;
      }
      resolve({ ok: false, missing: 'code' in error && error.code === 'ENOENT' });
    });
  });
}
