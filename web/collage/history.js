// @ts-check

import {HISTORY_LIMIT} from './types.js';

/** @template T @typedef {{state: T, label: string, coalesceKey: string | null}} HistoryEntry */
/** @template T @typedef {{base: T, label: string, key: string, previousCoalesceKey: string | null}} HistoryTransaction */
/** @template T @typedef {{past: HistoryEntry<T>[], present: T, future: HistoryEntry<T>[], limit: number, lastCoalesceKey: string | null, transaction: HistoryTransaction<T> | null}} HistoryState */

/** @template T @param {T} initialState @param {number} [limit] @returns {HistoryState<T>} */
export function createHistory(initialState, limit = HISTORY_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('History limit must be a positive integer');
  return {past: [], present: initialState, future: [], limit, lastCoalesceKey: null, transaction: null};
}

/**
 * @template T
 * @param {HistoryState<T>} history
 * @param {T} nextState
 * @param {{label?: string, coalesceKey?: string}=} meta
 * @returns {HistoryState<T>}
 */
export function commitHistory(history, nextState, meta = {}) {
  if (history.transaction) throw new Error('Use updateHistoryTransaction while a history transaction is active');
  if (Object.is(history.present, nextState)) return history;
  const key = meta.coalesceKey || null;
  if (key && history.lastCoalesceKey === key && history.past.length) {
    return {...history, present: nextState, future: [], lastCoalesceKey: key};
  }
  const entry = {state: history.present, label: meta.label || 'Изменение', coalesceKey: key};
  const past = [...history.past, entry].slice(-history.limit);
  return {...history, past, present: nextState, future: [], lastCoalesceKey: key};
}

/** @template T @param {HistoryState<T>} history @param {T} nextState */
export function replaceHistoryPresent(history, nextState) {
  if (Object.is(history.present, nextState)) return history;
  return {...history, present: nextState};
}

/** @template T @param {HistoryState<T>} history @returns {HistoryState<T>} */
export function undoHistory(history) {
  if (history.transaction) throw new Error('Finish the active history transaction before undo');
  const entry = history.past.at(-1);
  if (!entry) return history;
  const futureEntry = {state: history.present, label: entry.label, coalesceKey: entry.coalesceKey};
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: entry.state,
    future: [futureEntry, ...history.future],
    lastCoalesceKey: null,
  };
}

/** @template T @param {HistoryState<T>} history @returns {HistoryState<T>} */
export function redoHistory(history) {
  if (history.transaction) throw new Error('Finish the active history transaction before redo');
  const entry = history.future[0];
  if (!entry) return history;
  const pastEntry = {state: history.present, label: entry.label, coalesceKey: entry.coalesceKey};
  return {
    ...history,
    past: [...history.past, pastEntry].slice(-history.limit),
    present: entry.state,
    future: history.future.slice(1),
    lastCoalesceKey: null,
  };
}

/**
 * Start a group such as pointerdown..pointerup on a slider. Intermediate
 * updates change the visible state; ending the group records one undo step.
 * @template T
 * @param {HistoryState<T>} history
 * @param {string} key
 * @param {string} [label]
 * @returns {HistoryState<T>}
 */
export function beginHistoryTransaction(history, key, label = 'Изменение') {
  if (history.transaction) throw new Error('A history transaction is already active');
  if (!key) throw new TypeError('History transaction key is required');
  return {...history, transaction: {base: history.present, label, key, previousCoalesceKey: history.lastCoalesceKey}};
}

/** @template T @param {HistoryState<T>} history @param {T} nextState @returns {HistoryState<T>} */
export function updateHistoryTransaction(history, nextState) {
  if (!history.transaction) throw new Error('No active history transaction');
  return Object.is(history.present, nextState) ? history : {...history, present: nextState};
}

/** @template T @param {HistoryState<T>} history @returns {HistoryState<T>} */
export function endHistoryTransaction(history) {
  const transaction = history.transaction;
  if (!transaction) return history;
  if (Object.is(transaction.base, history.present)) return {...history, transaction: null};
  const entry = {state: transaction.base, label: transaction.label, coalesceKey: transaction.key};
  return {
    ...history,
    past: [...history.past, entry].slice(-history.limit),
    future: [],
    transaction: null,
    lastCoalesceKey: transaction.key,
  };
}

/** @template T @param {HistoryState<T>} history @returns {HistoryState<T>} */
export function cancelHistoryTransaction(history) {
  if (!history.transaction) return history;
  return {
    ...history,
    present: history.transaction.base,
    transaction: null,
    lastCoalesceKey: history.transaction.previousCoalesceKey,
  };
}

/** @template T @param {HistoryState<T>} history @param {T} nextState @returns {HistoryState<T>} */
export function resetHistory(history, nextState) {
  return createHistory(nextState, history.limit);
}
