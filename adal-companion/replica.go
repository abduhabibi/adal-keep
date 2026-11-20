package main

// replica.go — this Companion keeps a locked copy of the agency's data.
//
// While the main PC answers, every 15 minutes the Companion asks it for a
// manifest (backend services/replica.js): the database cut in 1 MB chunks,
// each with a fingerprint, and the documents by name, size and time. Only the
// chunks and documents it does not have yet are fetched — after the first
// copy, usually a few chunks. Every piece comes LOCKED with the agency's
// backup key (the same lock as the Telegram backup) and is kept as it came:
// the copy is locked at rest. The key itself is kept locked with Windows'
// own protection for this user (protect_windows.go).
//
// When the main PC is off or dead and the copy is newer than the newest good
// backup, the Companion backs the agency up from its copy: the same locked
// pieces go to the agency's Telegram channel with an index (the main PC's
// restore reads it: sets "rdb" and "rfile"), and it tells the main PC when
// it is back. A new main PC can also be restored from the copy over the
// office network (/replica/index and /replica/piece/ on port 47810, asked
// with the old main PC's number; every piece is still locked).

import (
	"bytes"
	"compress/gzip"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	replicaDirFn   = defaultReplicaDir
	telegramAPI    = strings.TrimRight(envStr("ADAL_TELEGRAM_API", "https://api.telegram.org"), "/")
	replicaMu      sync.Mutex // one sync or backup at a time
	replicaClient  = &http.Client{Timeout: 3 * time.Minute}
	syncEvery      = time.Duration(envInt("ADAL_REPLICA_MINUTES", 15)) * time.Minute
	piecePattern   = regexp.MustCompile(`^[df]-[0-9a-f]{1,40}-[0-9a-f]{1,40}(-[0-9]{1,6})?\.bin$`)
	errNoNumber    = errors.New("the main PC's number is not known yet (it is saved when this PC joins with it)")
	errNotOurMain  = errors.New("that main PC does not have our number")
	wrongNumbersMu sync.Mutex
	wrongNumbers   = map[string][]time.Time{}
)

const (
	backupGapAfterMainOff = 30 * time.Minute // the main PC off this long before a Companion backs up
)

func envStr(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func defaultReplicaDir() string {
	if v := os.Getenv("ADAL_REPLICA_DIR"); v != "" {
		return v
	}
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "replica")
	}
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "adal-companion-replica")
}

func piecesDir() string { return filepath.Join(replicaDirFn(), "pieces") }

// ── What the copy is ────────────────────────────────────────────────────────

type rpDB struct {
	Length int64    `json:"length"`
	Chunk  int64    `json:"chunk"`
	Z      string   `json:"z"`
	Chunks []string `json:"chunks"`
}

type rpDoc struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Sum   string `json:"sum"`
	Parts int    `json:"parts"`
}

type replicaState struct {
	PCNumber      string            `json:"pc_number,omitempty"`
	Made          string            `json:"made,omitempty"` // when the main PC made the snapshot this copy is
	SyncedAt      string            `json:"synced_at,omitempty"`
	DB            rpDB              `json:"db"`
	Docs          []rpDoc           `json:"docs"`
	MainLastGood  string            `json:"main_last_good,omitempty"` // the newest good backup, as the main PC said
	Sent          map[string]string `json:"sent,omitempty"`           // piece → Telegram file id
	OwnBackupAt   string            `json:"own_backup_at,omitempty"`
	OwnBackupCopy string            `json:"own_backup_copy,omitempty"` // the copy (Made) that backup carried
	OwnIndexID    string            `json:"own_index_id,omitempty"`
	Reported      string            `json:"reported,omitempty"` // own backup the main PC was told of
}

type replicaKeys struct {
	AccessKey   string          `json:"access_key,omitempty"`
	Password    string          `json:"password,omitempty"`
	BotToken    string          `json:"bot_token,omitempty"`
	ChatID      string          `json:"chat_id,omitempty"`
	VaultKey    string          `json:"vault_key,omitempty"`
	Secrets     json.RawMessage `json:"secrets,omitempty"`
	ChatAccount json.RawMessage `json:"chat_account,omitempty"`
	KeysAt      string          `json:"keys_at,omitempty"`
}

func loadState() replicaState {
	var st replicaState
	if b, err := os.ReadFile(filepath.Join(replicaDirFn(), "state.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Sent == nil {
		st.Sent = map[string]string{}
	}
	return st
}

func saveState(st replicaState) error {
	if err := os.MkdirAll(replicaDirFn(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", " ")
	return writeAtomic(filepath.Join(replicaDirFn(), "state.json"), b, 0o600)
}

func loadKeys() replicaKeys {
	var k replicaKeys
	b, err := os.ReadFile(filepath.Join(replicaDirFn(), "keys.bin"))
	if err != nil {
		return k
	}
	plain, err := unprotect(b)
	if err == nil {
		_ = json.Unmarshal(plain, &k)
	}
	return k
}

func saveKeys(k replicaKeys) error {
	if err := os.MkdirAll(replicaDirFn(), 0o700); err != nil {
		return err
	}
	plain, _ := json.Marshal(k)
	sealed, err := protect(plain)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(replicaDirFn(), "keys.bin"), sealed, 0o600)
}

func writeAtomic(p string, b []byte, mode os.FileMode) error {
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func dbPieceName(i int, sum string) string { return fmt.Sprintf("d-%x-%s.bin", i, sum) }

func docID(name string) string {
	h := sha1.Sum([]byte(name))
	return hex.EncodeToString(h[:8])
}

func docPieceName(d rpDoc, k int) string {
	return fmt.Sprintf("f-%s-%s-%d.bin", docID(d.Name), d.Sum, k)
}

func pieceExists(name string) bool {
	st, err := os.Stat(filepath.Join(piecesDir(), name))
	return err == nil && st.Size() > 0
}

// pieceNames: every piece of the copy, in the order a restore reads them.
func (st replicaState) pieceNames() []string {
	var out []string
	for i, s := range st.DB.Chunks {
		out = append(out, dbPieceName(i, s))
	}
	for _, d := range st.Docs {
		for k := 0; k < d.Parts; k++ {
			out = append(out, docPieceName(d, k))
		}
	}
	return out
}

// ── Talking to the main PC ──────────────────────────────────────────────────

func mainRequest(method, path string, body io.Reader, key string) (*http.Response, error) {
	if hostServer == "" {
		return nil, errors.New("no main PC")
	}
	req, err := http.NewRequest(method, strings.TrimRight(hostServer, "/")+path, body)
	if err != nil {
		return nil, err
	}
	if key != "" {
		req.Header.Set("x-adal-pc", key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return replicaClient.Do(req)
}

func mainJSON(method, path string, in any, key string, out any) (int, error) {
	var body io.Reader
	if in != nil {
		b, _ := json.Marshal(in)
		body = bytes.NewReader(b)
	}
	resp, err := mainRequest(method, path, body, key)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return resp.StatusCode, fmt.Errorf("the main PC answered %d: %s", resp.StatusCode, e.Error)
	}
	if out != nil {
		return resp.StatusCode, json.Unmarshal(b, out)
	}
	return resp.StatusCode, nil
}

// fetchPiece: one locked piece from the main PC, onto the disk as it came.
func fetchPiece(path, key, name string) (int64, error) {
	resp, err := mainRequest(http.MethodGet, path, nil, key)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return 0, fmt.Errorf("the main PC answered %d for %s", resp.StatusCode, path)
	}
	if err := os.MkdirAll(piecesDir(), 0o700); err != nil {
		return 0, err
	}
	tmp := filepath.Join(piecesDir(), name+".tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, 64<<20))
	f.Close()
	if err == nil && (n < 51 || !lockedFile(tmp)) {
		err = fmt.Errorf("%s did not come locked", path)
	}
	if err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return n, os.Rename(tmp, filepath.Join(piecesDir(), name))
}

func lockedFile(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 7)
	_, err = io.ReadFull(f, head)
	return err == nil && bytes.Equal(head, lockMagic)
}

// joinWithNumber: this Companion's own key on the main PC, given for its number.
func joinWithNumber(number string) (string, error) {
	var r struct {
		Key string `json:"key"`
	}
	code, err := mainJSON(http.MethodPost, "/api/pc-access/number", map[string]string{"number": number, "name": "Adal Companion copy · " + clientName}, "", &r)
	if code == http.StatusForbidden {
		return "", errNotOurMain
	}
	if err != nil {
		return "", err
	}
	if r.Key == "" {
		return "", errors.New("the main PC gave no key")
	}
	return r.Key, nil
}

type rpManifest struct {
	V        int     `json:"v"`
	PCNumber string  `json:"pc_number"`
	Made     string  `json:"made"`
	Snap     string  `json:"snap"`
	DB       rpDB    `json:"db"`
	Docs     []rpDoc `json:"docs"`
	Backup   struct {
		LastGoodAt string `json:"last_good_at"`
	} `json:"backup"`
}

// syncReplica brings the copy up to the main PC's newest snapshot.
func syncReplica() error {
	if !replicaMu.TryLock() {
		return nil
	}
	defer replicaMu.Unlock()
	number := mainNumber()
	if number == "" {
		number = learnNumberOnline(exeRoot())
	}
	if number == "" {
		return errNoNumber
	}
	keys := loadKeys()
	if keys.AccessKey == "" {
		k, err := joinWithNumber(number)
		if err != nil {
			return err
		}
		keys.AccessKey = k
		if err := saveKeys(keys); err != nil {
			return err
		}
	}
	// The backup key and channel: once, then once a day (a new key, a new channel).
	if keys.Password == "" || time.Since(parseTime(keys.KeysAt)) > 24*time.Hour {
		var k replicaKeys
		code, err := mainJSON(http.MethodGet, "/api/replica/keys", nil, keys.AccessKey, &k)
		if code == http.StatusUnauthorized || code == http.StatusForbidden {
			keys.AccessKey = "" // removed or suspended on the main PC: asked again next time
			_ = saveKeys(keys)
		}
		if err != nil {
			return err
		}
		k.AccessKey, k.KeysAt = keys.AccessKey, time.Now().UTC().Format(time.RFC3339)
		keys = k
		if err := saveKeys(keys); err != nil {
			return err
		}
	}
	var m rpManifest
	if code, err := mainJSON(http.MethodGet, "/api/replica/manifest", nil, keys.AccessKey, &m); err != nil {
		if code == http.StatusUnauthorized || code == http.StatusForbidden {
			keys.AccessKey = ""
			_ = saveKeys(keys)
		}
		return err
	}
	if m.Snap == "" || m.DB.Chunk <= 0 {
		return errors.New("the main PC sent no copy")
	}
	st := loadState()
	if st.PCNumber != "" && m.PCNumber != "" && st.PCNumber != m.PCNumber {
		log.Printf("🗄 The main PC changed (%s → %s): a new copy is made", st.PCNumber, m.PCNumber)
		st = replicaState{Sent: map[string]string{}}
		os.RemoveAll(piecesDir())
	}
	var got, bytesGot int64
	bases := peerBases() // the other Companions: a piece they have is not asked of the main PC
	fromPeers := 0
	for i, sum := range m.DB.Chunks {
		name := dbPieceName(i, sum)
		if pieceExists(name) {
			continue
		}
		if pieceFromPeers(name, bases) {
			got++
			fromPeers++
			continue
		}
		n, err := fetchPiece(fmt.Sprintf("/api/replica/db/%s/%d", url.PathEscape(m.Snap), i), keys.AccessKey, name)
		if err != nil {
			return err
		}
		got++
		bytesGot += n
	}
	for _, d := range m.Docs {
		for k := 0; k < d.Parts; k++ {
			name := docPieceName(d, k)
			if pieceExists(name) {
				continue
			}
			if pieceFromPeers(name, bases) {
				got++
				fromPeers++
				continue
			}
			n, err := fetchPiece(fmt.Sprintf("/api/replica/doc/%d?name=%s", k, url.QueryEscape(d.Name)), keys.AccessKey, name)
			if err != nil {
				// A document deleted meanwhile: the next sync's manifest has it gone.
				if strings.Contains(err.Error(), "answered 404") {
					continue
				}
				return err
			}
			got++
			bytesGot += n
		}
	}
	// Documents that could not be fetched (deleted meanwhile) are left out of the copy.
	var docs []rpDoc
	for _, d := range m.Docs {
		ok := true
		for k := 0; k < d.Parts; k++ {
			ok = ok && pieceExists(docPieceName(d, k))
		}
		if ok {
			docs = append(docs, d)
		}
	}
	st.PCNumber, st.Made, st.DB, st.Docs = m.PCNumber, m.Made, m.DB, docs
	st.SyncedAt = time.Now().UTC().Format(time.RFC3339)
	if m.Backup.LastGoodAt != "" {
		st.MainLastGood = m.Backup.LastGoodAt
	}
	pruneReplica(st)
	if err := saveState(st); err != nil {
		return err
	}
	if got > 0 {
		log.Printf("🗄 Copy of the main PC brought up to date: %d new piece(s) (%d from other Companions), %d KB from the main PC (%d documents)", got, fromPeers, bytesGot/1024, len(docs))
	}
	reportToMain(st, keys)
	return nil
}

// pruneReplica removes the pieces no longer part of the copy.
func pruneReplica(st replicaState) {
	want := map[string]bool{}
	for _, n := range st.pieceNames() {
		want[n] = true
	}
	entries, _ := os.ReadDir(piecesDir())
	for _, e := range entries {
		if !want[e.Name()] {
			os.Remove(filepath.Join(piecesDir(), e.Name()))
		}
	}
	for n := range st.Sent {
		if !want[n] {
			delete(st.Sent, n)
		}
	}
}

// reportToMain: how the copy stands, and a backup made from it while the main PC was off.
func reportToMain(st replicaState, keys replicaKeys) {
	if keys.AccessKey == "" {
		return
	}
	var size int64
	entries, _ := os.ReadDir(piecesDir())
	for _, e := range entries {
		if fi, err := e.Info(); err == nil {
			size += fi.Size()
		}
	}
	body := map[string]any{"name": clientName, "port": lanHTTPPort, "made": st.Made, "synced_at": st.SyncedAt, "bytes": size, "docs": len(st.Docs)}
	if st.OwnBackupAt != "" && st.Reported != st.OwnBackupAt {
		body["backup_at"], body["index_file_id"] = st.OwnBackupAt, st.OwnIndexID
	}
	if _, err := mainJSON(http.MethodPost, "/api/replica/report", body, keys.AccessKey, nil); err == nil && body["backup_at"] != nil {
		log.Printf("🗄 The main PC knows of the backup made here at %s", st.OwnBackupAt)
		st.Reported = st.OwnBackupAt
		_ = saveState(st)
	}
}

// ── Backing up from the copy (the main PC is off) ───────────────────────────

// companionBackupDue: the main PC has been off a while, and the copy here holds
// newer data than the newest good backup (the main PC's, or one made here).
func companionBackupDue(st replicaState, keys replicaKeys, now, mainOffSince time.Time, jitter time.Duration) bool {
	if st.Made == "" || len(st.DB.Chunks) == 0 || keys.Password == "" || keys.BotToken == "" || keys.ChatID == "" {
		return false
	}
	if mainOffSince.IsZero() || now.Sub(mainOffSince) < backupGapAfterMainOff+jitter {
		return false
	}
	if st.OwnBackupCopy == st.Made {
		return false // this very copy is backed up already
	}
	made := parseTime(st.Made)
	last := parseTime(st.MainLastGood)
	if own := parseTime(st.OwnBackupAt); own.After(last) {
		last = own
	}
	return made.After(last)
}

type tgAnswer struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	ErrorCode   int    `json:"error_code"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
	Result struct {
		Document struct {
			FileID string `json:"file_id"`
		} `json:"document"`
	} `json:"result"`
}

// tgSendDocument: one file to the agency's channel; its Telegram file id.
func tgSendDocument(token, chat string, data []byte, filename, caption string) (string, error) {
	for try := 0; ; try++ {
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		_ = w.WriteField("chat_id", chat)
		if len(caption) > 1000 {
			caption = caption[:1000]
		}
		_ = w.WriteField("caption", caption)
		_ = w.WriteField("disable_notification", "true")
		fw, _ := w.CreateFormFile("document", filename)
		fw.Write(data)
		w.Close()
		resp, err := replicaClient.Post(telegramAPI+"/bot"+token+"/sendDocument", w.FormDataContentType(), &buf)
		if err != nil {
			if try < 3 {
				time.Sleep(time.Duration(5*(try+1)) * time.Second)
				continue
			}
			return "", fmt.Errorf("no connection to Telegram (%v)", err)
		}
		var a tgAnswer
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&a)
		resp.Body.Close()
		if a.ErrorCode == 429 && try < 6 {
			time.Sleep(time.Duration(a.Parameters.RetryAfter+1) * time.Second)
			continue
		}
		if !a.OK || a.Result.Document.FileID == "" {
			return "", fmt.Errorf("Telegram: %s", a.Description)
		}
		return a.Result.Document.FileID, nil
	}
}

// replicaIndex: the backup index of the copy (as the main PC's restore reads
// it), with each piece named by idOf. Not locked yet.
func replicaIndex(st replicaState, keys replicaKeys, idOf func(string) string, by string) ([]byte, error) {
	type set map[string]any
	var sets []set
	var parts []string
	for i, s := range st.DB.Chunks {
		parts = append(parts, idOf(dbPieceName(i, s)))
	}
	sets = append(sets, set{"type": "rdb", "date": st.Made, "length": st.DB.Length, "chunk": st.DB.Chunk, "z": st.DB.Z, "parts": parts})
	for _, d := range st.Docs {
		var p []string
		for k := 0; k < d.Parts; k++ {
			p = append(p, idOf(docPieceName(d, k)))
		}
		sets = append(sets, set{"type": "rfile", "date": st.Made, "name": d.Name, "size": d.Size, "parts": p})
	}
	idx := map[string]any{"adal_backup": 1, "made": time.Now().UTC().Format(time.RFC3339), "copy_made": st.Made, "by": by, "sets": sets}
	if keys.VaultKey != "" {
		idx["vault_key"] = keys.VaultKey
	}
	if len(keys.Secrets) > 0 {
		idx["secrets"] = keys.Secrets
	}
	if len(keys.ChatAccount) > 0 {
		idx["chat_account"] = keys.ChatAccount
	}
	plain, err := json.Marshal(idx)
	if err != nil {
		return nil, err
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(plain)
	zw.Close()
	return gz.Bytes(), nil
}

// backupFromCopy sends the copy's pieces not sent yet, then a new index.
func backupFromCopy() error {
	if !replicaMu.TryLock() {
		return nil
	}
	defer replicaMu.Unlock()
	st, keys := loadState(), loadKeys()
	if st.Made == "" || keys.Password == "" || keys.BotToken == "" || keys.ChatID == "" {
		return errors.New("no copy or no backup key here yet")
	}
	log.Printf("💾 The main PC is off: backing the agency up from the copy here (made %s)", st.Made)
	names := st.pieceNames()
	sent := 0
	for i, n := range names {
		if st.Sent[n] != "" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(piecesDir(), n))
		if err != nil {
			return err
		}
		fid, err := tgSendDocument(keys.BotToken, keys.ChatID, b, "adal-copy-"+n, fmt.Sprintf("Adal Keep backup (from %s's copy) · %d/%d", clientName, i+1, len(names)))
		if err != nil {
			_ = saveState(st)
			return err
		}
		st.Sent[n] = fid
		if sent++; sent%10 == 0 {
			_ = saveState(st)
		}
	}
	idx, err := replicaIndex(st, keys, func(n string) string { return st.Sent[n] }, "Companion "+clientName)
	if err != nil {
		return err
	}
	locked, err := lockPiece(idx, keys.Password)
	if err != nil {
		return err
	}
	fid, err := tgSendDocument(keys.BotToken, keys.ChatID, locked, "adal-backup-index.enc",
		fmt.Sprintf("🗂 Adal Keep backup index · from %s's copy (the main PC was off) · copy of %s · keep the NEWEST one — it is what a restore needs", clientName, st.Made))
	if err != nil {
		_ = saveState(st)
		return err
	}
	st.OwnBackupAt, st.OwnBackupCopy, st.OwnIndexID = time.Now().UTC().Format(time.RFC3339), st.Made, fid
	if err := saveState(st); err != nil {
		return err
	}
	log.Printf("💾 Backed up from the copy here: %d new piece(s) and the index", sent)
	return nil
}

// ── The copy on the office network (a restore on a new main PC) ────────────

// numberOK: the old main PC's number, at most 10 wrong ones per address in 10 minutes.
func numberOK(r *http.Request, st replicaState) bool {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	wrongNumbersMu.Lock()
	defer wrongNumbersMu.Unlock()
	var recent []time.Time
	for _, t := range wrongNumbers[ip] {
		if time.Since(t) < 10*time.Minute {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 10 {
		return false
	}
	n := cleanPCNumber(r.Header.Get("x-adal-number"))
	if n != "" && (n == st.PCNumber || n == loadIdentity().Number) {
		delete(wrongNumbers, ip)
		return true
	}
	wrongNumbers[ip] = append(recent, time.Now())
	return false
}

func addReplicaRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/replica/info", func(w http.ResponseWriter, r *http.Request) {
		st := loadState()
		if !numberOK(r, st) {
			http.Error(w, "not this main PC's number", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"made": st.Made, "synced_at": st.SyncedAt, "database": st.DB.Length, "documents": len(st.Docs), "name": clientName})
	})
	mux.HandleFunc("/replica/index", func(w http.ResponseWriter, r *http.Request) {
		replicaMu.Lock()
		defer replicaMu.Unlock()
		st, keys := loadState(), loadKeys()
		if !numberOK(r, st) {
			http.Error(w, "not this main PC's number", http.StatusForbidden)
			return
		}
		if st.Made == "" || keys.Password == "" {
			http.Error(w, "no copy here yet", http.StatusNotFound)
			return
		}
		idx, err := replicaIndex(st, keys, func(n string) string { return "rp:" + n }, "Companion "+clientName+" (office network)")
		if err == nil {
			var locked []byte
			if locked, err = lockPiece(idx, keys.Password); err == nil {
				log.Printf("🗄 %s takes the copy here (a restore)", r.RemoteAddr)
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Write(locked)
				return
			}
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
	})
	mux.HandleFunc("/replica/piece/", func(w http.ResponseWriter, r *http.Request) {
		st := loadState()
		if !numberOK(r, st) {
			http.Error(w, "not this main PC's number", http.StatusForbidden)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/replica/piece/")
		if !piecePattern.MatchString(name) || !pieceExists(name) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, filepath.Join(piecesDir(), name))
	})
}

// ── Running it ──────────────────────────────────────────────────────────────

// replicaJitter: Companions of one office do not all back up at the same minute.
func replicaJitter() time.Duration {
	h := fnv.New32a()
	h.Write([]byte(clientName))
	return time.Duration(h.Sum32()%20) * time.Minute
}

// watchReplica keeps the copy and backs up from it while the main PC is off.
func watchReplica() {
	if os.Getenv("ADAL_REPLICA") == "0" {
		return
	}
	go func() {
		time.Sleep(90 * time.Second) // let the PC finish starting first
		var lastSync time.Time
		var mainOffSince time.Time
		saidNoNumber := false
		for {
			switch {
			case signedOut():
			case hostServer != "" && pingServer() && !serverLocked():
				mainOffSince = time.Time{}
				if time.Since(lastSync) >= syncEvery {
					lastSync = time.Now()
					if err := syncReplica(); err != nil {
						if err == errNoNumber {
							if !saidNoNumber {
								log.Printf("🗄 No copy kept here yet: %v", err)
								saidNoNumber = true
							}
						} else {
							log.Printf("⚠️ Copy of the main PC: %v", err)
						}
					}
				}
			default:
				if mainOffSince.IsZero() {
					mainOffSince = time.Now()
				}
				// The main PC away: a newer copy another Companion has (peers.go).
				if time.Since(lastSync) >= syncEvery {
					lastSync = time.Now()
					if err := syncFromPeers(); err != nil && err != errNoNumber {
						log.Printf("⚠️ Copy from another Companion: %v", err)
					}
				}
				if companionBackupDue(loadState(), loadKeys(), time.Now(), mainOffSince, replicaJitter()) {
					if err := backupFromCopy(); err != nil {
						log.Printf("⚠️ Backup from the copy: %v (tried again later)", err)
						mainOffSince = time.Now() // not every minute
					}
				}
			}
			time.Sleep(time.Minute)
		}
	}()
}
