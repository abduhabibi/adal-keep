// replicadelta.go — the locked copy (replica.go) takes what changed, not whole pieces (2026-11-25: a
// main PC on a Wi-Fi stick gave each Companion 0.9–2.8 MB about every minute, and its list of 2,466
// documents each time). Main's half: backend services/replicaDelta.js.
//
//   - A database piece is a row of 16 KB zstd frames with their lengths at the end (a skippable frame:
//     any zstd reader still reads the whole piece, so a restore, Telegram and the other Companions see
//     nothing new). Main sends only the changed frames; the piece is put together here without
//     unpacking any, checked by SHA-256, and locked again.
//   - The lists: only what changed since the ones here. Nothing changed: one line.
//   - Another Companion first for a whole piece or a document: the first of the office (by name) asks
//     Main, the others 20 s later ask it. Found by Main's own list of the office's PCs, so also with
//     this PC's server off (ADAL_STANDBY=0: until 2026-11-25 no Companion was asked then at all).
//
// Off: ADAL_REPLICA_DELTA=0.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func replicaDeltaOn() bool { return os.Getenv("ADAL_REPLICA_DELTA") != "0" }

// rpManifest2: what v2 adds to rpManifest.
type rpManifest2 struct {
	rpManifest
	SameDB   bool     `json:"same_db"`
	SameDocs bool     `json:"same_docs"`
	DocsAt   string   `json:"docs_at"`
	DocsSet  []rpDoc  `json:"docs_set"`
	DocsGone []string `json:"docs_gone"`
	DB2      struct {
		Length int64             `json:"length"`
		Chunk  int64             `json:"chunk"`
		Z      string            `json:"z"`
		N      int               `json:"n"`
		Set    map[string]string `json:"set"`
		From   string            `json:"from"`
		Chunks []string          `json:"chunks"`
	} `json:"db"`
}

// askManifest: the manifest, whole (filled from what is here when Main sent only the changes).
// changed: false when nothing at all changed.
func askManifest(st replicaState, key string) (m rpManifest, docsAt string, changed bool, code int, err error) {
	q := "/api/replica/manifest"
	if replicaDeltaOn() {
		q += "?v=2&have=" + url.QueryEscape(st.Snap) + "&docs=" + url.QueryEscape(st.DocsAt)
	}
	var r rpManifest2
	code, err = mainJSON(http.MethodGet, q, nil, key, &r)
	if err != nil {
		return
	}
	m = r.rpManifest
	m.DB = rpDB{Length: r.DB2.Length, Chunk: r.DB2.Chunk, Z: r.DB2.Z, Chunks: r.DB2.Chunks}
	if m.V != 2 { // an older main PC: everything, as before
		return m, "", true, code, nil
	}
	changed = !r.SameDB || !r.SameDocs
	switch {
	case r.SameDB:
		m.DB = st.DB
	case r.DB2.From != "":
		if r.DB2.From != st.Snap {
			return m, "", true, code, errors.New("the main PC's answer is for another copy")
		}
		sums := make([]string, r.DB2.N)
		copy(sums, st.DB.Chunks)
		for k, v := range r.DB2.Set {
			i, e := strconv.Atoi(k)
			if e != nil || i < 0 || i >= len(sums) {
				return m, "", true, code, errors.New("a bad answer")
			}
			sums[i] = v
		}
		m.DB.Chunks = sums
	}
	switch {
	case r.SameDocs:
		m.Docs = st.Docs
	case r.Docs == nil:
		drop := map[string]bool{}
		for _, n := range r.DocsGone {
			drop[n] = true
		}
		for _, d := range r.DocsSet {
			drop[d.Name] = true
		}
		for _, d := range st.Docs {
			if !drop[d.Name] {
				m.Docs = append(m.Docs, d)
			}
		}
		m.Docs = append(m.Docs, r.DocsSet...)
	}
	for _, s := range m.DB.Chunks {
		if s == "" {
			return m, "", true, code, errors.New("a bad answer")
		}
	}
	return m, r.DocsAt, changed, code, nil
}

// ── one database piece ─────────────────────────────────────────────────────

var (
	frameMagic = []byte{0x50, 0x2A, 0x4D, 0x18}
	frameMark  = []byte("ADALFR1\x00")
)

// splitFrames: the frames of a piece (nil: a piece made before this).
func splitFrames(p []byte) [][]byte {
	i := bytes.LastIndex(p, frameMark)
	if i < 8 || !bytes.Equal(p[i-8:i-4], frameMagic) || int(binary.LittleEndian.Uint32(p[i-4:])) != len(p)-i {
		return nil
	}
	t := p[i+len(frameMark):]
	if len(t)%4 != 0 {
		return nil
	}
	var out [][]byte
	at := 0
	for k := 0; k < len(t); k += 4 {
		n := int(binary.LittleEndian.Uint32(t[k:]))
		if n < 0 || at+n > i-8 {
			return nil
		}
		out = append(out, p[at:at+n])
		at += n
	}
	if at != i-8 {
		return nil
	}
	return out
}

func joinFrames(frames [][]byte) []byte {
	var b bytes.Buffer
	for _, f := range frames {
		b.Write(f)
	}
	b.Write(frameMagic)
	var n [4]byte
	binary.LittleEndian.PutUint32(n[:], uint32(len(frameMark)+4*len(frames)))
	b.Write(n[:])
	b.Write(frameMark)
	for _, f := range frames {
		binary.LittleEndian.PutUint32(n[:], uint32(len(f)))
		b.Write(n[:])
	}
	return b.Bytes()
}

// applySub: the piece here with the changed frames in it.
func applySub(old [][]byte, sub []byte) ([]byte, error) {
	if len(sub) < 12 || string(sub[:8]) != "ADALSUB1" {
		return nil, errors.New("not the changes of a piece")
	}
	hl := int(binary.BigEndian.Uint32(sub[8:]))
	if hl < 0 || 12+hl > len(sub) {
		return nil, errDamagedPatch
	}
	var h struct {
		N      int      `json:"n"`
		SHA256 string   `json:"sha256"`
		Set    [][2]int `json:"set"`
	}
	if err := json.Unmarshal(sub[12:12+hl], &h); err != nil || h.N < 0 || h.N > 1<<16 {
		return nil, errDamagedPatch
	}
	frames := make([][]byte, h.N)
	copy(frames, old)
	rest := sub[12+hl:]
	for _, s := range h.Set {
		if s[0] < 0 || s[0] >= h.N || s[1] < 0 || s[1] > len(rest) {
			return nil, errDamagedPatch
		}
		frames[s[0]], rest = rest[:s[1]], rest[s[1]:]
	}
	out := joinFrames(frames)
	if x := sha256.Sum256(out); hex.EncodeToString(x[:]) != h.SHA256 {
		return nil, errors.New("the piece put together is not the main PC's")
	}
	return out, nil
}

// fetchDBPiece: chunk i as sum, from the changes to the one here (was) when Main knows them, else whole.
func fetchDBPiece(snap string, i int, sum, was string, keys replicaKeys) (int64, error) {
	name := dbPieceName(i, sum)
	path := fmt.Sprintf("/api/replica/db/%s/%d", url.PathEscape(snap), i)
	if !replicaDeltaOn() {
		return fetchPiece(path, keys.AccessKey, name)
	}
	path += "?v=2"
	var old [][]byte
	if was != "" && was != sum {
		if b, err := os.ReadFile(filepath.Join(piecesDir(), dbPieceName(i, was))); err == nil {
			if plain, err := unlockPiece(b, keys.Password); err == nil {
				old = splitFrames(plain)
			}
		}
	}
	if old == nil {
		return fetchPiece(path, keys.AccessKey, name)
	}
	resp, err := askAgain(path+"&base="+url.QueryEscape(was), keys.AccessKey)
	if err != nil {
		return 0, err
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	resp.Body.Close()
	if err != nil {
		return 0, err
	}
	plain, err := unlockPiece(b, keys.Password)
	if err != nil {
		return int64(len(b)), err
	}
	if !bytes.HasPrefix(plain, []byte("ADALSUB1")) { // Main sent it whole (it does not know the one here)
		return int64(len(b)), writeAtomic(filepath.Join(piecesDir(), name), b, 0o600)
	}
	out, err := applySub(old, plain)
	if err != nil {
		n, err := fetchPiece(path, keys.AccessKey, name)
		return n + int64(len(b)), err
	}
	locked, err := lockPiece(out, keys.Password)
	if err != nil {
		return int64(len(b)), err
	}
	return int64(len(b)), writeAtomic(filepath.Join(piecesDir(), name), locked, 0o600)
}

// askAgain: a GET from Main; busy copying (503) is asked again after what it says.
func askAgain(path, key string) (*http.Response, error) {
	for try := 0; ; try++ {
		resp, err := mainRequest(http.MethodGet, path, nil, key)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusOK {
			return resp, nil
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable || try >= 4 {
			return nil, fmt.Errorf("the main PC answered %d for %s", resp.StatusCode, path)
		}
		s, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		if s < 1 || s > 60 {
			s = 5
		}
		time.Sleep(time.Duration(s) * busyWait)
	}
}

var busyWait = time.Second

// ── the other Companions ───────────────────────────────────────────────────

// officeBases: the office's other Companions as Main named them (robot.go's announcement).
func officeBases() []string {
	officeMu.Lock()
	defer officeMu.Unlock()
	var out []string
	for _, p := range officePeers {
		if net.ParseIP(p.IP) != nil && p.Port > 0 && p.Port < 65536 {
			out = append(out, "http://"+net.JoinHostPort(p.IP, strconv.Itoa(p.Port)))
		}
	}
	return out
}

// copyPeers: every Companion that may have a piece (heard on the network, named by Main).
func copyPeers() []string {
	seen := map[string]bool{}
	var out []string
	for _, b := range append(append(peerBases(), officeBases()...), companionsHeard()...) {
		if !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	return out
}

// firstOfOffice: this PC's name comes first: it asks Main, the others ask it 20 s later.
func firstOfOffice() bool {
	officeMu.Lock()
	defer officeMu.Unlock()
	names := []string{strings.ToLower(clientName)}
	for _, p := range officePeers {
		names = append(names, strings.ToLower(p.Name))
	}
	sort.Strings(names)
	return names[0] == strings.ToLower(clientName)
}

var peerWait = 20 * time.Second

// letFirstGo: a whole piece or a document is missing here and another Companion asks Main first.
func letFirstGo(bases []string, missing int) {
	if missing > 0 && len(bases) > 0 && replicaDeltaOn() && !firstOfOffice() {
		time.Sleep(peerWait)
	}
}
