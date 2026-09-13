# Changelog

## Unreleased

### Added

- On-demand EXIF viewing for photos, including capture time, camera, lens,
  exposure settings, dimensions, and GPS coordinates when available.
- Responsive metadata panel for desktop, phone, and fullscreen viewing.
- Photo/video filtering and name/capture-date sorting in both directions.
- Per-directory metadata manifests generated exclusively by cache warming.
- Pure-Go MP4/MOV/M4V/3GP container creation-time parsing for video sorting.

### Changed

- Cache warmer errors now include the failing operation, source path, and
  underlying error in the log.
- Date sorting uses cached EXIF capture time for photos and filesystem creation
  time as a fallback.
- EXIF wall-clock timestamps are interpreted in the NAS local timezone so photo
  and video sorting uses comparable Unix timestamps.
