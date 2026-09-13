# Changelog

## Unreleased

### Added

- Linux NAS build targets for amd64 and arm64 architectures.
- On-demand EXIF viewing for photos, including capture time, camera, lens,
  exposure settings, dimensions, and GPS coordinates when available.
- Responsive metadata panel for desktop, phone, and fullscreen viewing.
- Photo/video filtering and name/capture-date sorting in both directions.
- Per-directory metadata manifests generated exclusively by cache warming.
- Pure-Go MP4/MOV/M4V/3GP container creation-time parsing for video sorting.

### Changed

- Renamed the project, Go module, binaries, and deployment script from
  PhotoView to LiteGallery.
- Thumbnail generation now rejects source images over 100 megapixels before
  full decoding; the limit is configurable with `-max-image-pixels`.
- Cache warmer errors now include the failing operation, source path, and
  underlying error in the log.
- Date sorting uses cached EXIF capture time for photos and filesystem creation
  time as a fallback.
- EXIF wall-clock timestamps are interpreted in the NAS local timezone so photo
  and video sorting uses comparable Unix timestamps.

### Planned

- Refresh the visual hierarchy with an album title, media statistics, and a
  unified filter and sorting toolbar.
- Replace text symbols with consistent embedded SVG icons.
- Refine folder covers and media cards with improved typography, depth, loading
  placeholders, and restrained motion.
- Introduce a dark cinematic viewer with auto-hiding controls.
- Present EXIF metadata as a side panel on larger screens and a bottom sheet on
  phones.
- Improve mobile controls and TV-focused keyboard navigation without adding a
  frontend build step or external runtime dependencies.
