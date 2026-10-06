// @ts-check

import {centeredCrop, clamp, clampCrop, normalizePhotoRotation, refitCropAroundCenter, rotatedSourceDimensions} from './geometry.js';
import {
  beginHistoryTransaction,
  cancelHistoryTransaction,
  commitHistory,
  createHistory,
  endHistoryTransaction,
  redoHistory,
  replaceHistoryPresent,
  resetHistory,
  undoHistory,
  updateHistoryTransaction,
} from './history.js';
import {assertProject, createPlacement, getCanvasAspect} from './model.js';
import {MAX_PROJECT_TITLE_LENGTH, normalizeProjectTitle} from './filenames.js';
import {normalizeHexColor} from './palette.js';
import {getTemplate} from './templates.js';
import {HISTORY_LIMIT} from './types.js';

/** @typedef {import('./types.js').CollageAction} CollageAction */
/** @typedef {import('./types.js').FrameSettings} FrameSettings */
/** @typedef {import('./types.js').PhotoPlacement} PhotoPlacement */
/** @typedef {import('./types.js').PhotoSource} PhotoSource */
/** @typedef {import('./types.js').PrintSettings} PrintSettings */
/** @typedef {import('./types.js').ProjectState} ProjectState */

export const ActionTypes = Object.freeze({
  REGISTER_SOURCES: 'sources/register',
  REMOVE_SOURCE: 'sources/remove',
  ADD_PLACEMENT: 'placements/add',
  REMOVE_PLACEMENT: 'placements/remove',
  MOVE_PLACEMENT: 'placements/move',
  SET_CROP: 'placements/set-crop',
  AUTOFILL: 'placements/autofill',
  SET_TEMPLATE: 'layout/set-template',
  SET_BACKGROUND: 'appearance/set-background',
  SET_FRAME: 'appearance/set-frame',
  SET_GAP: 'appearance/set-gap',
  SET_PRINT: 'print/set',
  SET_TITLE: 'project/set-title',
  REPLACE_PROJECT: 'project/replace',
});

/**
 * @param {ProjectState} project
 * @param {import('./types.js').CollageTemplate} template
 * @param {PrintSettings} [print]
 * @param {'template'|'print'} [reason]
 */
function reconcileLayout(project, template, print = project.print, reason = 'template') {
  const activeIds = project.layout.order.filter((id) => Boolean(id));
  const order = template.cells.map((_, index) => activeIds[index] || null);
  const keptIds = new Set(order.filter((id) => Boolean(id)));
  /** @type {Record<string, PhotoPlacement>} */
  const placements = {};
  const canvasAspect = (() => {
    const draft = {...project, print};
    return getCanvasAspect(draft);
  })();
  const previousTemplate = getTemplate(project.layout.templateId);
  const previousCanvasAspect = getCanvasAspect(project);
  order.forEach((id, cellIndex) => {
    if (!id) return;
    const placement = project.placements[id];
    const source = placement && project.sources[placement.sourceId];
    if (!placement || !source || !keptIds.has(id)) return;
    const cell = template.cells[cellIndex];
    const targetAspect = canvasAspect * cell.rect.width / cell.rect.height;
    const previousCell = previousTemplate.cells[cellIndex];
    const previousAspect = previousCell ? previousCanvasAspect * previousCell.rect.width / previousCell.rect.height : NaN;
    const sameAspect = Number.isFinite(previousAspect) && Math.abs(previousAspect - targetAspect) <= 1e-7 * Math.max(1, previousAspect, targetAspect);
    const dimensions = rotatedSourceDimensions(source.width, source.height, placement.rotation);
    placements[id] = reason === 'print'
      ? placement.cropMode === 'proportional' ? {
        ...placement,
        crop: refitCropAroundCenter(placement.crop, dimensions.width, dimensions.height, targetAspect),
      } : placement
      : sameAspect ? placement : {
        ...placement,
        crop: centeredCrop(dimensions.width, dimensions.height, targetAspect),
      };
  });
  return {...project, print, placements, layout: {templateId: template.id, order}};
}

/**
 * Proportional crops always match their current destination cell. Free crops
 * deliberately keep their geometry when a photo is moved.
 * @param {ProjectState} project
 * @param {PhotoPlacement} placement
 * @param {number} cellIndex
 */
function refitPlacementForCell(project, placement, cellIndex) {
  if (placement.cropMode !== 'proportional') return placement;
  const source = project.sources[placement.sourceId];
  const cell = getTemplate(project.layout.templateId).cells[cellIndex];
  if (!source || !cell) return placement;
  const targetAspect = getCanvasAspect(project) * cell.rect.width / cell.rect.height;
  const dimensions = rotatedSourceDimensions(source.width, source.height, placement.rotation);
  return {
    ...placement,
    crop: refitCropAroundCenter(placement.crop, dimensions.width, dimensions.height, targetAspect),
  };
}

/** @param {ProjectState} project @param {CollageAction} action @returns {ProjectState} */
export function collageReducer(project, action) {
  switch (action.type) {
    case ActionTypes.REGISTER_SOURCES: {
      /** @type {PhotoSource[]} */
      const incoming = action.payload?.sources || [];
      const sources = {...project.sources};
      for (const source of incoming) sources[source.id] = {...source};
      return incoming.length ? {...project, sources} : project;
    }
    case ActionTypes.REMOVE_SOURCE: {
      const sourceId = String(action.payload?.sourceId || '');
      if (!project.sources[sourceId]) return project;
      if (Object.values(project.placements).some(placement => placement.sourceId === sourceId)) return project;
      const sources = {...project.sources};
      delete sources[sourceId];
      return {...project, sources};
    }
    case ActionTypes.ADD_PLACEMENT: {
      const source = project.sources[action.payload?.sourceId];
      const cellIndex = Number(action.payload?.cellIndex);
      if (!source || !Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= project.layout.order.length || project.layout.order[cellIndex]) return project;
      const id = String(action.payload?.id || '');
      if (!id || project.placements[id]) return project;
      const template = getTemplate(project.layout.templateId);
      const cell = template.cells[cellIndex];
      const targetAspect = getCanvasAspect(project) * cell.rect.width / cell.rect.height;
      const placement = createPlacement(source, targetAspect, {
        id,
        crop: action.payload?.crop,
        cropMode: action.payload?.cropMode,
        rotation: action.payload?.rotation,
      });
      const order = [...project.layout.order];
      order[cellIndex] = placement.id;
      return {...project, placements: {...project.placements, [placement.id]: placement}, layout: {...project.layout, order}};
    }
    case ActionTypes.REMOVE_PLACEMENT: {
      const placementId = String(action.payload?.placementId || '');
      if (!project.placements[placementId]) return project;
      const placements = {...project.placements};
      delete placements[placementId];
      return {...project, placements, layout: {...project.layout, order: project.layout.order.map(id => id === placementId ? null : id)}};
    }
    case ActionTypes.MOVE_PLACEMENT: {
      const fromIndex = Number(action.payload?.fromIndex);
      const toIndex = Number(action.payload?.toIndex);
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= project.layout.order.length || toIndex >= project.layout.order.length || fromIndex === toIndex || !project.layout.order[fromIndex]) return project;
      const order = [...project.layout.order];
      [order[fromIndex], order[toIndex]] = [order[toIndex], order[fromIndex]];
      const placements = {...project.placements};
      const movedToTarget = order[toIndex];
      const movedToSource = order[fromIndex];
      if (movedToTarget) placements[movedToTarget] = refitPlacementForCell(project, placements[movedToTarget], toIndex);
      if (movedToSource) placements[movedToSource] = refitPlacementForCell(project, placements[movedToSource], fromIndex);
      return {...project, placements, layout: {...project.layout, order}};
    }
    case ActionTypes.SET_CROP: {
      const placement = project.placements[action.payload?.placementId];
      if (!placement) return project;
      const cropMode = action.payload?.cropMode || placement.cropMode;
      if (cropMode !== 'proportional' && cropMode !== 'free') return project;
      const cellIndex = project.layout.order.indexOf(placement.id);
      const clamped = {...placement, crop: clampCrop(action.payload?.crop), cropMode, rotation: normalizePhotoRotation(action.payload?.rotation ?? placement.rotation)};
      const next = cellIndex >= 0 ? refitPlacementForCell(project, clamped, cellIndex) : clamped;
      return {...project, placements: {...project.placements, [placement.id]: next}};
    }
    case ActionTypes.AUTOFILL: {
      /** @type {{id: string, sourceId: string}[]} */
      const items = action.payload?.items || [];
      const template = getTemplate(project.layout.templateId);
      /** @type {(string|null)[]} */
      const order = template.cells.map(() => null);
      /** @type {Record<string, PhotoPlacement>} */
      const placements = {};
      items.slice(0, order.length).forEach((item, index) => {
        const source = project.sources[item.sourceId];
        if (!source || !item.id || placements[item.id]) return;
        const cell = template.cells[index];
        const targetAspect = getCanvasAspect(project) * cell.rect.width / cell.rect.height;
        const placement = createPlacement(source, targetAspect, {id: item.id});
        placements[placement.id] = placement;
        order[index] = placement.id;
      });
      return {...project, placements, layout: {...project.layout, order}};
    }
    case ActionTypes.SET_TEMPLATE: {
      const template = getTemplate(String(action.payload?.templateId || ''));
      if (template.id === project.layout.templateId) return project;
      return reconcileLayout(project, template);
    }
    case ActionTypes.SET_BACKGROUND: {
      const backgroundColor = normalizeHexColor(action.payload?.color);
      return backgroundColor === project.appearance.backgroundColor ? project : {...project, appearance: {...project.appearance, backgroundColor}};
    }
    case ActionTypes.SET_FRAME: {
      const patch = /** @type {Partial<FrameSettings>} */ (action.payload?.frame || {});
      const frame = {...project.appearance.frame, ...patch};
      if (!['none', 'white', 'color'].includes(frame.mode)) throw new RangeError(`Unknown frame mode: ${frame.mode}`);
      if (!['straight', 'rounded', 'zigzag', 'wave', 'lightning', 'deckle', 'stamp', 'perforated', 'old-photo', 'polaroid'].includes(frame.edgeStyle)) throw new RangeError(`Unknown edge style: ${frame.edgeStyle}`);
      frame.color = normalizeHexColor(frame.color);
      frame.depth = clamp(Number(frame.depth));
      frame.frequency = clamp(Number(frame.frequency));
      return {...project, appearance: {...project.appearance, frame}};
    }
    case ActionTypes.SET_GAP: {
      const gapMm = Math.max(0, Number(action.payload?.gapMm));
      if (!Number.isFinite(gapMm) || gapMm === project.appearance.gapMm) return project;
      return {...project, appearance: {...project.appearance, gapMm}};
    }
    case ActionTypes.SET_PRINT: {
      const print = {...project.print, ...action.payload?.print};
      if (!Number.isFinite(print.ppi) || print.ppi < 72 || ![0, 2].includes(print.bleedMm)) throw new RangeError('Invalid print settings');
      return reconcileLayout(project, getTemplate(project.layout.templateId), print, 'print');
    }
    case ActionTypes.SET_TITLE: {
      const title = normalizeProjectTitle(action.payload?.title).slice(0, MAX_PROJECT_TITLE_LENGTH);
      return title === (project.title || '') ? project : {...project, title};
    }
    case ActionTypes.REPLACE_PROJECT: {
      assertProject(action.payload?.project);
      return action.payload.project;
    }
    default:
      return project;
  }
}

/** @param {string} label @param {string=} coalesceKey */
const meta = (label, coalesceKey) => ({label, ...(coalesceKey ? {coalesceKey} : {})});

export const actions = Object.freeze({
  /** @param {PhotoSource[]} sources */
  registerSources: (sources) => ({type: ActionTypes.REGISTER_SOURCES, payload: {sources}, meta: {skip: true}}),
  /** @param {string} sourceId */
  removeSource: (sourceId) => ({type: ActionTypes.REMOVE_SOURCE, payload: {sourceId}, meta: meta('Убрана исходная фотография')}),
  /** @param {{id: string, sourceId: string, cellIndex: number, crop?: import('./types.js').CropRect, cropMode?: import('./types.js').CropMode, rotation?: import('./types.js').PhotoRotation}} placement */
  addPlacement: (placement) => ({type: ActionTypes.ADD_PLACEMENT, payload: placement, meta: meta('Добавлена фотография')}),
  /** @param {string} placementId */
  removePlacement: (placementId) => ({type: ActionTypes.REMOVE_PLACEMENT, payload: {placementId}, meta: meta('Убрана фотография')}),
  /** @param {number} fromIndex @param {number} toIndex */
  movePlacement: (fromIndex, toIndex) => ({type: ActionTypes.MOVE_PLACEMENT, payload: {fromIndex, toIndex}, meta: meta('Перемещение фотографии')}),
  /** @param {string} placementId @param {import('./types.js').CropRect} crop @param {import('./types.js').CropMode} cropMode @param {import('./types.js').PhotoRotation=} rotation */
  setCrop: (placementId, crop, cropMode, rotation) => ({type: ActionTypes.SET_CROP, payload: {placementId, crop, cropMode, rotation}, meta: meta('Кроп фотографии')}),
  /** @param {{id: string, sourceId: string}[]} items */
  autofill: (items) => ({type: ActionTypes.AUTOFILL, payload: {items}, meta: meta('Автозаполнение')}),
  /** @param {string} templateId */
  setTemplate: (templateId) => ({type: ActionTypes.SET_TEMPLATE, payload: {templateId}, meta: meta('Смена шаблона')}),
  /** @param {string} color */
  setBackground: (color) => ({type: ActionTypes.SET_BACKGROUND, payload: {color}, meta: meta('Цвет фона')}),
  /** @param {Partial<FrameSettings>} frame @param {string=} coalesceKey */
  setFrame: (frame, coalesceKey) => ({type: ActionTypes.SET_FRAME, payload: {frame}, meta: meta('Настройки рамки', coalesceKey)}),
  /** @param {number} gapMm */
  setGap: (gapMm) => ({type: ActionTypes.SET_GAP, payload: {gapMm}, meta: meta('Толщина рамки', 'gap')}),
  /** @param {Partial<PrintSettings>} print */
  setPrint: (print) => ({type: ActionTypes.SET_PRINT, payload: {print}, meta: meta('Формат печати')}),
  /** @param {string} title */
  setTitle: (title) => ({type: ActionTypes.SET_TITLE, payload: {title}, meta: meta('Название коллажа', 'project-title')}),
  /** @param {ProjectState} project */
  replaceProject: (project) => ({type: ActionTypes.REPLACE_PROJECT, payload: {project}, meta: {skip: true}}),
});

/**
 * @param {ProjectState} initialState
 * @param {{historyLimit?: number}=} options
 */
export function createCollageStore(initialState, options = {}) {
  assertProject(initialState);
  let history = createHistory(initialState, options.historyLimit || HISTORY_LIMIT);
  /** @type {Set<(state: ProjectState) => void>} */
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener(history.present));

  return Object.freeze({
    getState: () => history.present,
    getHistory: () => ({
      past: history.past.map(entry => entry.label),
      future: history.future.map(entry => entry.label),
      limit: history.limit,
      transactionKey: history.transaction?.key || null,
    }),
    /** @param {(state: ProjectState) => void} listener */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** @param {CollageAction} action */
    dispatch(action) {
      const next = collageReducer(history.present, action);
      if (action.type === ActionTypes.REPLACE_PROJECT) history = resetHistory(history, next);
      else if (history.transaction) history = updateHistoryTransaction(history, next);
      else if (action.meta?.skip) history = replaceHistoryPresent(history, next);
      else history = commitHistory(history, next, action.meta);
      notify();
      return history.present;
    },
    undo() { history = undoHistory(history); notify(); return history.present; },
    redo() { history = redoHistory(history); notify(); return history.present; },
    /** @param {string} key @param {string=} label */
    beginTransaction(key, label) { history = beginHistoryTransaction(history, key, label); },
    endTransaction() { history = endHistoryTransaction(history); notify(); return history.present; },
    cancelTransaction() { history = cancelHistoryTransaction(history); notify(); return history.present; },
    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,
  });
}
