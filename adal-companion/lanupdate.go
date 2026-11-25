// lanupdate.go — this Companion takes the signed release its main PC runs, over the office network
// (the owner, 2026-11-25: "update the main first, and everyone will update themselves through the
// main"). Main is not trusted: the manifest must be signed by Adal (the key in selfupdate.go) and
// every file must have the SHA-256 the manifest says. Nothing unsigned is taken, from Main either.
//
//   - News: the answer to this PC's own announcement every 20 s names the release Main runs
//     (robot.go); a look every 5 minutes otherwise. The manifest is read only when it is another one.
//   - Programs and the Companion's own pages: as from Supabase (selfupdate.go install), from Main first.
//   - The server kept here (server\, full.go, standby.go): file by file. Only the files whose SHA-256
//     differs: one already here under another name, else a small patch from the file here, else the
//     file. Put in place together; a server that does not answer with it goes back to the files before.
//   - Only forward (isNewerRelease), not while a run works in the office (10 minutes at most), never
//     while this PC stands in for Main.
//
// Off: ADAL_LAN_UPDATES=0.
package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	lanClient = &http.Client{Timeout: 10 * time.Minute}
	lanKick   = make(chan struct{}, 1)
	mainRuns  atomic.Int64 // runs Main says are working now
	lanNamed  atomic.Value // the sha Main named last
	lanBytes  atomic.Int64 // bytes taken from Main (said in the log)
)

func lanUpdatesOn() bool { return os.Getenv("ADAL_LAN_UPDATES") != "0" }

// heardRelease: Main's answer to the announcement (robot.go).
func heardRelease(sha string, runs int64) {
	mainRuns.Store(runs)
	was, _ := lanNamed.Load().(string)
	if sha == "" || sha == was {
		return
	}
	lanNamed.Store(sha)
	select {
	case lanKick <- struct{}{}:
	default:
	}
}

// lanGet: one GET from Main with this PC's key. Replaced in tests.
var lanGet = func(path, etag string, from int64) (*http.Response, error) {
	if hostServer == "" {
		return nil, finalErr{errors.New("no main PC")}
	}
	key, err := mainAccessKey(false)
	if err != nil {
		return nil, finalErr{err}
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(hostServer, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-adal-pc", key)
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	if from > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", from))
	}
	return lanClient.Do(req)
}

var errNoLanRelease = errors.New("the main PC has no signed release to hand on")

// lanLatest: the signed release Main runs; nil when it is the one whose sha is `have`.
func (u *updater) lanLatest(have string) (*releaseManifest, *envelope, error) {
	etag := ""
	if have != "" {
		etag = `"` + have + `"`
	}
	resp, err := lanGet("/api/companion/lan/latest", etag, 0)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		return nil, nil, nil
	case http.StatusNotFound:
		return nil, nil, errNoLanRelease
	case http.StatusOK:
	default:
		return nil, nil, fmt.Errorf("the main PC answered %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, nil, err
	}
	lanBytes.Add(int64(len(b)))
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, nil, err
	}
	m, err := verifyRelease(env, u.key)
	return m, &env, err
}

// lanFile: one file Main has, by its SHA-256, into dest (it goes on after a cut; checked).
func lanFile(sha, dest string) error {
	if !hexSHA.MatchString(sha) {
		return errors.New("bad sha")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	part := dest + ".part"
	var last error
	for try := 0; try < 3; try++ {
		var have int64
		if st, err := os.Stat(part); err == nil {
			have = st.Size()
		}
		last = func() error {
			resp, err := lanGet("/api/companion/lan/file/"+sha, "", have)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			flags := os.O_CREATE | os.O_WRONLY
			switch resp.StatusCode {
			case http.StatusOK:
				flags |= os.O_TRUNC
			case http.StatusPartialContent:
				flags |= os.O_APPEND
			case http.StatusRequestedRangeNotSatisfiable:
				return nil // all of it is here
			default:
				return finalErr{fmt.Errorf("the main PC answered %d", resp.StatusCode)}
			}
			f, err := os.OpenFile(part, flags, 0o644)
			if err != nil {
				return err
			}
			n, err := io.Copy(f, resp.Body)
			lanBytes.Add(n)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			return err
		}()
		var fe finalErr
		if last == nil || errors.As(last, &fe) {
			break
		}
		time.Sleep(lanRetry)
	}
	if last != nil {
		return last
	}
	if fileSHA(part) != sha {
		os.Remove(part)
		return errors.New("does not match Adal's signed release")
	}
	return os.Rename(part, dest)
}

var lanRetry = 2 * time.Second

// fromLan: Main's signed release, when it is newer than what runs here.
func (u *updater) fromLan() error {
	have := u.lanDone
	if !u.lanAgain.IsZero() && time.Now().After(u.lanAgain) {
		have = "" // the server kept here did not follow then: looked at again
	}
	m, env, err := u.lanLatest(have)
	if errors.Is(err, errNoLanRelease) {
		return nil
	}
	if err != nil || m == nil {
		return err
	}
	if !waitForRuns(u.quit) {
		return nil
	}
	before := lanBytes.Load()
	u.lanAgain = time.Time{}
	// The server first: a new adal-companion.exe starts itself again a few seconds after install.
	var serr error
	if standby != nil {
		if serr = standby.followServer(u, m, env); serr != nil {
			u.lanAgain = time.Now().Add(30 * time.Minute)
			serr = fmt.Errorf("the server kept here: %w", serr)
		}
	}
	if isNewerRelease(m, u.baseline()) {
		log.Printf("🆕 update %s from the main PC", m.Short)
		lanNamed.Store(m.SHA)
		if err := u.install(m, env, false); err != nil {
			return errors.Join(serr, err)
		}
	}
	u.lanDone = m.SHA
	if n := lanBytes.Load() - before; n > 0 && serr == nil {
		log.Printf("✅ %s is here: %d KB from the main PC", m.Short, (n+1023)>>10)
	}
	return serr
}

// waitForRuns: not while a run works (10 minutes at most: a run is never longer). Replaced in tests.
var waitForRuns = func(quit <-chan struct{}) bool {
	for end := time.Now().Add(10 * time.Minute); mainRuns.Load() > 0 && time.Now().Before(end); {
		select {
		case <-quit:
			return false
		case <-time.After(5 * time.Second):
		}
	}
	return true
}

func (u *updater) lanLoop() {
	if !lanUpdatesOn() {
		return
	}
	time.Sleep(30 * time.Second)
	for {
		if hostServer != "" && !standbyActing() {
			if err := u.fromLan(); err != nil {
				log.Printf("update from the main PC: %v", err)
			}
		}
		select {
		case <-lanKick:
			time.Sleep(5 * time.Second)
		case <-time.After(5 * time.Minute):
		}
	}
}

// ── the server kept here ───────────────────────────────────────────────────

type treeFile struct {
	sha  string
	size int64
}

var safePart = regexp.MustCompile(`^[^\\:*?"<>|\x00]+$`)

// serverPath: where a path of the release is in server\ ("" when it must not be written).
func serverPath(root, rel string) string {
	if len(rel) > 400 || !safePart.MatchString(rel) || strings.HasPrefix(rel, "/") {
		return ""
	}
	inPackages := false
	for _, p := range strings.Split(rel, "/") {
		if p == "" || p == "." || p == ".." || strings.HasSuffix(p, ".") || strings.HasSuffix(p, " ") {
			return ""
		}
		l := strings.ToLower(p)
		if inPackages {
			continue
		}
		if l == "node_modules" {
			inPackages = true
			continue
		}
		if l == "data" || l == "uploads" || l == "logs" || l == ".git" || strings.HasPrefix(l, ".env") || strings.Contains(l, ".sqlite") {
			return ""
		}
	}
	dir := serverDir(root)
	if r, ok := strings.CutPrefix(rel, "adal-keep-backend/"); ok {
		return filepath.Join(dir, "backend", filepath.FromSlash(r))
	}
	if strings.HasPrefix(rel, "adal-keep-frontend/dist/") || strings.HasPrefix(rel, "backend/node_modules/") || rel == "runtime/node.exe" {
		return filepath.Join(dir, filepath.FromSlash(rel))
	}
	return ""
}

// The folders that hold only what the release says: a file not in it goes (unsigned code never stays).
var ownedDirs = []string{"backend/src", "backend/scripts", "backend/robots", "backend/bin", "adal-keep-frontend/dist"}

type serverMark struct {
	SHA         string `json:"sha"`
	Short       string `json:"short,omitempty"`
	Branch      string `json:"branch"`
	Source      string `json:"source"`
	LockHash    string `json:"lock_hash"`
	Date        string `json:"date"`
	PublishedAt string `json:"published_at"`
	Seq         int64  `json:"seq,omitempty"`
	Tree        string `json:"tree,omitempty"`   // the packages list checked here
	Signed      bool   `json:"signed,omitempty"` // every file checked against a signed release
}

func readServerMark(root string) (m serverMark) {
	if b, err := os.ReadFile(filepath.Join(serverDir(root), ".adal-version.json")); err == nil {
		json.Unmarshal(b, &m)
	}
	return
}

// followServer: server\ becomes release m (the one Main runs).
func (s *standbyRunner) followServer(u *updater, m *releaseManifest, env *envelope) error {
	if len(m.AppFiles) == 0 || !fullCopyAllowed(s.root) || standbyActing() {
		return nil
	}
	mark := readServerMark(s.root)
	if mark.Signed && sameSHA(mark.SHA, m.SHA) {
		return nil
	}
	if mark.SHA != "" && !sameSHA(mark.SHA, m.SHA) && !isNewerRelease(m, &releaseManifest{SHA: mark.SHA, Date: mark.Date, PublishedAt: mark.PublishedAt, Seq: mark.Seq}) {
		return fmt.Errorf("the main PC's release %s is not newer than the one here (%.7s)", m.Short, mark.SHA)
	}
	if t, ok := u.failed["server:"+m.SHA]; ok && time.Since(t) < 6*time.Hour {
		return nil
	}
	next, err := s.stageServer(m, mark)
	if err != nil {
		return err // what came stays in server.next (checked by SHA-256): the next try goes on
	}
	if err := s.putServer(next, m, env); err != nil {
		u.failed["server:"+m.SHA] = time.Now()
		return err
	}
	return nil
}

type staged struct {
	dir  string
	puts map[string]string // where → staged file
	gone []string
	mark serverMark
}

// stageServer: the files that differ, each checked, in server.next (nothing in place yet).
func (s *standbyRunner) stageServer(m *releaseManifest, mark serverMark) (*staged, error) {
	dir := filepath.Join(s.root, "server.next")
	st := &staged{dir: dir, puts: map[string]string{}, mark: mark}
	want := map[string]string{} // where → sha
	for rel, sha := range m.AppFiles {
		p := serverPath(s.root, rel)
		if p == "" || !hexSHA.MatchString(sha) || strings.Contains(rel, "node_modules") {
			return nil, fmt.Errorf("the release names a file it may not: %.80q", rel)
		}
		want[p] = sha
	}
	// The packages and Node: signed file by file when the release has their list, else as they are —
	// and only when the release's package list is the one these came from.
	hasTree := m.Tree != nil && hexSHA.MatchString(m.Tree.SHA256)
	if hasTree && mark.Tree != m.Tree.SHA256 {
		list, err := lanTree(m.Tree.SHA256, dir)
		if err != nil {
			return nil, err
		}
		for rel, f := range list {
			p := serverPath(s.root, rel)
			if p == "" || !hexSHA.MatchString(f.sha) {
				return nil, fmt.Errorf("the release names a file it may not: %.80q", rel)
			}
			want[p] = f.sha
		}
	} else if !hasTree {
		lock := fileSHA(filepath.Join(serverBackend(s.root), "package-lock.json"))
		if !hasServer(s.root) || m.LockHash == "" || lock != m.LockHash {
			return nil, errors.New("this release has other packages and they are not signed in it (build-lan-release --deps): the server here stays as it is")
		}
	}
	// What is here already, by content (a page's file only got another name).
	here := map[string]string{}
	need := map[string]string{}
	for p, sha := range want {
		if got := fileSHA(p); got == sha {
			here[got] = p
		} else {
			need[p] = sha
		}
	}
	for _, d := range ownedDirs {
		filepath.Walk(filepath.Join(serverDir(s.root), filepath.FromSlash(d)), func(p string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			if _, ok := want[p]; !ok {
				here[fileSHA(p)] = p
				st.gone = append(st.gone, p)
			}
			return nil
		})
	}
	for p := range need {
		if _, err := os.Stat(p); err == nil {
			here[fileSHA(p)] = p
		}
	}
	got := map[string]string{}
	for p, sha := range need {
		if f, ok := got[sha]; ok {
			st.puts[p] = f
			continue
		}
		f := filepath.Join(dir, sha)
		if fileSHA(f) == sha {
			// here from the try before
		} else if from := here[sha]; from != "" {
			os.MkdirAll(dir, 0o755)
			if err := copyFile(from, f); err != nil {
				return nil, err
			}
		} else if err := lanPatched(m, sha, here, f); err != nil {
			if err := lanFile(sha, f); err != nil {
				return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
			}
		}
		if fileSHA(f) != sha {
			return nil, errors.New("does not match Adal's signed release")
		}
		got[sha] = f
		st.puts[p] = f
	}
	return st, nil
}

// lanPatched: the file rebuilt from the one here and its small patch.
func lanPatched(m *releaseManifest, sha string, here map[string]string, dest string) error {
	pf := m.FilePatches[sha]
	if pf == nil || os.Getenv("ADAL_DELTA") == "0" {
		return errors.New("no patch")
	}
	base := here[pf.From]
	if base == "" {
		return errors.New("no base here")
	}
	old, err := os.ReadFile(base)
	if err != nil || sum256(old) != pf.From {
		return errors.New("no base here")
	}
	tmp := dest + ".patch"
	if err := lanFile(pf.SHA256, tmp); err != nil {
		return err
	}
	defer os.Remove(tmp)
	pb, err := os.ReadFile(tmp)
	if err != nil {
		return err
	}
	out, err := bspatch(old, pb)
	if err != nil {
		return err
	}
	if sum256(out) != sha {
		return errors.New("the patched file does not match Adal's signed release")
	}
	os.MkdirAll(filepath.Dir(dest), 0o755)
	return os.WriteFile(dest, out, 0o644)
}

// lanTree: the signed list of the packages (path → [sha256, size]).
func lanTree(sha, dir string) (map[string]treeFile, error) {
	f := filepath.Join(dir, "tree.gz")
	if err := lanFile(sha, f); err != nil {
		return nil, err
	}
	defer os.Remove(f)
	in, err := os.Open(f)
	if err != nil {
		return nil, err
	}
	defer in.Close()
	zr, err := gzip.NewReader(in)
	if err != nil {
		return nil, err
	}
	var v struct {
		Files map[string][2]any `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(zr, 64<<20)).Decode(&v); err != nil {
		return nil, err
	}
	out := map[string]treeFile{}
	for rel, a := range v.Files {
		h, _ := a[0].(string)
		n, _ := a[1].(float64)
		out[rel] = treeFile{h, int64(n)}
	}
	return out, nil
}

var (
	serverWaits = 3 * time.Minute // how long the updated server may take to answer
	putMu       sync.Mutex
)

type movedFile struct{ At, Kept string } // Kept "": the file was not there

// undoServer: the files before back in place (a server that did not answer, or an update cut off).
func undoServer(root string) {
	before := filepath.Join(root, "server.before")
	b, err := os.ReadFile(filepath.Join(before, "journal.json"))
	if err != nil {
		return
	}
	var list []movedFile
	if json.Unmarshal(b, &list) != nil {
		return
	}
	for _, f := range list {
		if f.Kept == "" {
			os.Remove(f.At)
		} else if _, err := os.Stat(f.Kept); err == nil {
			os.Remove(f.At)
			os.MkdirAll(filepath.Dir(f.At), 0o755)
			if err := os.Rename(f.Kept, f.At); err != nil {
				log.Printf("⚠️ not put back: %s: %v", f.At, err)
				return // the journal stays: the next start goes on
			}
		}
	}
	os.Remove(filepath.Join(before, "journal.json"))
	os.RemoveAll(before)
}

// tidyServer (at the start): an update cut off half-way is undone; a whole unsigned server an older
// program left to put in place is never used (one that holds this PC's data is left alone).
func tidyServer(root string) {
	undoServer(root)
	nw := serverDir(root) + ".new"
	if dirExists(nw) && !dirExists(filepath.Join(nw, "backend", "data")) && !dirExists(filepath.Join(nw, "backend", "uploads")) {
		os.RemoveAll(nw)
	}
}

// putServer: the staged files in place (the ones before kept in server.before), the server started
// again; one that does not answer goes back.
func (s *standbyRunner) putServer(st *staged, m *releaseManifest, env *envelope) error {
	putMu.Lock()
	defer putMu.Unlock()
	defer os.RemoveAll(st.dir)
	first := !hasServer(s.root)
	wasRunning := fullCopyRunning()
	wasAnswering := wasRunning && ownAnswers()
	before := filepath.Join(s.root, "server.before")
	undo := func() { undoServer(s.root) }
	err := func() error {
		swapMu.Lock()
		defer swapMu.Unlock()
		if standbyActing() {
			return errors.New("this PC stands in for the main PC now: later")
		}
		s.stopFull()
		os.RemoveAll(before)
		if err := os.MkdirAll(before, 0o755); err != nil {
			return err
		}
		// What will be moved, written down first: this program ended half-way, the next start puts it back.
		mark := filepath.Join(serverDir(s.root), ".adal-version.json")
		var list []movedFile
		add := func(p string) {
			m := movedFile{At: p, Kept: filepath.Join(before, fmt.Sprint(len(list)))}
			if _, err := os.Lstat(p); err != nil {
				m.Kept = ""
			}
			list = append(list, m)
		}
		for p := range st.puts {
			add(p)
		}
		for _, p := range st.gone {
			add(p)
		}
		add(mark)
		jb, _ := json.Marshal(list)
		if err := writeAtomic(filepath.Join(before, "journal.json"), jb, 0o644); err != nil {
			return err
		}
		for _, f := range list {
			if f.Kept != "" {
				if err := os.Rename(f.At, f.Kept); err != nil {
					return err
				}
			}
			if from := st.puts[f.At]; from != "" {
				os.MkdirAll(filepath.Dir(f.At), 0o755)
				if err := copyFile(from, f.At); err != nil {
					return err
				}
			}
		}
		mk := serverMark{SHA: m.SHA, Short: m.Short, Branch: "release", Source: "lan", LockHash: m.LockHash, Date: m.Date, PublishedAt: m.PublishedAt, Seq: m.Seq, Signed: true, Tree: st.mark.Tree}
		if m.Tree != nil {
			mk.Tree = m.Tree.SHA256
		}
		b, _ := json.Marshal(mk)
		return os.WriteFile(mark, b, 0o644)
	}()
	if err != nil {
		undo()
		return err
	}
	if first {
		s.firstSettings()
	}
	// It answered before: it must answer with the new files too.
	if wasAnswering {
		if err := s.startFull(); err != nil {
			log.Printf("🗂 own copy: %v", err)
		}
		ok := false
		for end := time.Now().Add(serverWaits); !ok && time.Now().Before(end); time.Sleep(time.Second) {
			ok = ownAnswers()
		}
		if !ok {
			swapMu.Lock()
			s.stopFull()
			undo()
			swapMu.Unlock()
			return fmt.Errorf("the server did not start with %s: the files before are back", m.Short)
		}
	}
	os.Remove(filepath.Join(before, "journal.json"))
	os.RemoveAll(before)
	s.mu.Lock()
	s.st.BundleVersion, s.st.BundleAt = m.SHA, time.Now().UTC().Format(time.RFC3339)
	s.save()
	s.mu.Unlock()
	log.Printf("🏢 The server kept here is %s now (%d file(s) changed)", m.Short, len(st.puts)+len(st.gone))
	return nil
}

// firstSettings: a first server's settings, locked with the agency's backup key (opened when it is here).
func (s *standbyRunner) firstSettings() {
	resp, err := lanGet("/api/companion/lan/settings", "", 0)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return
	}
	if b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)); err == nil {
		os.WriteFile(filepath.Join(serverBackend(s.root), ".env.locked"), b, 0o600)
		openSettings(serverDir(s.root))
	}
}
