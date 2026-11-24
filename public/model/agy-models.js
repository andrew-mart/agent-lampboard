// @ts-check
// Antigravity CLI's (agy) models and their supported effort variants, shared between the server (/api/agy/models)
// and the session header's model picker.
import { isRecord } from './narrow.js';

/**
 * @typedef {'low' | 'medium' | 'high' | 'xhigh' | 'max'} AgyEffort
 * @typedef {Readonly<{ level: AgyEffort, id: string }>} AgyEffortVariant
 * @typedef {Readonly<{ name: string, defaultId: string, defaultEffort?: AgyEffort, efforts: readonly AgyEffortVariant[] }>} AgyModel
 * @typedef {Readonly<{ id: string, model: string, effort: AgyEffort | undefined }>} AgySelection
 */

/** Canonical order of agy's reasoning effort levels, least first. @type {readonly AgyEffort[]} */
export const agyEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Narrow an unknown value to a known agy effort level.
 * @param {unknown} value
 * @returns {AgyEffort | undefined}
 */
export function parseAgyEffort(value) {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  return agyEfforts.find((effort) => effort === lowered);
}

/**
 * Whether a model slug can be passed straight to `/model <id>` without breaking command parsing.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function modelId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || /\s/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed) ? undefined : trimmed;
}

/**
 * Parse a `/api/agy/models` reply at the network boundary, keeping only valid models and sorting their efforts
 * canonically from least to most.
 * @param {unknown} raw
 * @returns {readonly AgyModel[]}
 */
export function parseAgyModelsReply(raw) {
  if (!isRecord(raw) || !Array.isArray(raw.models)) return [];
  /** @type {AgyModel[]} */
  const models = [];
  for (const item of raw.models) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const defaultId = modelId(item.defaultId);
    if (name === '' || defaultId === undefined || !Array.isArray(item.efforts)) continue;
    /** @type {Map<AgyEffort, string>} */
    const byEffort = new Map();
    for (const variant of item.efforts) {
      if (!isRecord(variant)) continue;
      const level = parseAgyEffort(variant.level);
      const id = modelId(variant.id);
      if (level !== undefined && id !== undefined && !byEffort.has(level)) byEffort.set(level, id);
    }
    const efforts = agyEfforts.flatMap((level) => {
      const id = byEffort.get(level);
      return id === undefined ? [] : [{ level, id }];
    });
    const defaultEffort = parseAgyEffort(item.defaultEffort);
    models.push({
      name,
      defaultId,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      efforts,
    });
  }
  return models;
}

/**
 * Find the catalog entry matching a session's active model name (exact first, then case-insensitive).
 * @param {readonly AgyModel[]} models
 * @param {string | undefined} name
 * @returns {AgyModel | undefined}
 */
export function findAgyModel(models, name) {
  if (name === undefined) return undefined;
  const trimmed = name.trim();
  if (trimmed === '') return undefined;
  const exact = models.find((one) => one.name === trimmed);
  if (exact !== undefined) return exact;
  const lowered = trimmed.toLowerCase();
  return models.find((one) => one.name.toLowerCase() === lowered);
}

/**
 * Target model slug and effort when switching to a model while preserving the current effort where possible:
 * exact match first, otherwise the closest supported effort (breaking ties toward higher), or the model's own
 * default when coming from a model without effort.
 * @param {AgyModel} model
 * @param {string | undefined} preferredEffort
 * @returns {AgySelection}
 */
export function pickAgyModel(model, preferredEffort) {
  if (model.efforts.length === 0) return { id: model.defaultId, model: model.name, effort: undefined };
  const wanted = parseAgyEffort(preferredEffort);
  if (wanted === undefined) return { id: model.defaultId, model: model.name, effort: model.defaultEffort ?? model.efforts[0]?.level };
  const exact = model.efforts.find((variant) => variant.level === wanted);
  if (exact !== undefined) return { id: exact.id, model: model.name, effort: exact.level };
  const targetRank = agyEfforts.indexOf(wanted);
  let best = model.efforts[0];
  if (best === undefined) return { id: model.defaultId, model: model.name, effort: model.defaultEffort };
  let bestDistance = Math.abs(agyEfforts.indexOf(best.level) - targetRank);
  for (const variant of model.efforts.slice(1)) {
    const distance = Math.abs(agyEfforts.indexOf(variant.level) - targetRank);
    if (distance <= bestDistance) {
      best = variant;
      bestDistance = distance;
    }
  }
  return { id: best.id, model: model.name, effort: best.level };
}

/**
 * Target model slug when changing effort on the current model.
 * @param {AgyModel} model
 * @param {AgyEffort} level
 * @returns {AgySelection | undefined}
 */
export function pickAgyEffort(model, level) {
  const variant = model.efforts.find((one) => one.level === level);
  return variant === undefined ? undefined : { id: variant.id, model: model.name, effort: variant.level };
}
