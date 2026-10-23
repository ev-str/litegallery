/** Application surfaces in header order; `gallery` is the default one. */
export const SURFACES = /** @type {const} */ (['gallery', 'search', 'memories', 'collage', 'status']);

/** @typedef {typeof SURFACES[number]} SurfaceName */

/**
 * @typedef {object} Surface
 * @property {{hidden: boolean}} panel container shown only while the surface is current
 * @property {{hidden: boolean, setAttribute(name: string, value: string): void, removeAttribute(name: string): void}} [entry]
 *   header control; hidden until the surface is registered
 * @property {(previous: SurfaceName) => void} [enter] runs after the panel is shown
 * @property {(next: SurfaceName) => void} [leave] runs before the panel is hidden
 */

/**
 * One current application surface. A surface exists only after `register`: its
 * entry stays hidden until then, so unfinished sections never show dead controls.
 * @param {{onChange?: (current: SurfaceName, previous: SurfaceName) => void}} [options]
 */
export function createSurfaces({onChange} = {}) {
  /** @type {Map<SurfaceName, Surface>} */
  const registered = new Map();
  /** @type {SurfaceName} */
  let current = 'gallery';

  /** @param {SurfaceName} name @param {Surface} surface */
  function register(name, surface) {
    if (!SURFACES.includes(name)) throw new Error(`Unknown surface: ${name}`);
    if (registered.has(name)) throw new Error(`Surface already registered: ${name}`);
    registered.set(name, surface);
    surface.panel.hidden = name !== current;
    if (surface.entry) {
      surface.entry.hidden = false;
      markEntry(name, surface);
    }
  }

  /** @param {SurfaceName} name @param {Surface} surface */
  function markEntry(name, surface) {
    if (name === current) surface.entry?.setAttribute('aria-current', 'page');
    else surface.entry?.removeAttribute('aria-current');
  }

  /**
   * @param {SurfaceName} name
   * @returns {boolean} false when the surface is not registered
   */
  function show(name) {
    const next = registered.get(name);
    if (!next) return false;
    if (name === current) return true;
    const previous = current;
    registered.get(previous)?.leave?.(name);
    current = name;
    for (const [key, surface] of registered) {
      surface.panel.hidden = key !== current;
      markEntry(key, surface);
    }
    onChange?.(current, previous);
    next.enter?.(previous);
    return true;
  }

  return {
    register,
    show,
    /** @param {SurfaceName} name */
    has: name => registered.has(name),
    get current() { return current; },
  };
}

/**
 * Open a surface from any `[data-surface-entry]` inside `container`; other
 * controls there leave the current surface alone.
 * @param {{addEventListener(type: 'click', listener: (event: {target: EventTarget | null}) => void): void, contains(node: Node | null): boolean}} container
 * @param {{show(name: SurfaceName): boolean}} surfaces
 */
export function routeSurfaceEntries(container, surfaces) {
  container.addEventListener('click', event => {
    const entry = /** @type {Element | null} */ (event.target)?.closest?.('[data-surface-entry]');
    const name = entry?.getAttribute('data-surface-entry');
    if (entry && name && container.contains(entry)) surfaces.show(/** @type {SurfaceName} */ (name));
  });
}
