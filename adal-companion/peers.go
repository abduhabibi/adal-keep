// peers.go — the Companions of an office help each other (asked on 2026-11-20:
// "make the companion download its copy whenever it gets it, and updating both
// files and updates each other should work too").
//
//   - The main PC's number (the copy is kept only for the main PC that says it
//     is its own): a Companion that joined through its window (the online
//     account) never had it typed. It is read from the main PC's own heartbeat
//     in the agency's online copy (keep_meta /_pc → pc) and kept.
//   - The copy: its pieces are locked with the agency's backup key, so they may
//     come from any Companion of the same agency (it checks the main PC's
//     number). A missing piece is taken from another Companion that has it
//     before asking the main PC; with the main PC off, a Companion whose copy is
//     older (or missing) takes the newest copy of the office, piece by piece.
//     The backup key itself only ever comes from the main PC.
//   - The server in waiting (standby.go): with the main PC away, a Companion
//     without it takes it from another Companion (GET /standby/bundle).
//   - Updates: already shared between every PC of the office (selfupdate.go,
//     /lan/latest and the release offer on the network).
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var peerClient = &http.Client{Timeout: 3 * time.Minute}

func exeRoot() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return "."
}

// learnNumberOnline: the main PC's number from its heartbeat online, kept.
func learnNumberOnline(root string) string {
	if n := mainNumber(); n != "" {
		return n
	}
	c := readCloud(root)
	if c == nil {
		return ""
	}
	h := &http.Client{Timeout: 10 * time.Second}
	tok, err := c.token(h)
	if err != nil {
		return ""
	}
	req, _ := http.NewRequest(http.MethodGet, c.URL+"/rest/v1/keep_meta?key=eq./_pc&select=data", nil)
	req.Header.Set("apikey", c.Anon)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := h.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var rows []struct {
		Data struct {
			PC any `json:"pc"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&rows) != nil || len(rows) == 0 {
		return ""
	}
	n := cleanPCNumber(fmt.Sprint(rows[0].Data.PC))
	if n == "" {
		return ""
	}
	id := loadIdentity()
	id.Number = n
	saveIdentity(id)
	log.Printf("🔢 The main PC's number was learned from the agency's online copy: its copy can be kept here now")
	return n
}

// ── Other Companions of the office ──────────────────────────────────────────

type peerCopy struct {
	base     string
	made     string
	syncedAt string
}

// peerBases: the other Companions heard on the network lately (standby.go).
func peerBases() []string {
	if standby == nil {
		return nil
	}
	standby.mu.Lock()
	defer standby.mu.Unlock()
	var out []string
	for _, p := range standby.peers {
		if p.addr != "" && time.Since(p.at) < 2*time.Minute {
			out = append(out, fmt.Sprintf("http://%s:%d", p.addr, lanHTTPPort))
		}
	}
	return out
}

func peerGet(u string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-adal-number", mainNumber())
	return peerClient.Do(req)
}

// peerCopies: what copy each Companion has (newest first).
func peerCopies() []peerCopy {
	var out []peerCopy
	for _, b := range peerBases() {
		resp, err := peerGet(b + "/replica/info")
		if err != nil {
			continue
		}
		var info struct {
			Made     string `json:"made"`
			SyncedAt string `json:"synced_at"`
		}
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 8192)).Decode(&info) == nil
		resp.Body.Close()
		if ok && info.Made != "" {
			out = append(out, peerCopy{base: b, made: info.Made, syncedAt: info.SyncedAt})
		}
	}
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].made > out[i].made {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// pieceFromPeers: one locked piece from a Companion that has it; false when none has.
func pieceFromPeers(name string, bases []string) bool {
	for _, b := range bases {
		resp, err := peerGet(b + "/replica/piece/" + name)
		if err != nil {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			continue
		}
		err = savePiece(resp.Body, name)
		resp.Body.Close()
		if err == nil {
			return true
		}
	}
	return false
}

// savePiece: a piece as it came (still locked), written whole or not at all.
func savePiece(r io.Reader, name string) error {
	if err := os.MkdirAll(piecesDir(), 0o700); err != nil {
		return err
	}
	tmp := filepath.Join(piecesDir(), name+".part")
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, io.LimitReader(r, 64<<20)); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, filepath.Join(piecesDir(), name))
}

// copyState: what a Companion's copy is (for another Companion of the agency).
type copyState struct {
	PCNumber string  `json:"pc_number"`
	Made     string  `json:"made"`
	DB       rpDB    `json:"db"`
	Docs     []rpDoc `json:"docs"`
	LastGood string  `json:"last_good,omitempty"`
}

// syncFromPeers: the main PC away — the newest copy of the office, when it is
// newer than the one here, piece by piece (only the pieces missing here).
func syncFromPeers() error {
	if mainNumber() == "" {
		return errNoNumber
	}
	if !replicaMu.TryLock() {
		return nil
	}
	defer replicaMu.Unlock()
	st := loadState()
	for _, pc := range peerCopies() {
		if pc.made <= st.Made {
			return nil // nobody has a newer one
		}
		resp, err := peerGet(pc.base + "/replica/state")
		if err != nil {
			continue
		}
		var cs copyState
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&cs) == nil
		resp.Body.Close()
		if !ok || cs.Made == "" || (st.PCNumber != "" && cs.PCNumber != "" && cs.PCNumber != st.PCNumber) {
			continue
		}
		var got int
		missing := false
		for i, sum := range cs.DB.Chunks {
			name := dbPieceName(i, sum)
			if pieceExists(name) {
				continue
			}
			if !pieceFromPeers(name, []string{pc.base}) {
				missing = true
				break
			}
			got++
		}
		var docs []rpDoc
		for _, d := range cs.Docs {
			whole := true
			for k := 0; k < d.Parts; k++ {
				name := docPieceName(d, k)
				if pieceExists(name) {
					continue
				}
				if !pieceFromPeers(name, []string{pc.base}) {
					whole = false
					break
				}
				got++
			}
			if whole {
				docs = append(docs, d)
			}
		}
		if missing {
			continue // its database is not whole: another one
		}
		st.PCNumber, st.Made, st.DB, st.Docs = cs.PCNumber, cs.Made, cs.DB, docs
		if st.PCNumber == "" {
			st.PCNumber = mainNumber()
		}
		if cs.LastGood > st.MainLastGood {
			st.MainLastGood = cs.LastGood
		}
		st.SyncedAt = time.Now().UTC().Format(time.RFC3339)
		pruneReplica(st)
		if err := saveState(st); err != nil {
			return err
		}
		log.Printf("🗄 Copy brought up to date from another Companion (%s): %d new piece(s), %d documents", pc.base, got, len(docs))
		return nil
	}
	return nil
}

// addPeerRoutes: what another Companion of the agency may take from here.
func addPeerRoutes(mux *http.ServeMux, root string) {
	mux.HandleFunc("/replica/state", func(w http.ResponseWriter, r *http.Request) {
		st := loadState()
		if !numberOK(r, st) {
			http.Error(w, "not this main PC's number", http.StatusForbidden)
			return
		}
		if st.Made == "" {
			http.Error(w, "no copy here yet", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(copyState{PCNumber: st.PCNumber, Made: st.Made, DB: st.DB, Docs: st.Docs, LastGood: st.MainLastGood})
	})
	// The server in waiting (never its data folder), for a Companion that has none.
	mux.HandleFunc("/standby/bundle", func(w http.ResponseWriter, r *http.Request) {
		if !numberOK(r, loadState()) {
			http.Error(w, "not this main PC's number", http.StatusForbidden)
			return
		}
		if !hasServer(root) || standbyActing() {
			http.Error(w, "no server to give now", http.StatusNotFound)
			return
		}
		ver := ""
		if standby != nil {
			standby.mu.Lock()
			ver = standby.st.BundleVersion
			standby.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("X-Adal-Version", ver)
		cmd := exec.Command(windowsTar(), "-czf", "-", "-C", serverDir(root), "--exclude", "backend/data", "--exclude", "backend/*.sqlite*", "--exclude", "*.log", ".")
		hideWindow(cmd)
		cmd.Stdout = w
		if err := cmd.Run(); err != nil {
			log.Printf("🏢 server for another Companion: %v", err)
		}
	})
}

// bundleFromPeers: the main PC away and no server here — another Companion's.
func (s *standbyRunner) bundleFromPeers() error {
	for _, b := range peerBases() {
		resp, err := peerGet(b + "/standby/bundle")
		if err != nil {
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			continue
		}
		err = s.installBundle(resp.Body, resp.Header.Get("X-Adal-Version"))
		resp.Body.Close()
		if err == nil {
			log.Printf("🏢 The server in waiting came from another Companion (%s)", b)
			return nil
		}
		log.Printf("🏢 server from %s: %v", b, err)
	}
	return nil
}

// peerIP: the address a UDP message came from, as text.
func peerIP(a *net.UDPAddr) string {
	if a == nil || a.IP == nil {
		return ""
	}
	return strings.TrimSpace(a.IP.String())
}
