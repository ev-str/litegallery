package internal

import "sync"

// keyedMutex serialises work per key. An entry lives only while a goroutine
// holds or waits for its lock, so the map stays bounded by in-flight requests
// instead of growing with every key ever seen.
type keyedMutex struct {
	mu    sync.Mutex
	locks map[string]*keyedLock
}

type keyedLock struct {
	sync.Mutex
	refs int
}

// Lock blocks until the key is free and returns the matching unlock function.
func (k *keyedMutex) Lock(key string) (unlock func()) {
	k.mu.Lock()
	if k.locks == nil {
		k.locks = make(map[string]*keyedLock)
	}
	entry := k.locks[key]
	if entry == nil {
		entry = &keyedLock{}
		k.locks[key] = entry
	}
	entry.refs++
	k.mu.Unlock()

	entry.Lock()
	return func() {
		entry.Unlock()
		k.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(k.locks, key)
		}
		k.mu.Unlock()
	}
}

// Len reports how many keys are currently held or awaited.
func (k *keyedMutex) Len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.locks)
}
