package internal

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestKeyedMutexSerialisesOneKeyAndForgetsIt(t *testing.T) {
	var locks keyedMutex
	var active, maxActive atomic.Int32
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock := locks.Lock("same")
			defer unlock()
			current := active.Add(1)
			for {
				seen := maxActive.Load()
				if current <= seen || maxActive.CompareAndSwap(seen, current) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			active.Add(-1)
		}()
	}
	wg.Wait()
	if got := maxActive.Load(); got != 1 {
		t.Fatalf("concurrent holders of one key = %d, want 1", got)
	}
	if got := locks.Len(); got != 0 {
		t.Fatalf("entries after release = %d, want 0", got)
	}
}

func TestKeyedMutexDoesNotBlockOtherKeys(t *testing.T) {
	var locks keyedMutex
	unlockA := locks.Lock("a")
	defer unlockA()
	acquired := make(chan struct{})
	go func() {
		unlockB := locks.Lock("b")
		unlockB()
		close(acquired)
	}()
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("lock on key b waited for key a")
	}
	if got := locks.Len(); got != 1 {
		t.Fatalf("entries while a is held = %d, want 1", got)
	}
}

func TestThumbnailRequestsLeaveNoLockEntries(t *testing.T) {
	s, root := testServer(t)
	for index := range 3 {
		writeTestJPEG(t, filepath.Join(root, fmt.Sprintf("leak-%d.jpg", index)))
	}
	handler := s.Handler()
	var wg sync.WaitGroup
	for request := range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			target := "/api/thumb?path=" + url.QueryEscape(fmt.Sprintf("leak-%d.jpg", request%3))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusOK {
				t.Errorf("%s: status %d", target, response.Code)
			}
		}()
	}
	wg.Wait()
	if got := thumbLocks.Len(); got != 0 {
		t.Fatalf("thumbnail lock entries after requests = %d, want 0", got)
	}
}
