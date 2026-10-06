// @ts-check

/** Current on-disk collage project schema. */
export const PROJECT_FORMAT_VERSION = 1;

/** Maximum number of undoable editor operations. */
export const HISTORY_LIMIT = 20;

/** @typedef {'landscape' | 'portrait'} PrintOrientation */
/** @typedef {'none' | 'white' | 'color'} PhotoFrameMode */
/** @typedef {'straight' | 'rounded' | 'zigzag' | 'wave' | 'lightning' | 'deckle' | 'stamp' | 'perforated' | 'old-photo' | 'polaroid'} EdgeStyle */
/** @typedef {'proportional' | 'free'} CropMode */
/** @typedef {0 | 90 | 180 | 270} PhotoRotation */

/**
 * @typedef {object} NormalizedRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} CropRect
 * @property {number} x Source-relative coordinate in the 0..1 range.
 * @property {number} y Source-relative coordinate in the 0..1 range.
 * @property {number} width Source-relative width in the 0..1 range.
 * @property {number} height Source-relative height in the 0..1 range.
 */

/**
 * @typedef {object} PhotoSource
 * @property {string} id Stable identity derived from the library-relative path.
 * @property {string} path Library-relative source path.
 * @property {string} name
 * @property {string} folderPath
 * @property {number} size
 * @property {string} modTime
 * @property {number} width
 * @property {number} height
 * @property {string=} mimeType
 * @property {string=} sourceUrl Transient object URL for a photo embedded in a loaded ZIP.
 * @property {boolean=} available Transient availability override; never serialized.
 */

/**
 * @typedef {object} PhotoPlacement
 * @property {string} id Unique instance identity. Several placements may use one source.
 * @property {string} sourceId
 * @property {CropRect} crop
 * @property {CropMode} cropMode
 * @property {PhotoRotation=} rotation Clockwise display rotation. Missing means 0 for backwards-compatible projects.
 */

/**
 * @typedef {object} TemplateCell
 * @property {string} id
 * @property {NormalizedRect} rect
 * @property {'any' | 'landscape' | 'portrait' | 'square'} preferredOrientation
 */

/**
 * @typedef {object} CollageTemplate
 * @property {string} id
 * @property {number} photoCount
 * @property {string} family
 * @property {TemplateCell[]} cells
 */

/**
 * @typedef {object} PrintSettings
 * @property {string} formatId
 * @property {PrintOrientation} orientation
 * @property {number} ppi
 * @property {0 | 2} bleedMm Per-side bleed.
 */

/**
 * @typedef {object} FrameSettings
 * @property {PhotoFrameMode} mode
 * @property {string} color
 * @property {EdgeStyle} edgeStyle
 * @property {number} depth Normalized edge depth in the 0..1 range.
 * @property {number} frequency Normalized element frequency in the 0..1 range.
 */

/**
 * @typedef {object} AppearanceSettings
 * @property {string} backgroundColor
 * @property {number} gapMm Physical gap between cells.
 * @property {FrameSettings} frame
 */

/**
 * @typedef {object} LayoutState
 * @property {string} templateId
 * @property {(string | null)[]} order Placement IDs aligned with template cells.
 */

/**
 * @typedef {object} ProjectState
 * @property {number} formatVersion
 * @property {string} appVersion
 * @property {string=} title Human-readable project name. Missing in projects created before naming was added.
 * @property {PrintSettings} print
 * @property {Record<string, PhotoSource>} sources
 * @property {Record<string, PhotoPlacement>} placements
 * @property {LayoutState} layout
 * @property {AppearanceSettings} appearance
 */

/**
 * @typedef {object} HistoryMeta
 * @property {string=} label
 * @property {string=} coalesceKey
 * @property {boolean=} skip
 */

/**
 * @typedef {object} CollageAction
 * @property {string} type
 * @property {any=} payload
 * @property {HistoryMeta=} meta
 */
