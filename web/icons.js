// @ts-check

/**
 * Inline SVG icons from the sprite embedded in index.html. Icons are
 * decorative: the surrounding button keeps its accessible name.
 * @param {string} name symbol id without the `icon-` prefix
 */
export function iconMarkup(name) {
  return `<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
}

/**
 * Icon followed by a visible text label.
 * @param {string} name
 * @param {string} label plain text; it is escaped
 */
export function iconLabelMarkup(name, label) {
  const text = label.replace(/[&<>"]/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[character] ?? character);
  return `${iconMarkup(name)}<span>${text}</span>`;
}
