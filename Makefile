APP := litegallery
BUILD := build

.PHONY: test build build-freebsd clean

test:
	go test ./...

build:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP) .

build-freebsd:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=freebsd GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP)-freebsd-amd64 .

clean:
	rm -rf $(BUILD)
