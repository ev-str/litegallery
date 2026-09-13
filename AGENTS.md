# AGENTS.md

## Project

LiteGallery is a lightweight photo and video gallery distributed as one
statically linked Go binary. It is read-only with respect to the original media
library; generated files belong only in the configured cache directory.

## Engineering rules

- Never modify, rename, upload, or delete original media.
- Reject paths and symlinks that escape the configured library root.
- Keep the web UI embedded; do not add a Node.js build step.
- Prefer pure Go dependencies. Do not require CGO, FFmpeg, a database, or
  additional NAS packages.
- The HTTP service may read metadata manifests and write only validated cache
  artifacts such as browser-generated video posters.
- Only the cache warmer may write per-directory metadata manifests.
- Write cache and metadata files atomically.
- Preserve fallback behaviour when EXIF or video metadata is unavailable.
- Never commit real family photos, private IP addresses, credentials, email
  addresses, or machine-specific paths.

## Verification

Run before handing off changes:

```sh
go test ./...
go vet ./...
make build-freebsd
```

## Documentation

Update `README.md` for user-visible behaviour and `CHANGELOG.md` for notable
changes.
