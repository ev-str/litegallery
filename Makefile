APP := litegallery
BUILD := build
DIST := dist
RELEASE_BINARIES := $(APP)-freebsd-amd64 $(APP)-linux-amd64 $(APP)-linux-arm64
SHA256 := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo shasum -a 256)
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: test build build-freebsd build-linux build-linux-amd64 build-linux-arm64 release clean

test:
	go test ./...

build:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o $(BUILD)/$(APP) .

build-freebsd:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=freebsd GOARCH=amd64 go build -trimpath -ldflags="$(LDFLAGS)" -o $(BUILD)/$(APP)-freebsd-amd64 .

build-linux: build-linux-amd64 build-linux-arm64

build-linux-amd64:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="$(LDFLAGS)" -o $(BUILD)/$(APP)-linux-amd64 .

build-linux-arm64:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="$(LDFLAGS)" -o $(BUILD)/$(APP)-linux-arm64 .

# Release assets for a tagged, clean checkout: binaries plus SHA256SUMS with
# bare file names, ready for `gh release create <tag> dist/*`.
release:
	@case "$(VERSION)" in \
	  v[0-9]*.[0-9]*.[0-9]*-*|*-dirty|dev|"") echo "release: VERSION=$(VERSION) is not a clean release tag; tag HEAD and commit all changes first" >&2; exit 1 ;; \
	  v[0-9]*.[0-9]*.[0-9]*) ;; \
	  *) echo "release: VERSION=$(VERSION) is not a clean release tag" >&2; exit 1 ;; \
	esac
	$(MAKE) build-freebsd build-linux VERSION=$(VERSION)
	rm -rf $(DIST)
	mkdir -p $(DIST)
	cp $(addprefix $(BUILD)/,$(RELEASE_BINARIES)) $(DIST)/
	cd $(DIST) && $(SHA256) $(RELEASE_BINARIES) > SHA256SUMS
	@echo "release: $(VERSION) assets in $(DIST)/"

clean:
	rm -rf $(BUILD) $(DIST)
