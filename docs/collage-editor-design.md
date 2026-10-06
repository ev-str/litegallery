# Collage editor: product and technical decisions

This document records the agreed behaviour and implementation boundaries for
LiteGallery's collage editor. It is project documentation only: the production
binary embeds `web/*`, so files under `docs/` are not included in NAS builds.

## Product goal

Create print-ready photo collages directly from an existing LiteGallery
library without uploading originals to another service and without modifying
the source library. All editing, rendering, project packaging, and export take
place locally in the browser.

## Main flow

1. Open a gallery folder and enter collage-selection mode.
2. Select 2–12 photos. The selection bar shows the count, **Open project**,
   **Make collage**, and **Cancel**. **Open project** accepts the same validated
   JSON and ZIP formats as the editor toolbar.
3. Open the editor with the selected photos automatically placed into a layout.
4. Adjust the layout, crop frames, photo order, frames, edge shape, spacing,
   and background.
5. Run print preflight, review or explicitly ignore warnings, and download a
   JPEG.
6. Optionally save the editable project as metadata only or as a portable
   bundle containing the photos.

The source panel exposes the gallery tree and one current folder at a time.
Photos already collected from other folders remain available in the editing
session, so a collage can still combine any number of folders. Reusing the
same source photo in several cells is allowed.

## Editor layout

- **Left:** two initially expanded accordions. **Gallery** contains the folder
  tree and photos from the current folder; **In collage** occupies roughly a
  quarter of the panel and retains each unique photo used during the session,
  even after its final placement is removed. Only sources referenced by active
  placements are persisted when the project is saved.
- **Top:** a collapsed accordion of lightweight static previews suitable for
  the current photo count. Changing the count changes the offered layouts.
- **Centre:** the collage canvas, contextual actions for the active cell, a
  focus control, and an opt-in zoom/pan inspection control.
- **Right:** photo count, frame style and colour, edge shape, background,
  spacing, edge depth, edge-element frequency, and automatic refill.
- **Narrow screens:** bottom navigation switches between photos, canvas, and
  settings; desktop keeps the three working areas visible together.

Clicking a photo in **In collage** that is already placed selects its cell
(repeated clicks cycle through every cell that uses it) and keeps the photo
armed: a following click on an empty cell adds it again, while a click on a
filled cell only selects that cell. This allows reusing photos from folders
that are no longer open in the gallery tree.

Selecting a filled cell shows **Crop**, **Move**, and **Remove**. Move is a
two-step interaction: choose **Move**, then choose the target cell. To fill an
empty cell, select a source photo and then the target cell. This avoids hidden
drag-and-drop behaviour and remains usable with mouse, touch, and keyboard.

The focus control hides the source, settings, template, and mobile-navigation
panels so the canvas can use the full editor workspace. Inspection mode is
separate from editing: while it is active, wheel or trackpad input changes the
preview scale, dragging pans the result, and double-click resets the view.
These transforms are CSS-only and never alter crop geometry, PPI, saved
projects, or exported JPEGs.

Gallery thumbnails expose a large-photo preview. It always opens with the
complete photo fitted inside the viewport. Its separate inspection toggle
enables smooth 100–300% zoom, drag-to-pan, and double-click reset; there is no
automatic 1:1 jump for large camera originals.

## Layout library

Layouts are grouped by photo count from 2 through 12. The library includes:

- even rows, columns, and grids;
- asymmetric layouts with one large photo and smaller surrounding photos;
- mirrored variants where composition meaningfully changes;
- two-column families with different numbers and orientations of photos in
  each column;
- central-feature or “sun” compositions where suitable.

Layouts fill the available collage area without accidental dead space. Static
previews use the editor's light theme and strong white separators; they do not
render live photos, avoiding unnecessary browser work.

## Frames, edges, and colour

Photo frame modes are **none**, **white**, and **colour**. Colour uses a picker
plus a suggested palette derived to complement the selected collage
background.

The accepted edge-shape set is represented by visual thumbnails rather than
visible text labels, with accessible names and tooltips for identification. It
includes straight, rounded, zigzag, wave, lightning, deckled, stamp,
perforated, old-photo, and Polaroid-style treatments. Decorative shapes always
form a complete contour around the photo.

- **Edge depth** controls how wide the decorative contour is.
- **Element frequency** controls how sparse or dense repeating decorative
  elements are.
- Frequency is not shown for shapes where it has no useful meaning, such as
  straight, rounded, old-photo, and Polaroid edges.

The collage background provides 11 presets plus a colour picker. Frame colour
suggestions are recalculated from the background rather than presented as an
unrelated fixed list.

## Crop model

The source photo never moves. The user edits the crop frame over the photo:

- **Keep proportions:** resizing preserves the target cell ratio.
- **Free proportions:** width and height can change independently and the UI
  reports the resulting distortion.

The crop frame has visible handles. Arrow keys move it; plus and minus change
its scale. Actions are **Reset**, **Centre**, **Cancel**, and **Done**. The
footer reports effective PPI and distortion. After confirmation, rendering
resamples the chosen crop to the target cell dimensions.

## Project format

The project document contains:

- application and document-format versions;
- source paths and display names;
- selected layout and placement order;
- crop geometry;
- frame, edge, spacing, and background settings;
- print format, orientation, PPI, and bleed choice.

Two save modes are available:

- **Layout only:** compact JSON referencing gallery paths.
- **Layout and photos:** ZIP containing the project JSON and source photos.

The UI estimates the output size next to each option. ZIP loading validates a
strict one-to-one mapping between unique project sources and embedded photo
files. Multiple placements may reference the same source, but missing, extra,
shared, duplicate, or unknown mappings are rejected.

The saved `appVersion` identifies which LiteGallery release produced the file
and is retained for diagnostics. Compatibility is determined only by the
document `formatVersion`. Migration UI should be introduced only when a real
incompatible format change exists.

Projects are explicitly saved and loaded; there is no browser autosave.

## History and recovery

Undo/redo keeps the latest 20 meaningful editing actions. The initial state is
shown as `0 of 20`. Leaving with unsaved changes presents **Stay**, **Exit
without saving**, and **Save and exit**, including the same project-format and
size choices as the main save control.

## Print export

Export is JPEG only. Supported physical sizes are:

| Format | Exact size |
| --- | --- |
| 10 × 15 | 100 × 150 mm |
| 13 × 18 | 130 × 180 mm |
| 15 × 20 | 150 × 200 mm |
| 20 × 30 | 200 × 300 mm |
| 30 × 45 | 300 × 450 mm |
| A4 | 210 × 297 mm |

The default is 300 PPI. Pixel dimensions are calculated from the physical
size, orientation, and optional 2 mm bleed on every side. A4 trim geometry
retains the exact `210/297` physical aspect after pixel rounding. JPEG metadata
contains the selected PPI.

Before download, the summary shows physical dimensions, pixel dimensions,
PPI, estimated file size, weakest-photo quality, and bleed state. Preflight
lists low-resolution or otherwise risky cells individually; each warning can
be shown in context or explicitly ignored.

Downloads use the ordinary browser download flow so HTTP-only LAN deployments
work without `showSaveFilePicker` or HTTPS.

## Technical structure

The implementation remains build-step-free JavaScript embedded into the Go
binary. Responsibilities are separated under `web/collage/`:

- model, store, and bounded history;
- formats, templates, geometry, palettes, and sources;
- crop controller, frames, render plan, and canvas renderer;
- preflight, JPEG metadata, downloads, export worker, and project packaging;
- editor integration and responsive styling.

Initial selection uses a loading barrier: every selected full-resolution
original must decode before the project is hydrated and autofilled. Originals
are checked sequentially to bound peak browser memory use. A failed source is
named and can be retried or removed when at least two valid photos remain.

The Go backend adds only read-only image-dimension metadata required for
quality calculations. Original media are never written. Self-contained ZIP
projects use browser `blob:` URLs after validation; the Content Security Policy
allows `blob:` only for image display and same-page fetches required by this
flow.

## Template catalogue review

The chooser shows one representative for layouts related by horizontal,
vertical, or combined reflection. The editor exposes reflection controls, so a
mirrored copy does not need a separate chooser tile. Catalogue cleanup is being
done count by count and the exact visible lists are protected by tests.

The approved 2–8 photo review removed these template definitions:

- 2 photos: `2-portrait-left`;
- 4 photos: `4-staggered-3`, `4-staggered-4`, `4-staggered-5`,
  `4-staggered-7`, `4-staggered-8`, `4-staggered-9`, and
  `4-staggered-10`;
- 5 photos: `5-staggered-5` and `5-staggered-6`;
- 6 photos: `6-columns-2-4-equal`, `6-columns-4-2-equal`, and
  `6-staggered-6`;
- 8 photos: `8-columns-2-6-equal` and `8-staggered-4`.

The resulting canonical catalogue contains 4, 6, 12, 15, 15, 18, and 16
templates for photo counts 2 through 8 respectively. Reflection-equivalent
definitions are removed from the public catalogue for every supported photo
count. Their old IDs remain loadable through a private compatibility registry
that preserves the original cell order, so existing projects open without
moving photographs between cells.

Future visual catalogue reviews must number every preview and add a compact
structural description. For column layouts it states the number of columns,
photo count per column, column-width percentages, and row-height percentages
inside every column. Row-first layouts use the equivalent row count, height
split, and cell-width percentages. Pinwheel and magazine layouts that do not
form a strict grid are labelled as composite instead of being described as a
fake column structure.

## Verification contract

Release checks include:

```sh
git diff --check
npm ci
npm run typecheck
npm run test:js
npm run test:e2e:full
go test ./...
go test -race ./...
go vet ./...
make build-freebsd
make build-linux
```

Browser smoke testing covers selection, multiple source folders, templates,
history, crop modes, empty-cell refill, project save/load, ZIP image decoding,
preflight, bleed calculations, A4 dimensions, JPEG download, focus mode,
collage zoom/pan, fitted source-photo previews, and source-photo zoom/pan.
Browser tests must verify visible decoded images rather than treating a
successful ZIP parse as sufficient. Unit and integration coverage locks
preview/export divider colour parity and EXIF display dimensions for
orientations 1–8, including mirrored camera images. Browser tests
(`tests/e2e/orientation-tiff.spec.mjs`) check in every desktop engine that the
decoder used for preview and export orients EXIF 1, 5, and 6 pixels exactly as
the server thumbnails do.

## Current boundaries and follow-ups

- The primary editing experience targets desktop and tablet-sized browsers;
  the layout remains usable at narrower widths but print composition benefits
  from a larger screen.
- No authentication or TLS is added by the collage feature. A deployment must
  remain on a trusted LAN or behind an authenticated reverse proxy.
- No cloud storage, sharing, server-side project database, PDF export, PNG
  export, or automatic ordering service is included.
- Future document migrations require an explicit versioned migration design
  and UI; compatibility must not be guessed silently.
- TIFF remains visible in the gallery but is not selectable for collages.
- JSON and ZIP projects that reference TIFF sources are rejected on import
  with the names of the affected photos.
- The 12-photo selection ceiling is intentionally silent: clicking a 13th
  photo leaves the current selection unchanged without replacing the hint.
- Collage format support is defined once in `web/collage/support.js` and used
  by both the gallery selection and the editor.
- Memory limits live in `web/collage/limits.js`. The PPI chooser and the export
  share one budget and per-pixel estimate, so the chooser never offers a PPI
  that the export would reject. The selection bar warns about photos above
  `LARGE_PHOTO_MEGAPIXELS` using `/api/image-info`, and the export dialog warns
  when a format exceeds `MAX_SAFE_CANVAS_PIXELS`. Warnings never block the
  workflow; the thresholds are tuned by testing on real devices.
