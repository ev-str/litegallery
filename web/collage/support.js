// @ts-check

/**
 * Formats that the gallery shows but browsers cannot decode for collages.
 * Shared by the gallery selection (web/app.js) and the collage editor.
 */
const UNSUPPORTED_COLLAGE_EXTENSION = /\.tiff?$/i;

/** @param {string} path */
export function isCollageSupportedPath(path) {
  return !UNSUPPORTED_COLLAGE_EXTENSION.test(String(path));
}
