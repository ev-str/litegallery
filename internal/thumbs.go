package internal

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
)

var (
	thumbLocks   keyedMutex
	thumbWorkers = make(chan struct{}, 2)
)

const DefaultMaxImagePixels int64 = 100_000_000

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil || mediaKind(abs) != "image" {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "image not found", http.StatusNotFound)
		return
	}
	cached, key := s.thumbnailCachePath(abs, info)

	switch err := s.ensureThumbnail(r.Context(), abs, cached, key); {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return
	case errors.Is(err, errThumbnailCache):
		http.Error(w, "cannot read thumbnail cache", http.StatusInternalServerError)
		return
	case err != nil:
		http.Error(w, "cannot create thumbnail", http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, cached)
}

var errThumbnailCache = errors.New("cannot read thumbnail cache")

// ensureThumbnail generates the cached thumbnail once per key. Only generation
// holds the per-key lock; serving the finished file does not.
func (s *Server) ensureThumbnail(ctx context.Context, source, cached, key string) error {
	unlock := thumbLocks.Lock(key)
	defer unlock()

	if _, err := os.Stat(cached); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %v", errThumbnailCache, err)
	}
	select {
	case thumbWorkers <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-thumbWorkers }()
	return makeThumbnail(source, cached, s.cfg.ThumbSize, s.cfg.MaxImagePixels)
}

func (s *Server) handleVideoPoster(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_, abs, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil || mediaKind(abs) != "video" {
		http.Error(w, "video not found", http.StatusNotFound)
		return
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "video not found", http.StatusNotFound)
		return
	}
	cached, _ := s.thumbnailCachePath(abs, info)

	if r.Method == http.MethodPut {
		if r.Header.Get("Content-Type") != "image/jpeg" {
			http.Error(w, "JPEG required", http.StatusUnsupportedMediaType)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
		if err != nil {
			http.Error(w, "poster too large", http.StatusRequestEntityTooLarge)
			return
		}
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || format != "jpeg" || config.Width < 1 || config.Height < 1 || config.Width > s.cfg.ThumbSize || config.Height > s.cfg.ThumbSize {
			http.Error(w, "invalid poster", http.StatusUnsupportedMediaType)
			return
		}
		if err := writeCachedJPEG(cached, data); err != nil {
			http.Error(w, "cannot cache poster", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if _, err := os.Stat(cached); err != nil {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "poster not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, cached)
}

func (s *Server) thumbnailCachePath(abs string, info os.FileInfo) (string, string) {
	keyBytes := sha256.Sum256([]byte(abs + "\x00" + strconv.FormatInt(info.Size(), 10) + "\x00" + strconv.FormatInt(info.ModTime().UnixNano(), 10) + "\x00" + strconv.Itoa(s.cfg.ThumbSize)))
	key := hex.EncodeToString(keyBytes[:])
	return filepath.Join(s.cfg.Cache, key[:2], key+".jpg"), key
}

func writeCachedJPEG(destination string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".thumb-*.jpg")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}

func makeThumbnail(source, destination string, maxSide int, maxPixels int64) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	orientation := jpegOrientation(file)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return err
	}
	config, _, err := image.DecodeConfig(file)
	if err != nil {
		file.Close()
		return err
	}
	if err := validateImageDimensions(config.Width, config.Height, maxPixels); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		file.Close()
		return err
	}
	src, _, err := image.Decode(file)
	file.Close()
	if err != nil {
		return err
	}
	src = orient(src, orientation)
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if err := validateImageDimensions(w, h, maxPixels); err != nil {
		return err
	}
	newW, newH := w, h
	if w > maxSide || h > maxSide {
		if w >= h {
			newW, newH = maxSide, max(1, h*maxSide/w)
		} else {
			newH, newW = maxSide, max(1, w*maxSide/h)
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, newW, newH))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".thumb-*.jpg")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := jpeg.Encode(tmp, dst, &jpeg.Options{Quality: 82}); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}

func validateImageDimensions(width, height int, maxPixels int64) error {
	if width <= 0 || height <= 0 {
		return errors.New("empty image")
	}
	if maxPixels < 1 {
		return errors.New("maximum image pixel count must be positive")
	}
	if int64(width) > maxPixels/int64(height) {
		return fmt.Errorf("image dimensions %dx%d exceed limit of %d pixels", width, height, maxPixels)
	}
	return nil
}

func jpegOrientation(r io.Reader) int {
	data, err := io.ReadAll(io.LimitReader(r, 256*1024))
	if err != nil || len(data) < 4 || data[0] != 0xff || data[1] != 0xd8 {
		return 1
	}
	for i := 2; i+4 < len(data); {
		if data[i] != 0xff {
			break
		}
		marker := data[i+1]
		if marker == 0xda || marker == 0xd9 {
			break
		}
		length := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if length < 2 || i+2+length > len(data) {
			break
		}
		segment := data[i+4 : i+2+length]
		if marker == 0xe1 && len(segment) > 14 && string(segment[:6]) == "Exif\x00\x00" {
			if value := tiffOrientation(segment[6:]); value >= 1 && value <= 8 {
				return value
			}
		}
		i += 2 + length
	}
	return 1
}

func tiffOrientation(data []byte) int {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	if string(data[:2]) == "II" {
		order = binary.LittleEndian
	} else if string(data[:2]) == "MM" {
		order = binary.BigEndian
	} else {
		return 1
	}
	ifd := int(order.Uint32(data[4:8]))
	if ifd < 0 || ifd+2 > len(data) {
		return 1
	}
	count := int(order.Uint16(data[ifd : ifd+2]))
	pos := ifd + 2
	for n := 0; n < count && pos+12 <= len(data); n, pos = n+1, pos+12 {
		if order.Uint16(data[pos:pos+2]) == 0x0112 {
			return int(order.Uint16(data[pos+8 : pos+10]))
		}
	}
	return 1
}

func orient(src image.Image, orientation int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	outW, outH := w, h
	if orientation >= 5 && orientation <= 8 {
		outW, outH = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, outW, outH))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch orientation {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			default:
				dx, dy = x, y
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}
