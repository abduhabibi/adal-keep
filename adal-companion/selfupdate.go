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
// (the "online" folder). The rest of Adal Keep comes from the main PC.
//
// The office network helps (the same as the main PC, services/lanRelease.js):
//
//	UDP 45455 broadcast  ADAL_KEEP_RELEASE_V1|<sha>|<published_at>|<port>|<path>
//	GET :47810/lan/latest       { manifest, signature } — the release kept here
//	GET :47810/lan/file/<sha256> one of its pieces
//
// A PC that hears of a newer release (published later, another sha: the same
// sha is never fetched twice, so nothing goes round) asks that PC for it,
// checks the signature, downloads the pieces from it (checked), installs, and
// then tells the others itself. Pieces a peer does not have come from Supabase.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
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

const releaseMagic = "ADAL_KEEP_RELEASE_V1"

var (
	releaseUDPPort = envInt("ADAL_RELEASE_UDP", 45455)
	lanHTTPPort    = envInt("ADAL_LAN_HTTP", 47810)
	hexSHA         = regexp.MustCompile(`^[0-9a-f]{64}$`)
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
	Name   string `json:"name,omitempty"`
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

type releaseManifest struct {
	SHA         string   `json:"sha"`
	Short       string   `json:"short"`
	File        string   `json:"file"`
	SHA256      string   `json:"sha256"`
	PublishedAt string   `json:"published_at"`
	EveryoneAt  string   `json:"everyone_at"`
	Early       []string `json:"early"`
	Programs    []piece  `json:"programs"`
	Online      *piece   `json:"online"`
}

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

// isNewerRelease: published later, and another version (the same sha is never taken twice).
func isNewerRelease(sha, publishedAt string, than *releaseManifest) bool {
	if sha == "" {
		return false
	}
	return than == nil || (sha != than.SHA && publishedAt > than.PublishedAt)
}

// ── what this Companion has ────────────────────────────────────────────────

type updater struct {
	root string
	key  ed25519.PublicKey
	mu   sync.Mutex // one install at a time
	pm   sync.Mutex
	// peers heard on the network: base → what it has
	peers  map[string]peerInfo
	failed map[string]time.Time
	conn   *net.UDPConn
	client *http.Client
}

type peerInfo struct {
	SHA, PublishedAt string
	At               time.Time
}

func newUpdater(root string) *updater {
	return &updater{root: root, key: updatePublicKey, peers: map[string]peerInfo{}, failed: map[string]time.Time{}, client: &http.Client{Timeout: 10 * time.Minute}}
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

func piecesOf(m *releaseManifest) []piece {
	var out []piece
	if m.SHA256 != "" && m.File != "" {
		out = append(out, piece{File: m.File, SHA256: m.SHA256})
	}
	out = append(out, m.Programs...)
	if m.Online != nil && m.Online.SHA256 != "" {
		out = append(out, *m.Online)
	}
	return out
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

func (u *updater) download(url string, hdr map[string]string, want, dest string) error {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("answered %d", resp.StatusCode)
	}
	os.MkdirAll(filepath.Dir(dest), 0o755)
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	f.Close()
	if err == nil && hex.EncodeToString(h.Sum(nil)) != want {
		err = errors.New("does not match Adal's signed release")
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}

func (u *updater) peersWith(sha string) []string {
	u.pm.Lock()
	defer u.pm.Unlock()
	var out []string
	for b, p := range u.peers {
		if p.SHA == sha && time.Since(p.At) < time.Hour {
			out = append(out, b)
		}
	}
	sort.Strings(out)
	return out
}

// getPiece: kept here already, else from a PC of the office that has this
// release, else (when allowed) from Supabase. Checked every time.
func (u *updater) getPiece(m *releaseManifest, p piece, fromCloud bool) (string, error) {
	if hit := u.piecePath(p.SHA256); hit != "" && fileSHA(hit) == p.SHA256 {
		return hit, nil
	}
	if !hexSHA.MatchString(p.SHA256) {
		return "", errors.New("bad piece")
	}
	dest := filepath.Join(u.files(), p.SHA256)
	for _, base := range u.peersWith(m.SHA) {
		if err := u.download(base+"/file/"+p.SHA256, nil, p.SHA256, dest); err == nil {
			log.Printf("⬇️ update: %s from %s", filepath.Base(p.File), base)
			return dest, nil
		}
	}
	if !fromCloud {
		return "", errors.New("no PC of the office has it")
	}
	c := readCloud(u.root)
	if c == nil {
		return "", errors.New("no online account yet")
	}
	tok, err := c.token(u.client)
	if err != nil {
		return "", err
	}
	err = u.download(c.URL+"/storage/v1/object/authenticated/adal-updates/"+p.File, map[string]string{"apikey": c.Anon, "Authorization": "Bearer " + tok}, p.SHA256, dest)
	return dest, err
}

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
	return m, &env, err
}

// itsTurn: a staged release reaches the "updates first" agencies at once, everyone else at everyone_at.
func itsTurn(m *releaseManifest, agency string, now time.Time) bool {
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

// ── installing ─────────────────────────────────────────────────────────────

// install: the release's programs and online pages, each checked; then kept
// (signed) to hand on, and the office told.
func (u *updater) install(m *releaseManifest, env *envelope, fromCloud bool) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if cur, _ := u.current(); cur != nil && cur.SHA == m.SHA {
		return nil
	}
	if t, ok := u.failed[m.SHA]; ok && time.Since(t) < 10*time.Minute {
		return errors.New("tried a moment ago")
	}
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
	// The pieces of older releases go.
	want := map[string]bool{}
	for _, p := range piecesOf(m) {
		want[p.SHA256] = true
	}
	if es, err := os.ReadDir(u.files()); err == nil {
		for _, e := range es {
			if !want[e.Name()] {
				os.Remove(filepath.Join(u.files(), e.Name()))
			}
		}
	}
	log.Printf("✅ update %s installed on this Companion (programs from the next start)", m.Short)
	go func() {
		// The app itself, to hand on to a main PC of the office (only from the network: no extra download from Supabase).
		if m.SHA256 != "" {
			u.getPiece(m, piece{File: m.File, SHA256: m.SHA256}, false)
		}
	}()
	u.announce()
	return nil
}

func (u *updater) installPieces(m *releaseManifest, fromCloud bool) error {
	for _, p := range m.Programs {
		if !companionPrograms[p.Name] {
			continue
		}
		dest := filepath.Join(u.root, p.Name)
		if _, err := os.Stat(dest); err != nil {
			continue // not on this PC
		}
		got, err := u.getPiece(m, p, fromCloud)
		if err != nil {
			return fmt.Errorf("%s: %w", p.Name, err)
		}
		if fileSHA(dest) == p.SHA256 {
			continue
		}
		// A running program cannot be overwritten, but it can be renamed.
		os.Remove(dest + ".old")
		if err := os.Rename(dest, dest+".old"); err != nil {
			return err
		}
		if err := copyFile(got, dest); err != nil {
			os.Rename(dest+".old", dest)
			return err
		}
		log.Printf("⬆️ %s updated (used from the next start)", p.Name)
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
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
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

func releaseTargets() []*net.UDPAddr {
	out := []*net.UDPAddr{{IP: net.IPv4bcast, Port: releaseUDPPort}}
	if ifs, err := net.Interfaces(); err == nil {
		for _, ifc := range ifs {
			if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
				continue
			}
			addrs, _ := ifc.Addrs()
			for _, a := range addrs {
				n, ok := a.(*net.IPNet)
				if !ok || n.IP.To4() == nil || len(n.Mask) != 4 {
					continue
				}
				ip, b := n.IP.To4(), make(net.IP, 4)
				for i := range b {
					b[i] = ip[i] | ^n.Mask[i]
				}
				out = append(out, &net.UDPAddr{IP: b, Port: releaseUDPPort})
			}
		}
	}
	// Tests and odd networks: extra places to tell (host:port, comma-separated).
	for _, t := range strings.Split(os.Getenv("ADAL_RELEASE_PEERS"), ",") {
		if a, err := net.ResolveUDPAddr("udp4", strings.TrimSpace(t)); err == nil && strings.TrimSpace(t) != "" {
			out = append(out, a)
		}
	}
	return out
}

func (u *updater) announce() {
	m, _ := u.current()
	if m == nil || u.conn == nil {
		return
	}
	msg := []byte(strings.Join([]string{releaseMagic, m.SHA, m.PublishedAt, strconv.Itoa(lanHTTPPort), "/lan"}, "|"))
	for _, t := range releaseTargets() {
		u.conn.WriteToUDP(msg, t)
	}
}

var pathPart = regexp.MustCompile(`^/[\w/-]*$`)

// heard: a peer's release; true when it is newer than the one here.
func (u *updater) heard(text string, from net.IP) (string, bool) {
	parts := strings.Split(strings.TrimSpace(text), "|")
	if len(parts) < 5 || parts[0] != releaseMagic || !regexp.MustCompile(`^[0-9a-f]{7,64}$`).MatchString(parts[1]) || !pathPart.MatchString(parts[4]) {
		return "", false
	}
	port, err := strconv.Atoi(parts[3])
	if err != nil || port < 1 || port > 65535 {
		return "", false
	}
	if port == lanHTTPPort && isOwnIP(from) {
		return "", false // this PC itself
	}
	base := "http://" + net.JoinHostPort(from.String(), parts[3]) + strings.TrimRight(parts[4], "/")
	u.pm.Lock()
	u.peers[base] = peerInfo{SHA: parts[1], PublishedAt: parts[2], At: time.Now()}
	u.pm.Unlock()
	cur, _ := u.current()
	return base, isNewerRelease(parts[1], parts[2], cur)
}

func isOwnIP(ip net.IP) bool {
	if ip.IsLoopback() && os.Getenv("ADAL_RELEASE_PEERS") == "" {
		return true
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) && !ip.IsLoopback() {
			return true
		}
	}
	return false
}

// fromPeer: a newer signed release a PC of the office offers, installed.
func (u *updater) fromPeer(base string) error {
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Get(base + "/latest")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s has no signed release (%d)", base, resp.StatusCode)
	}
	var env envelope
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&env); err != nil {
		return err
	}
	m, err := verifyRelease(env, u.key)
	if err != nil {
		return fmt.Errorf("%s: %w — not installed", base, err)
	}
	cur, _ := u.current()
	if !isNewerRelease(m.SHA, m.PublishedAt, cur) {
		return nil
	}
	u.pm.Lock()
	u.peers[base] = peerInfo{SHA: m.SHA, PublishedAt: m.PublishedAt, At: time.Now()}
	u.pm.Unlock()
	// Staged: its turn comes as on Supabase (a PC of the office that installed it already had its turn).
	agency := ""
	if c := readCloud(u.root); c != nil {
		agency = c.Agency
	}
	if agency != "" && !itsTurn(m, agency, time.Now()) {
		return nil
	}
	log.Printf("🆕 %s offers update %s", base, m.Short)
	return u.install(m, &env, true)
}

// fromCloud: Supabase's newest signed release, when it is newer and its turn has come.
func (u *updater) fromCloud() error {
	m, env, err := u.cloudLatest()
	if err != nil {
		return err
	}
	cur, _ := u.current()
	if !isNewerRelease(m.SHA, m.PublishedAt, cur) {
		return nil
	}
	if c := readCloud(u.root); !itsTurn(m, c.Agency, time.Now()) {
		return nil
	}
	log.Printf("🆕 update %s from Supabase", m.Short)
	return u.install(m, env, true)
}

// serveLAN: the release kept here and its pieces (only those its signed manifest names).
func (u *updater) handler() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/lan/latest", func(w http.ResponseWriter, r *http.Request) {
		_, env := u.current()
		if env == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(env)
	})
	mux.HandleFunc("/lan/file/", func(w http.ResponseWriter, r *http.Request) {
		sha := strings.TrimPrefix(r.URL.Path, "/lan/file/")
		m, _ := u.current()
		ok := false
		if m != nil {
			for _, p := range piecesOf(m) {
				ok = ok || p.SHA256 == sha
			}
		}
		file := u.piecePath(sha)
		if !ok || file == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, file)
	})
	return mux
}

// startSelfUpdate: runs for ever in the background (an employee PC only).
func startSelfUpdate(root string) *updater {
	u := newUpdater(root)
	if ln, err := net.Listen("tcp", fmt.Sprintf(":%d", lanHTTPPort)); err == nil {
		mux := u.handler()
		addReplicaRoutes(mux) // the copy, for a restore on a new main PC (replica.go)
		go http.Serve(ln, mux)
	} else {
		log.Printf("⚠️ update sharing: %v", err)
	}
	if c, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: releaseUDPPort}); err == nil {
		u.conn = c
		go func() {
			buf := make([]byte, 512)
			for {
				n, from, err := c.ReadFromUDP(buf)
				if err != nil {
					return
				}
				if base, newer := u.heard(string(buf[:n]), from.IP); newer {
					go func() {
						if err := u.fromPeer(base); err != nil {
							log.Printf("⚠️ update from %s: %v", base, err)
						}
					}()
				}
			}
		}()
	} else {
		log.Printf("⚠️ update news: %v", err)
	}
	go func() {
		time.Sleep(20 * time.Second)
		for {
			// The main PC first (it answers on the network), then Supabase (the source of truth).
			if hostServer != "" {
				if err := u.fromPeer(strings.TrimRight(hostServer, "/") + "/api/system/update/lan"); err != nil {
					log.Printf("update from the main PC: %v", err)
				}
			}
			if err := u.fromCloud(); err != nil && readCloud(root) != nil {
				log.Printf("update from Supabase: %v", err)
			}
			u.announce()
			time.Sleep(time.Duration(envInt("ADAL_UPDATE_MINUTES", 30)) * time.Minute)
		}
	}()
	return u
}
