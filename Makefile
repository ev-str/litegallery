APP := litegallery
BUILD := build

.PHONY: test build build-freebsd build-linux build-linux-amd64 build-linux-arm64 clean

test:
	go test ./...

build:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP) .

build-freebsd:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=freebsd GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP)-freebsd-amd64 .

build-linux: build-linux-amd64 build-linux-arm64

build-linux-amd64:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP)-linux-amd64 .

build-linux-arm64:
	mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o $(BUILD)/$(APP)-linux-arm64 .

clean:
	rm -rf $(BUILD)
