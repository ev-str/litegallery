# AGENTS.md

## Project

LiteGallery is a lightweight photo and video gallery distributed as one
statically linked Go binary. It is read-only with respect to the original media
library; generated files belong only in the configured cache directory.

## Engineering rules

- Never modify, rename, upload, or delete original media.
- Reject paths and symlinks that escape the configured library root.
- Keep the web UI embedded; do not add a Node.js build step.
- Node.js dependencies are development-only and may be used for JavaScript
  tests, browser tests, and type checking. The shipped web UI has no Node.js
  build or runtime step.
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

Before every commit run `npm run typecheck`, `npm run test:js`,
`npm run test:e2e:essential`, `go test ./...`, and `go vet ./...`.

Release checks (run before tagging a release):

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

Publish releases from a clean tagged checkout with `make release`; it fails for
untagged or dirty trees. Upload `dist/*` (binaries and `SHA256SUMS`).

Browser-test rules:

- Run a changed spec right after editing it, with `--max-failures=1`.
- Never run two Playwright runs at once: both use port 18090.
- Derive expectations from the shared modules (`web/collage/formats.js`,
  `web/collage/templates.js`) instead of hard-coding counts or aspect ratios.

## Documentation

Update `README.md` for user-visible behaviour and `CHANGELOG.md` for notable
changes.
