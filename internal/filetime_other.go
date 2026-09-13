//go:build !darwin && !freebsd

package internal

import "os"

func fileCreatedUnix(info os.FileInfo) int64 {
	return info.ModTime().Unix()
}
