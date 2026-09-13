//go:build darwin || freebsd

package internal

import (
	"os"
	"syscall"
)

func fileCreatedUnix(info os.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && stat.Birthtimespec.Sec > 0 {
		return stat.Birthtimespec.Sec
	}
	return info.ModTime().Unix()
}
