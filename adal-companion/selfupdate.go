// selfupdate.go — an Adal Companion updates itself (asked on 2026-11-19).
//
// Supabase is the source of truth: the Companion reads Adal's signed release
// there itself (adal-updates/release/latest.json, with the online account the
// main PC gave it — companion-cloud.json, written by AdalKeep.exe), not only
// through the main PC. Nothing is installed unless Adal's Ed25519 signature
// (the same public key as the main PC: updateChannel.js) matches the manifest
// and every piece's SHA-256 matches the manifest.
//
// What a Companion installs from a release: its programs (AdalKeep.exe,
// adal-companion.exe — used from the next start) and its own online pages
// (the "online" folder), whole or as small patches from the release before
// (updates v2). Downloads go in Range pieces that resume after a cut (dl).
//
// Only from Supabase (2026-11-23, the owner): no PC of the office hands update
// pieces to another any more (the :47810 /lan routes, the UDP 45455 news, the
// offers to the main PC and the "whole release to hand on" were removed).
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Adal's update-signing public key (the private one is only on Adal's PC).
const updatePublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAimpnKnJzVGiLNH27Lkf4b2aCJoLOpL1fQuqF/gM1HTo=
-----END PUBLIC KEY-----`

var (
	lanHTTPPort = envInt("ADAL_LAN_HTTP", 47810)
	hexSHA      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// The programs a Companion has (the agent and the server are the main PC's).
	companionPrograms = map[string]bool{"AdalKeep.exe": true, "adal-companion.exe": true}
)

func envInt(k string, d int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n > 0 {
		return n
	}
	return d
}

func mustPublicKey(p string) ed25519.PublicKey {
	b, _ := pem.Decode([]byte(p))
	if b == nil {
		panic("update key")
	}
	k, err := x509.ParsePKIXPublicKey(b.Bytes)
	if err != nil {
		panic(err)
	}
	return k.(ed25519.PublicKey)
}

var updatePublicKey = mustPublicKey(updatePublicKeyPEM)

type piece struct {
	Name   string     `json:"name,omitempty"`
	File   string     `json:"file"`
	SHA256 string     `json:"sha256"`
	Size   int64      `json:"size,omitempty"`
	Raw    *rawForm   `json:"raw,omitempty"`   // the plain .tar of a .tar.gz piece (what a patch rebuilds)
	Patch  *patchForm `json:"patch,omitempty"` // a small patch from the release before (bspatch.go)
}

// rawForm: a piece as a plain .tar (docs/updates-v2.md §1).
type rawForm struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

// patchForm: the patch that turns the release before's piece (from, or from_gz un-gzipped) into this one.
type patchForm struct {
	From   string `json:"from"`
	FromGz string `json:"from_gz,omitempty"`
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

// rollout: a staged release (docs/updates-v2.md §3).
type rollout struct {
	Test       []string `json:"test"`
	Pct        int      `json:"pct"`
	PctAt      string   `json:"pct_at"`
	EveryoneAt string   `json:"everyone_at"`
	Stopped    bool     `json:"stopped"`
}

type releaseManifest struct {
	SHA         string    `json:"sha"`
	Short       string    `json:"short"`
	File        string    `json:"file"`
	SHA256      string    `json:"sha256"`
	PublishedAt string    `json:"published_at"`
	Date        string    `json:"date"`        // the commit's date (%cI)
	Seq         int64     `json:"seq"`         // publish order (a newer release has a higher one)
	RollbackOf  string    `json:"rollback_of"` // a deliberate "back to the version before"
	EveryoneAt  string    `json:"everyone_at"`
	Early       []string  `json:"early"`
	Audience    *audience `json:"audience"` // only these PCs take it from Supabase (the others get it from them over the office network)
	Programs    []piece   `json:"programs"`
	ProgramsX86 []piece   `json:"programs_x86"` // the same programs built for 32-bit Windows
	Online      *piece    `json:"online"`
	AppDelta    *struct {
		Raw   *rawForm   `json:"raw"`
		Patch *patchForm `json:"patch"`
	} `json:"app_delta"`
	Rollout *rollout `json:"rollout"`
}

// audience: PC names (os.Hostname, lower case) that may take a release from Supabase.
// Adal seeds one Companion with it; the rest get it from that PC over the office network.
type audience struct {
	PCs []string `json:"pcs"`
}

// audienceAllows: no audience = everyone; else this PC's name must be in it. Only Supabase is held back.
func audienceAllows(m *releaseManifest, host string) bool {
	if m == nil || m.Audience == nil || len(m.Audience.PCs) == 0 {
		return true
	}
	for _, n := range m.Audience.PCs {
		if strings.EqualFold(strings.TrimSpace(n), strings.TrimSpace(host)) {
			return true
		}
	}
	return false
}

var errAudience = errors.New("the newest release is being tried on other PCs first")

// ownHost: this PC's name, as the release's audience writes it.
var ownHost = func() string { h, _ := os.Hostname(); return h }

type envelope struct {
	Manifest  json.RawMessage `json:"manifest"`
	Signature string          `json:"signature"`
}

// ── the signature: the same text as canonical() in updateChannel.js ────────

func canonicalJSON(raw []byte) (string, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return "", err
	}
	var b strings.Builder
	canon(&b, v)
	return b.String(), nil
}

func canon(b *strings.Builder, v any) {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys) // JS sorts by UTF-16 units; the manifest's keys are ASCII
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			jsString(b, k)
			b.WriteByte(':')
			canon(b, x[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			canon(b, e)
		}
		b.WriteByte(']')
	case string:
		jsString(b, x)
	case json.Number:
		b.WriteString(x.String())
	case bool:
		b.WriteString(strconv.FormatBool(x))
	default:
		b.WriteString("null")
	}
}

// jsString: JSON.stringify of a string.
func jsString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// verifyRelease: the manifest, only when Adal signed it.
func verifyRelease(env envelope, key ed25519.PublicKey) (*releaseManifest, error) {
	text, err := canonicalJSON(env.Manifest)
	if err != nil {
		return nil, err
	}
	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil || !ed25519.Verify(key, []byte(text), sig) {
		return nil, errors.New("not signed by Adal")
	}
	var m releaseManifest
	if err := json.Unmarshal(env.Manifest, &m); err != nil || m.SHA == "" {
		return nil, errors.New("not a release manifest")
	}
	return &m, nil
}

// isNewerRelease: true only when cand is a LATER release than `than`
// (asked on 2026-11-19: "it is just downgrading"). The order is the signed
// manifest's publish sequence / publish time; the commit date is the fallback
// (and an older commit is never taken, except a deliberate rollback). Never by
// "another sha": a Companion with a newer release than the main PC's never
// takes the main PC's older one. When the order cannot be told: not newer.
func isNewerRelease(cand, than *releaseManifest) bool {
	if cand == nil || cand.SHA == "" {
		return false
	}
	if than == nil || than.SHA == "" {
		return true
	}
	if sameSHA(cand.SHA, than.SHA) {
		return false
	}
	// Adal's signed way back from exactly the release this PC runs ("Go back to previous version").
	if cand.RollbackOf != "" && sameSHA(cand.RollbackOf, than.SHA) {
		return true
	}
	cc, tc := releaseTime(cand.Date), releaseTime(than.Date)
	if !cc.IsZero() && !tc.IsZero() && cc.Before(tc) && cand.RollbackOf == "" {
		return false // older code
	}
	if cand.Seq > 0 && than.Seq > 0 {
		return cand.Seq > than.Seq
	}
	cp, tp := releaseTime(cand.PublishedAt), releaseTime(than.PublishedAt)
	switch {
	case !cp.IsZero() && !tp.IsZero():
		return cp.After(tp)
	case !cc.IsZero() && !tc.IsZero():
		return cc.After(tc)
	case !cp.IsZero() && !tc.IsZero():
		return cp.After(tc) // published after this build's commit
	}
	return false
}

func sameSHA(a, b string) bool {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	return n >= 7 && a[:n] == b[:n]
}

func releaseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t
}

// builtRelease: the release this program was built from, for a Companion
// installed from the USB that has no updates/current.json yet. Set by the
// installer build (-ldflags -X main.buildSHA=… -X main.buildDate=…). Not Go's
// own vcs stamp: in a git worktree it names another checkout's commit.
var buildSHA, buildDate string

var builtRelease = func() *releaseManifest {
	if buildSHA == "" || buildDate == "" {
		return nil
	}
	return &releaseManifest{SHA: buildSHA, Date: buildDate}
}()

// ── what this Companion has ────────────────────────────────────────────────

type updater struct {
	root     string
	key      ed25519.PublicKey
	mu       sync.Mutex // one install at a time
	failed   map[string]time.Time
	client   *http.Client     // small calls (sign-in, latest.json)
	dlClient *http.Client     // downloads: each piece has its own timeout (dl)
	built    *releaseManifest // the release this program was built from (builtRelease)
}

func newUpdater(root string) *updater {
	return &updater{root: root, key: updatePublicKey, failed: map[string]time.Time{}, built: builtRelease, client: &http.Client{Timeout: time.Minute}, dlClient: &http.Client{}}
}

func (u *updater) dir() string         { return filepath.Join(u.root, "updates") }
func (u *updater) files() string       { return filepath.Join(u.dir(), "files") }
func (u *updater) currentFile() string { return filepath.Join(u.dir(), "current.json") }

func (u *updater) current() (*releaseManifest, *envelope) {
	b, err := os.ReadFile(u.currentFile())
	if err != nil {
		return nil, nil
	}
	var env envelope
	if json.Unmarshal(b, &env) != nil {
		return nil, nil
	}
	m, err := verifyRelease(env, u.key)
	if err != nil {
		return nil, nil
	}
	return m, &env
}

// baseline: what this Companion runs now — the newer of its kept release and
// the release its program was built from. Nothing older than it is installed.
func (u *updater) baseline() *releaseManifest {
	cur, _ := u.current()
	if b := u.built; b != nil && (cur == nil || isNewerRelease(b, cur)) {
		return b
	}
	return cur
}

// is32bitWindows: this PC runs 32-bit Windows (or this program is a 32-bit build).
func is32bitWindows() bool {
	return runtime.GOOS == "windows" && (runtime.GOARCH == "386" || os.Getenv("PROCESSOR_ARCHITECTURE") == "x86" && os.Getenv("PROCESSOR_ARCHITEW6432") == "")
}

// is32bit: replaced in tests.
var is32bit = is32bitWindows

// ownPrograms: the programs built for this PC — programs_x86 on 32-bit Windows
// (when the release has them), else programs.
func ownPrograms(m *releaseManifest) []piece {
	if is32bit() && len(m.ProgramsX86) > 0 {
		return m.ProgramsX86
	}
	return m.Programs
}

func appPiece(m *releaseManifest) (piece, bool) {
	if m.SHA256 == "" || m.File == "" {
		return piece{}, false
	}
	p := piece{File: m.File, SHA256: m.SHA256}
	if m.AppDelta != nil {
		p.Raw, p.Patch = m.AppDelta.Raw, m.AppDelta.Patch
	}
	return p, true
}

// piecesOf: what a complete release here is — the app, this PC's programs, the pages.
// (The other build's programs are kept and served when here, never fetched just to hand on.)
func piecesOf(m *releaseManifest) []piece {
	return piecesWith(m, ownPrograms(m))
}

// allPieces: every piece the release names (both program lists), for serving and keeping.
func allPieces(m *releaseManifest) []piece {
	return piecesWith(m, append(append([]piece(nil), m.Programs...), m.ProgramsX86...))
}

func piecesWith(m *releaseManifest, programs []piece) []piece {
	var out []piece
	if p, ok := appPiece(m); ok {
		out = append(out, p)
	}
	out = append(out, programs...)
	if m.Online != nil && m.Online.SHA256 != "" {
		out = append(out, *m.Online)
	}
	return out
}

// forms: every SHA-256 a piece is known by (the .tar.gz or program, the plain .tar, the patch).
func forms(p piece) []string {
	out := []string{p.SHA256}
	if p.Raw != nil && p.Raw.SHA256 != "" {
		out = append(out, p.Raw.SHA256)
	}
	if p.Patch != nil && p.Patch.SHA256 != "" {
		out = append(out, p.Patch.SHA256)
	}
	return out
}

// pieceHere: the piece kept here in a whole form (plain .tar first, then as published); "" when none.
func (u *updater) pieceHere(p piece) string {
	if p.Raw != nil {
		if hit := u.piecePath(p.Raw.SHA256); hit != "" {
			return hit
		}
	}
	return u.piecePath(p.SHA256)
}

func fileSHA(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func (u *updater) piecePath(sha string) string {
	if !hexSHA.MatchString(sha) {
		return ""
	}
	p := filepath.Join(u.files(), sha)
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// ── getting pieces ─────────────────────────────────────────────────────────

// How a download goes on a slow line (2026-11-19: the main PC's update was cut
// off by one timeout): in pieces (Range requests) into <dest>.part, which stays
// between tries, so each try goes on where the last one stopped. Each piece
// has its own timeout; a failed piece is tried again after a growing wait;
// only many tries in a row with no progress give up. Replaced in tests.
var dl = struct {
	chunk          int64
	timeout, stall time.Duration
	tries          int
	backoff        time.Duration
}{chunk: 2 << 20, timeout: 3 * time.Minute, stall: time.Minute, tries: 6, backoff: 2 * time.Second}

var contentRange = regexp.MustCompile(`bytes\s+(\d+)-\d+/(\d+|\*)`)

func (u *updater) download(url string, hdr map[string]string, want, dest string) error {
	os.MkdirAll(filepath.Dir(dest), 0o755)
	part := dest + ".part"
	have := func() int64 {
		if st, err := os.Stat(part); err == nil {
			return st.Size()
		}
		return 0
	}
	var total int64
	failures := 0
	for {
		before := have()
		if total > 0 && before >= total {
			break
		}
		done, err := u.downloadPiece(url, hdr, part, before, &total)
		if done {
			break
		}
		if total > 0 && have() > total { // nonsense: from the start again
			os.Remove(part)
			total = 0
		}
		if have() > before {
			failures = 0
			continue
		}
		var fe finalErr
		if errors.As(err, &fe) {
			return err
		}
		failures++
		if failures >= dl.tries {
			if err == nil {
				err = errors.New("no data")
			}
			return fmt.Errorf("download stopped after %d tries with no progress: %w", failures, err)
		}
		if err != nil {
			wait := dl.backoff << (failures - 1)
			if wait > time.Minute {
				wait = time.Minute
			}
			time.Sleep(wait)
		}
	}
	if fileSHA(part) != want {
		os.Remove(part)
		return errors.New("does not match Adal's signed release")
	}
	return os.Rename(part, dest)
}

type finalErr struct{ error }

// downloadPiece: one request from `from`; what arrives is added to part (kept on a cut).
// done: the file is all here.
func (u *updater) downloadPiece(url string, hdr map[string]string, part string, from int64, total *int64) (bool, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(dl.timeout, cancel)
	defer timer.Stop()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, from+dl.chunk-1))
	resp, err := u.dlClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch resp.StatusCode {
	case http.StatusRequestedRangeNotSatisfiable:
		if *total == 0 {
			*total = from
		}
		return true, nil
	case http.StatusPartialContent:
		m := contentRange.FindStringSubmatch(resp.Header.Get("Content-Range"))
		if m == nil || m[1] != strconv.FormatInt(from, 10) {
			return false, errors.New("the server sent another part than asked")
		}
		if n, err := strconv.ParseInt(m[2], 10, 64); err == nil {
			*total = n
		}
		flags |= os.O_APPEND
	case http.StatusOK:
		// The whole file from the start (the server ignores Range): a stall ends it, not the total time.
		*total = resp.ContentLength
		flags |= os.O_TRUNC
		timer.Reset(dl.stall)
	default:
		err := fmt.Errorf("answered %d", resp.StatusCode)
		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 408 && resp.StatusCode != 425 && resp.StatusCode != 429 {
			return false, finalErr{err}
		}
		return false, err
	}
	f, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return false, err
	}
	defer f.Close()
	buf := make([]byte, 64<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return false, werr
			}
			if resp.StatusCode == http.StatusOK {
				timer.Reset(dl.stall)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return false, rerr
		}
	}
	if resp.StatusCode == http.StatusOK && *total <= 0 {
		st, _ := f.Stat()
		*total = st.Size()
		return true, nil
	}
	return false, nil
}

// getPiece: kept here already (in any whole form), else rebuilt from the
// release before with its small patch, else (when allowed) from Supabase. Checked every
// time. The path it gives may be a .tar.gz or a plain .tar (untarGz reads both).
func (u *updater) getPiece(m *releaseManifest, p piece, fromCloud bool) (string, error) {
	whole := []string{p.SHA256}
	if p.Raw != nil && hexSHA.MatchString(p.Raw.SHA256) {
		whole = []string{p.Raw.SHA256, p.SHA256}
	}
	for _, sha := range whole {
		if hit := u.piecePath(sha); hit != "" && fileSHA(hit) == sha {
			return hit, nil
		}
	}
	if !hexSHA.MatchString(p.SHA256) {
		return "", errors.New("bad piece")
	}
	if p.Patch != nil && os.Getenv("ADAL_DELTA") != "0" {
		got, err := u.patchPiece(m, p, fromCloud)
		if err == nil {
			return got, nil
		}
		log.Printf("update: no patch for %s (%v), the whole piece instead", filepath.Base(p.File), err)
	}
	if !fromCloud {
		return "", errors.New("not kept on this PC")
	}
	return u.fromSupabase(p.File, p.SHA256)
}

// fromSupabase: one file of the release from adal-updates, checked against sha.
func (u *updater) fromSupabase(file, sha string) (string, error) {
	c := readCloud(u.root)
	if c == nil {
		return "", errors.New("no online account yet")
	}
	tok, err := c.token(u.client)
	if err != nil {
		return "", err
	}
	dest := filepath.Join(u.files(), sha)
	err = u.download(c.URL+"/storage/v1/object/authenticated/adal-updates/"+file, map[string]string{"apikey": c.Anon, "Authorization": "Bearer " + tok}, sha, dest)
	return dest, err
}

// patchBase: the release before's form of the piece that the patch starts from.
func (u *updater) patchBase(p piece) ([]byte, error) {
	from := p.Patch.From
	if hit := u.piecePath(from); hit != "" {
		if b, err := os.ReadFile(hit); err == nil && sum256(b) == from {
			return b, nil
		}
	}
	if hit := u.piecePath(p.Patch.FromGz); hit != "" {
		if f, err := os.Open(hit); err == nil {
			defer f.Close()
			if zr, err := gzip.NewReader(f); err == nil {
				b, err := io.ReadAll(io.LimitReader(zr, 1<<31))
				if err == nil && sum256(b) == from {
					return b, nil
				}
			}
		}
	}
	// A program: the one installed on this PC.
	if p.Name != "" && filepath.Base(p.Name) == p.Name {
		if b, err := os.ReadFile(filepath.Join(u.root, p.Name)); err == nil && sum256(b) == from {
			return b, nil
		}
	}
	return nil, errors.New("the release before is not here")
}

// patchPiece: piece p rebuilt from the release before and its patch (the
// patch from a PC of the office, else Supabase), checked against the signed
// SHA-256 (the plain .tar's for a .tar.gz piece, the program's own otherwise).
func (u *updater) patchPiece(m *releaseManifest, p piece, fromCloud bool) (string, error) {
	pf := p.Patch
	want := p.SHA256
	if p.Raw != nil {
		want = p.Raw.SHA256
	}
	if !hexSHA.MatchString(pf.From) || !hexSHA.MatchString(pf.SHA256) || !hexSHA.MatchString(want) {
		return "", errors.New("bad patch")
	}
	old, err := u.patchBase(p)
	if err != nil {
		return "", err
	}
	pp := u.piecePath(pf.SHA256)
	if pp == "" || fileSHA(pp) != pf.SHA256 {
		if !fromCloud {
			return "", errors.New("the patch is not kept on this PC")
		}
		if pp, err = u.fromSupabase(pf.File, pf.SHA256); err != nil {
			return "", err
		}
	}
	pb, err := os.ReadFile(pp)
	if err != nil {
		return "", err
	}
	out, err := bspatch(old, pb)
	old = nil
	if err != nil {
		return "", err
	}
	if sum256(out) != want {
		return "", errors.New("the patched piece does not match Adal's signed release")
	}
	dest := filepath.Join(u.files(), want)
	os.MkdirAll(u.files(), 0o755)
	if err := os.WriteFile(dest+".part", out, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(dest+".part", dest); err != nil {
		return "", err
	}
	log.Printf("⬇️ update: %s rebuilt from a %d KB patch", filepath.Base(p.File), len(pb)>>10)
	return dest, nil
}

func sum256(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// ── Supabase (the source of truth) ─────────────────────────────────────────

type cloudCreds struct {
	URL      string `json:"url"`
	Anon     string `json:"anon"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Agency   string `json:"agency"`
}

func readCloud(root string) *cloudCreds {
	b, err := os.ReadFile(filepath.Join(root, "companion-cloud.json"))
	if err != nil {
		return nil
	}
	var c cloudCreds
	if json.Unmarshal(b, &c) != nil || c.URL == "" || c.Email == "" {
		return nil
	}
	c.URL = strings.TrimRight(c.URL, "/")
	return &c
}

func (c *cloudCreds) token(h *http.Client) (string, error) {
	body, _ := json.Marshal(map[string]string{"email": c.Email, "password": c.Password})
	req, _ := http.NewRequest(http.MethodPost, c.URL+"/auth/v1/token?grant_type=password", bytes.NewReader(body))
	req.Header.Set("apikey", c.Anon)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var r struct {
		AccessToken string `json:"access_token"`
	}
	json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&r)
	if r.AccessToken == "" {
		return "", fmt.Errorf("online sign-in answered %d", resp.StatusCode)
	}
	return r.AccessToken, nil
}

func (u *updater) cloudLatest() (*releaseManifest, *envelope, error) {
	c := readCloud(u.root)
	if c == nil {
		return nil, nil, errors.New("no online account yet")
	}
	tok, err := c.token(u.client)
	if err != nil {
		return nil, nil, err
	}
	req, _ := http.NewRequest(http.MethodGet, c.URL+"/storage/v1/object/authenticated/adal-updates/release/latest.json", nil)
	req.Header.Set("apikey", c.Anon)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("Supabase updates answered %d", resp.StatusCode)
	}
	var env envelope
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&env); err != nil {
		return nil, nil, err
	}
	m, err := verifyRelease(env, u.key)
	if err == nil && !audienceAllows(m, ownHost()) {
		return m, &env, errAudience
	}
	return m, &env, err
}

// itsTurn: a staged release reaches the "updates first" agencies at once, everyone else at everyone_at.
// With a rollout (docs/updates-v2.md §3): not stopped, and (a test agency, or
// everyone_at has come, or pct_at has come and the agency's bucket < pct).
func itsTurn(m *releaseManifest, agency string, now time.Time) bool {
	if r := m.Rollout; r != nil {
		if r.Stopped {
			return false
		}
		for _, a := range r.Test {
			if agency != "" && a == agency {
				return true
			}
		}
		reached := func(at string) bool {
			t, err := time.Parse(time.RFC3339, at)
			return err == nil && !now.Before(t)
		}
		return reached(r.EveryoneAt) || reached(r.PctAt) && rolloutBucket(m.SHA, agency) < r.Pct
	}
	if m.EveryoneAt == "" {
		return true
	}
	if t, err := time.Parse(time.RFC3339, m.EveryoneAt); err != nil || !t.After(now) {
		return true
	}
	for _, a := range m.Early {
		if agency != "" && a == agency {
			return true
		}
	}
	return false
}

// rolloutBucket: 0-99, the same for an agency and a release on every PC (and in Node).
func rolloutBucket(sha, agency string) int {
	if agency == "" {
		return 99
	}
	h := sha256.Sum256([]byte("adal-rollout|" + sha + "|" + agency))
	return int(binary.BigEndian.Uint32(h[:4]) % 100)
}

// ── installing ─────────────────────────────────────────────────────────────

// install: the release's programs and online pages, each checked; then kept
// (signed) to hand on, and the office told.
func (u *updater) install(m *releaseManifest, env *envelope, fromCloud bool) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	// Only forward.
	if !isNewerRelease(m, u.baseline()) {
		return nil
	}
	if t, ok := u.failed[m.SHA]; ok && time.Since(t) < 10*time.Minute {
		return errors.New("tried a moment ago")
	}
	before, _ := u.current()
	err := u.installPieces(m, fromCloud)
	if err != nil {
		u.failed[m.SHA] = time.Now()
		return err
	}
	os.MkdirAll(u.files(), 0o755)
	b, _ := json.Marshal(env)
	if err := os.WriteFile(u.currentFile(), b, 0o644); err != nil {
		return err
	}
	// The pieces of older releases go: every form of this release's pieces stays,
	// and those of the release before (the base of the next patch).
	want := map[string]bool{}
	for _, r := range []*releaseManifest{m, before} {
		if r == nil {
			continue
		}
		for _, p := range allPieces(r) {
			for _, sha := range forms(p) {
				want[sha] = true
			}
		}
	}
	if es, err := os.ReadDir(u.files()); err == nil {
		for _, e := range es {
			if !want[strings.TrimSuffix(e.Name(), ".part")] { // a half-download of a wanted piece stays (it goes on)
				os.Remove(filepath.Join(u.files(), e.Name()))
			}
		}
	}
	log.Printf("✅ update %s installed on this Companion (programs from the next start)", m.Short)
	// Its server in waiting follows the new version at once (standby.go).
	kickBundle()
	// This program itself: the new one runs within seconds (never while this PC
	// stands in for the main PC, and never the window — it takes it when opened again).
	if selfReplaced && !standbyActing() {
		selfReplaced = false
		go restartSelfSoon()
	}
	return nil
}

func (u *updater) installPieces(m *releaseManifest, fromCloud bool) error {
	// 32-bit Windows: only programs_x86; never a 64-bit program there.
	no32 := is32bit() && len(m.ProgramsX86) == 0
	for _, p := range ownPrograms(m) {
		if !companionPrograms[p.Name] {
			continue
		}
		dest := filepath.Join(u.root, p.Name)
		if _, err := os.Stat(dest); err != nil {
			continue // not on this PC
		}
		if no32 {
			log.Printf("no 32-bit build of %s in %s: kept the one installed", p.Name, m.Short)
			continue
		}
		got, err := u.getPiece(m, p, fromCloud)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if fileSHA(dest) == p.SHA256 {
			continue
		}
		// A running program cannot be overwritten, but it can be renamed. The one
		// renamed last time may still run (a window open through two updates):
		// then this one goes aside under a name of its own.
		aside := setAside(dest)
		if err := os.Rename(dest, aside); err != nil {
			return err
		}
		if err := copyFile(got, dest); err != nil {
			os.Rename(aside, dest)
			return err
		}
		log.Printf("⬆️ %s updated (used from the next start)", p.Name)
		go cleanOldPrograms(u.root) // what the last update left running (never this program)
		if p.Name == "adal-companion.exe" {
			selfReplaced = true
		}
	}
	if m.Online != nil && m.Online.SHA256 != "" {
		online := filepath.Join(u.root, "online")
		if _, err := os.Stat(filepath.Join(online, "index.html")); err == nil {
			got, err := u.getPiece(m, *m.Online, fromCloud)
			if err != nil {
				return fmt.Errorf("online pages: %w", err)
			}
			if err := swapDir(got, online); err != nil {
				return fmt.Errorf("online pages: %w", err)
			}
			log.Printf("⬆️ online pages updated")
		}
	}
	return nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// swapDir: the .tar.gz unpacked next to dir, then put in its place.
func swapDir(archive, dir string) error {
	fresh := dir + ".new"
	os.RemoveAll(fresh)
	if err := untarGz(archive, fresh); err != nil {
		os.RemoveAll(fresh)
		return err
	}
	if _, err := os.Stat(filepath.Join(fresh, "index.html")); err != nil {
		os.RemoveAll(fresh)
		return errors.New("no index.html in it")
	}
	// What this PC wrote there itself stays (config.js: its Supabase address).
	if b, err := os.ReadFile(filepath.Join(dir, "config.js")); err == nil {
		if _, err := os.Stat(filepath.Join(fresh, "config.js")); err != nil {
			os.WriteFile(filepath.Join(fresh, "config.js"), b, 0o644)
		}
	}
	old := dir + ".old"
	os.RemoveAll(old)
	if err := os.Rename(dir, old); err != nil {
		os.RemoveAll(fresh)
		return err
	}
	if err := os.Rename(fresh, dir); err != nil {
		os.Rename(old, dir)
		return err
	}
	os.RemoveAll(old)
	return nil
}

func untarGz(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	// A .tar.gz, or a plain .tar (a piece rebuilt from a patch).
	br := bufio.NewReader(f)
	var r io.Reader = br
	if magic, _ := br.Peek(2); len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gz, err := gzip.NewReader(br)
		if err != nil {
			return err
		}
		r = gz
	}
	tr := tar.NewReader(r)
	base, _ := filepath.Abs(dest)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(base, filepath.FromSlash(h.Name))
		if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
			return errors.New("unsafe path in the archive")
		}
		switch h.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(target, 0o755)
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(target), 0o755)
			out, err := os.Create(target)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, io.LimitReader(tr, 200<<20))
			out.Close()
			if err != nil {
				return err
			}
		}
	}
}

// ── telling and hearing ────────────────────────────────────────────────────

// agencyTag: a hash of the agency's main PC number (the number itself is never
// broadcast); the same as services/lanRelease.js agencyTag.
func agencyTag(number string) string {
	var d strings.Builder
	for _, r := range number {
		if r >= '0' && r <= '9' {
			d.WriteRune(r)
		}
	}
	if d.Len() == 0 {
		return ""
	}
	h := sha256.Sum256([]byte("adal-agency|" + d.String()))
	return hex.EncodeToString(h[:])[:16]
}

// ownAgencyTag: this Companion's agency (the number it joined with); "" when
// it has none. Replaced in tests.
var ownAgencyTag = func() string { return agencyTag(confNumber()) }

// fromCloud: Supabase's newest signed release, when it is newer and its turn has come.
func (u *updater) fromCloud() error {
	m, env, err := u.cloudLatest()
	if errors.Is(err, errAudience) {
		return nil // being tried on other PCs first: this PC's turn comes later
	}
	if err != nil {
		return err
	}
	if !isNewerRelease(m, u.baseline()) {
		return nil
	}
	if c := readCloud(u.root); !itsTurn(m, c.Agency, time.Now()) {
		return nil
	}
	log.Printf("🆕 update %s from Supabase", m.Short)
	return u.install(m, env, true)
}

// handler: what this program answers on :47810 (this PC's own window; no update pieces since 2026-11-23).
func (u *updater) handler() *http.ServeMux {
	mux := http.NewServeMux()
	// "Back up now" in this PC's own Adal Keep window while the main PC is off
	// (asked on 2026-11-19): the locked copy kept here goes to the agency's
	// Telegram at once. Only from this PC itself, never from the network.
	mux.HandleFunc("/backup/now", func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			http.Error(w, "only from this PC", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); strings.HasPrefix(o, "http://127.0.0.1:") || strings.HasPrefix(o, "http://localhost:") {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(backupNowAnswer())
	})
	mux.HandleFunc("/support", supportHandler) // Settings → Remote support by Adal, this PC (support.go)
	mux.HandleFunc("/update/check", func(w http.ResponseWriter, r *http.Request) { localOnly(w, r, u.updateCheck) })
	mux.HandleFunc("/update/apply", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodOptions {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		localOnly(w, r, u.updateApply)
	})
	return mux
}

// localOnly answers a request from this PC itself (the Companion's own Adal Keep
// window) with JSON; anything from the network is refused.
func localOnly(w http.ResponseWriter, r *http.Request, answer func() map[string]any) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		http.Error(w, "only from this PC", http.StatusForbidden)
		return
	}
	if o := r.Header.Get("Origin"); strings.HasPrefix(o, "http://127.0.0.1:") || strings.HasPrefix(o, "http://localhost:") {
		w.Header().Set("Access-Control-Allow-Origin", o)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == http.MethodOptions {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(answer())
}

// updateCheck: is a newer Adal Keep published than the one on this PC? (Settings → Check for updates)
func (u *updater) updateCheck() map[string]any {
	cur := u.baseline()
	short := ""
	if cur != nil {
		short = cur.Short
	}
	m, _, err := u.cloudLatest()
	if err != nil {
		return map[string]any{"hasUpdate": false, "error": "Could not reach the updates: " + err.Error(), "current": short}
	}
	return map[string]any{"hasUpdate": isNewerRelease(m, cur), "current": short, "latest": m.Short, "companion": true}
}

// updateApply: installs the newest Adal Keep on this PC now (asked on 2026-11-19: the Companion updates itself too).
func (u *updater) updateApply() map[string]any {
	m, env, err := u.cloudLatest()
	if err != nil {
		return map[string]any{"ok": false, "error": "Could not reach the updates: " + err.Error()}
	}
	if !isNewerRelease(m, u.baseline()) {
		return map[string]any{"ok": true, "message": "Adal Keep is up to date (" + m.Short + ")."}
	}
	log.Printf("🆕 update %s now (pressed on this PC)", m.Short)
	if err := u.install(m, env, true); err != nil {
		return map[string]any{"ok": false, "error": "The update did not install: " + err.Error()}
	}
	return map[string]any{"ok": true, "message": "Updated to " + m.Short + ". Close Adal Keep and open it again to use it."}
}

// backupNowAnswer starts a backup from the copy here when there is something new to send.
func backupNowAnswer() map[string]any {
	st, keys := loadState(), loadKeys()
	switch {
	case st.Made == "":
		return map[string]any{"started": false, "message": "This PC has no copy of the agency yet: it is made while the main PC is on."}
	case keys.Password == "" || keys.BotToken == "" || keys.ChatID == "":
		return map[string]any{"started": false, "message": "This PC has no backup key yet: it gets it from the main PC while the main PC is on."}
	case st.OwnBackupCopy == st.Made && st.OwnBackupAt != "":
		return map[string]any{"started": false, "done": true, "message": "Already backed up from this PC's copy (" + st.OwnBackupAt + "). Nothing new to send until the main PC is on."}
	}
	go func() {
		if err := backupFromCopy(); err != nil {
			log.Printf("💾 Back up now failed: %v", err)
		}
	}()
	return map[string]any{"started": true, "message": "Backing up now from the copy on this PC (made " + st.Made + ") to the agency's Telegram."}
}

// startSelfUpdate: runs for ever in the background (an employee PC only).
func startSelfUpdate(root string) *updater {
	u := newUpdater(root)
	if ln, err := net.Listen("tcp", fmt.Sprintf(":%d", lanHTTPPort)); err == nil {
		mux := u.handler()
		addReplicaRoutes(mux)     // the copy, for a restore on a new main PC (replica.go)
		addMainProxy(mux)         // the online pages reach the main PC over the network (mainproxy.go)
		addRobotRoutes(mux, root) // the main PC's robots in this PC's Adal Browser (robot.go)
		addPeerRoutes(mux, root)  // its copy and server for the other Companions (peers.go)
		go http.Serve(ln, mux)
		go announceRobot()
		go probeNetwork()
	} else {
		log.Printf("⚠️ this PC's own routes (:%d): %v", lanHTTPPort, err)
	}
	go func() {
		time.Sleep(20 * time.Second)
		for {
			// Supabase only (2026-11-23: no update pieces between the office's PCs).
			if err := u.fromCloud(); err != nil && readCloud(root) != nil {
				log.Printf("update from Supabase: %v", err)
			}
			time.Sleep(time.Duration(envInt("ADAL_UPDATE_MINUTES", 30)) * time.Minute)
		}
	}()
	return u
}

// setAside: where a program being replaced goes — dest.old, or (that one still
// in use) dest.old-<time>; leftovers no longer in use are removed.
func setAside(dest string) string {
	if olds, _ := filepath.Glob(dest + ".old-*"); len(olds) > 0 {
		for _, o := range olds {
			os.Remove(o) // fails while it runs: kept until next time
		}
	}
	if err := os.Remove(dest + ".old"); err == nil || os.IsNotExist(err) {
		return dest + ".old"
	}
	return fmt.Sprintf("%s.old-%d", dest, time.Now().UnixNano())
}
