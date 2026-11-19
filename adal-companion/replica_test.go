package main

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestScryptMatchesRFC7914(t *testing.T) {
	got := hex.EncodeToString(scryptKey([]byte(""), []byte(""), 16, 1, 1, 64))
	want := "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"
	if got != want {
		t.Fatalf("scrypt(16,1,1)\n got %s\nwant %s", got, want)
	}
	got = hex.EncodeToString(scryptKey([]byte("password"), []byte("NaCl"), 1024, 8, 16, 64))
	want = "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
	if got != want {
		t.Fatalf("scrypt(1024,8,16)\n got %s\nwant %s", got, want)
	}
}

func TestLockRoundTrip(t *testing.T) {
	b, err := lockPiece([]byte("a passport"), "key-123")
	if err != nil {
		t.Fatal(err)
	}
	if string(b[:7]) != "ADALBK1" || len(b) != 51+len("a passport") {
		t.Fatalf("layout: %d bytes", len(b))
	}
	p, err := unlockPiece(b, "key-123")
	if err != nil || string(p) != "a passport" {
		t.Fatalf("unlock: %q %v", p, err)
	}
	if _, err := unlockPiece(b, "wrong"); err == nil {
		t.Fatal("a wrong key opened it")
	}
}

func TestNeighbourTables(t *testing.T) {
	linux := "IP address       HW type     Flags       HW address            Mask     Device\n" +
		"192.168.1.5      0x1         0x2         AA:BB:CC:DD:EE:01     *        wlan0\n" +
		"192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        wlan0\n"
	m := parseProcArp(linux)
	if m["192.168.1.5"] != "aa:bb:cc:dd:ee:01" || len(m) != 1 {
		t.Fatalf("linux: %v", m)
	}
	win := "\nInterface: 192.168.1.20 --- 0x5\n  Internet Address      Physical Address      Type\n" +
		"  192.168.1.1           11-22-33-44-55-66     dynamic\n" +
		"  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n"
	m = parseArpA(win)
	if m["192.168.1.1"] != "11:22:33:44:55:66" || len(m) != 1 {
		t.Fatalf("windows: %v", m)
	}
}

// withTemp: the Companion's files in a throwaway folder.
func withTemp(t *testing.T) string {
	dir := t.TempDir()
	identityPath = func() string { return filepath.Join(dir, "main-pc.json") }
	replicaDirFn = func() string { return filepath.Join(dir, "replica") }
	t.Setenv("ADAL_PC_NUMBER", "")
	t.Cleanup(func() {
		identityPath = defaultIdentityPath
		replicaDirFn = defaultReplicaDir
		neighbourTableFn = neighbourTable
		numberCheck = isMainWithNumber
		acceptServer = serverIsOurs
	})
	return dir
}

func TestMainFoundByItsNetworkCard(t *testing.T) {
	withTemp(t)
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/companion/info":
			fmt.Fprint(w, `{"service":"adal-keep","macs":["aa:bb:cc:dd:ee:01"]}`)
		case "/api/pc-access/check-number":
			b, _ := io.ReadAll(r.Body)
			fmt.Fprintf(w, `{"ok":%v}`, strings.Contains(string(b), "47040"))
		}
	}))
	defer main.Close()
	host, port := hostPort(main.URL)
	saveIdentity(mainIdentity{Number: "47040", Macs: []string{"aa:bb:cc:dd:ee:01"}, URL: "http://192.168.1.77:" + fmt.Sprint(port)})
	// The router moved it: the card now has another address.
	neighbourTableFn = func() map[string]string {
		return map[string]string{"10.9.9.9": "11:11:11:11:11:11", host: "aa:bb:cc:dd:ee:01"}
	}
	if got := findByMAC(); got != main.URL {
		t.Fatalf("found %q, want %q", got, main.URL)
	}
	// Another main PC with that card (or a number it does not have): never taken.
	saveIdentity(mainIdentity{Number: "11111", Macs: []string{"aa:bb:cc:dd:ee:01"}, URL: main.URL})
	if got := findByMAC(); got != "" {
		t.Fatalf("took a main PC without our number: %q", got)
	}
	// The number typed when joining wins over the file.
	t.Setenv("ADAL_PC_NUMBER", "47040")
	if got := findByMAC(); got != main.URL {
		t.Fatalf("with the number from companion.conf: %q", got)
	}
	if n := numberInConf("# x\r\nADAL_HOST_URL=http://a:4000\r\nADAL_PC_NUMBER= 47040\r\n"); n != "47040" {
		t.Fatalf("conf number %q", n)
	}
}

// fakeMain: a main PC with a database of 3 chunks and 2 documents, every piece locked.
type fakeMain struct {
	mu       sync.Mutex
	chunks   [][]byte
	docs     map[string][]byte
	asked    map[string]int
	reports  []map[string]any
	password string
}

func (f *fakeMain) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.asked[r.URL.Path]++
		if r.URL.Path == "/api/pc-access/number" {
			fmt.Fprint(w, `{"ok":true,"key":"k1"}`)
			return
		}
		if r.Header.Get("x-adal-pc") != "k1" {
			http.Error(w, `{"error":"no"}`, 401)
			return
		}
		switch {
		case r.URL.Path == "/api/replica/keys":
			fmt.Fprintf(w, `{"password":%q,"bot_token":"BOT","chat_id":"-100","vault_key":"VK","secrets":{"a":"b"},"chat_account":null}`, f.password)
		case r.URL.Path == "/api/replica/manifest":
			var sums []string
			for i, c := range f.chunks {
				sums = append(sums, fmt.Sprintf("%x", len(c)+i*7+int(c[0])))
			}
			var docs []map[string]any
			for n, b := range f.docs {
				docs = append(docs, map[string]any{"name": n, "size": len(b), "sum": fmt.Sprintf("%x", len(b)), "parts": 1})
			}
			json.NewEncoder(w).Encode(map[string]any{"v": 1, "pc_number": "47040", "made": "2026-11-19T07:00:00Z", "snap": "s1",
				"db": map[string]any{"length": len(f.chunks) * 4, "chunk": 4, "z": "", "chunks": sums}, "docs": docs,
				"backup": map[string]any{"last_good_at": "2026-11-18T07:00:00Z"}})
		case strings.HasPrefix(r.URL.Path, "/api/replica/db/s1/"):
			var i int
			fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/api/replica/db/s1/"), "%d", &i)
			b, _ := lockPiece(f.chunks[i], f.password)
			w.Write(b)
		case strings.HasPrefix(r.URL.Path, "/api/replica/doc/"):
			b, _ := lockPiece(f.docs[r.URL.Query().Get("name")], f.password)
			w.Write(b)
		case r.URL.Path == "/api/replica/report":
			var m map[string]any
			json.NewDecoder(r.Body).Decode(&m)
			f.reports = append(f.reports, m)
			fmt.Fprint(w, `{"ok":true}`)
		default:
			http.NotFound(w, r)
		}
	})
}

func TestCopyBackupAndRestoreFromIt(t *testing.T) {
	withTemp(t)
	t.Setenv("ADAL_PC_NUMBER", "47040")
	f := &fakeMain{chunks: [][]byte{[]byte("SQLi"), []byte("te f"), []byte("ile!")}, docs: map[string][]byte{"passport.jpg": []byte("a passport"), "cv.pdf": []byte("a cv")}, asked: map[string]int{}, password: "key-123"}
	main := httptest.NewServer(f.handler(t))
	defer main.Close()
	hostServer, clientName = main.URL, "Reception"
	defer func() { hostServer = "" }()

	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	st := loadState()
	if st.Made == "" || len(st.DB.Chunks) != 3 || len(st.Docs) != 2 || st.PCNumber != "47040" {
		t.Fatalf("state: %+v", st)
	}
	// Locked at rest: no piece holds the plain bytes.
	for _, n := range st.pieceNames() {
		b, _ := os.ReadFile(filepath.Join(piecesDir(), n))
		if !bytes.HasPrefix(b, []byte("ADALBK1")) || bytes.Contains(b, []byte("passport")) {
			t.Fatalf("%s is not locked", n)
		}
	}
	// Again: nothing is fetched twice; only a changed chunk.
	before := f.asked["/api/replica/db/s1/0"] + f.asked["/api/replica/db/s1/1"]
	f.chunks[2] = []byte("ILE?")
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	if f.asked["/api/replica/db/s1/0"]+f.asked["/api/replica/db/s1/1"] != before || f.asked["/api/replica/db/s1/2"] != 2 {
		t.Fatalf("fetched again: %v", f.asked)
	}
	if n, _ := os.ReadDir(piecesDir()); len(n) != 5 {
		t.Fatalf("old pieces left: %d", len(n))
	}
	if len(f.reports) != 2 || f.reports[1]["made"] != "2026-11-19T07:00:00Z" {
		t.Fatalf("reports: %v", f.reports)
	}

	// The main PC goes off: due only after a while, and only for a copy newer than the newest backup.
	st, keys := loadState(), loadKeys()
	now := time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)
	if companionBackupDue(st, keys, now, now.Add(-5*time.Minute), 0) {
		t.Fatal("due 5 minutes after the main PC went off")
	}
	if !companionBackupDue(st, keys, now, now.Add(-40*time.Minute), 0) {
		t.Fatal("not due 40 minutes after")
	}

	// Telegram, faked.
	var tgMu sync.Mutex
	tg := map[string][]byte{}
	tgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/botBOT/sendDocument") {
			http.NotFound(w, r)
			return
		}
		mr, _ := r.MultipartReader()
		var data []byte
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			if p.FormName() == "document" {
				data, _ = io.ReadAll(p)
			}
		}
		tgMu.Lock()
		id := fmt.Sprintf("tg%d", len(tg))
		tg[id] = data
		tgMu.Unlock()
		fmt.Fprintf(w, `{"ok":true,"result":{"document":{"file_id":%q}}}`, id)
	}))
	defer tgSrv.Close()
	telegramAPI = tgSrv.URL
	defer func() { telegramAPI = "https://api.telegram.org" }()

	if err := backupFromCopy(); err != nil {
		t.Fatal(err)
	}
	st = loadState()
	if st.OwnIndexID == "" || len(tg) != 6 {
		t.Fatalf("sent %d, index %q", len(tg), st.OwnIndexID)
	}
	if companionBackupDue(st, keys, now, now.Add(-40*time.Minute), 0) {
		t.Fatal("the same copy backed up twice")
	}
	idx := openIndex(t, tg[st.OwnIndexID], "key-123")
	sets := idx["sets"].([]any)
	db := sets[0].(map[string]any)
	if db["type"] != "rdb" || len(db["parts"].([]any)) != 3 || idx["vault_key"] != "VK" {
		t.Fatalf("index: %v", idx)
	}
	// Each database piece in Telegram opens with the key into its chunk.
	var whole []byte
	for _, id := range db["parts"].([]any) {
		p, err := unlockPiece(tg[id.(string)], "key-123")
		if err != nil {
			t.Fatal(err)
		}
		whole = append(whole, p...)
	}
	if string(whole) != "SQLite fILE?" {
		t.Fatalf("database back: %q", whole)
	}
	// A second run sends only the index.
	st.OwnBackupCopy = ""
	saveState(st)
	if err := backupFromCopy(); err != nil || len(tg) != 7 {
		t.Fatalf("second run: %v, %d", err, len(tg))
	}

	// The main PC is back: it is told of the backup made here, once.
	if err := syncReplica(); err != nil {
		t.Fatal(err)
	}
	last := f.reports[len(f.reports)-1]
	if last["backup_at"] == nil || last["index_file_id"] != loadState().OwnIndexID {
		t.Fatalf("not told: %v", last)
	}
	if loadState().Reported == "" {
		t.Fatal("not marked as told")
	}

	// A new main PC restores from the copy over the office network.
	mux := http.NewServeMux()
	addReplicaRoutes(mux)
	lan := httptest.NewServer(mux)
	defer lan.Close()
	get := func(path, number string) (int, []byte) {
		req, _ := http.NewRequest("GET", lan.URL+path, nil)
		req.Header.Set("x-adal-number", number)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	if code, _ := get("/replica/index", "99999"); code != 403 {
		t.Fatalf("another number got the index: %d", code)
	}
	code, b := get("/replica/index", "47040")
	if code != 200 {
		t.Fatalf("index: %d %s", code, b)
	}
	idx = openIndex(t, b, "key-123")
	first := idx["sets"].([]any)[0].(map[string]any)["parts"].([]any)[0].(string)
	if !strings.HasPrefix(first, "rp:") {
		t.Fatalf("part %q", first)
	}
	code, piece := get("/replica/piece/"+strings.TrimPrefix(first, "rp:"), "47040")
	if p, err := unlockPiece(piece, "key-123"); code != 200 || err != nil || string(p) != "SQLi" {
		t.Fatalf("piece: %d %q %v", code, p, err)
	}
	if code, _ := get("/replica/piece/..%2fstate.json", "47040"); code != 404 {
		t.Fatalf("a path trick got %d", code)
	}
}

func openIndex(t *testing.T, locked []byte, pw string) map[string]any {
	t.Helper()
	gz, err := unlockPiece(locked, pw)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	var m map[string]any
	if err := json.Unmarshal(plain, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// The main PC (Node) opens what the Companion locks, and the other way round.
func TestLockMatchesNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node here")
	}
	dir := t.TempDir()
	mine, _ := lockPiece([]byte("from go"), "pw-1")
	os.WriteFile(filepath.Join(dir, "go.bin"), mine, 0o600)
	script := `const c=require('crypto'),fs=require('fs');const d=process.argv[1];
const b=fs.readFileSync(d+'/go.bin');const k=c.scryptSync('pw-1',b.subarray(7,23),32);
const x=c.createDecipheriv('aes-256-gcm',k,b.subarray(23,35));x.setAuthTag(b.subarray(35,51));
process.stdout.write(Buffer.concat([x.update(b.subarray(51)),x.final()]).toString());
const s=c.randomBytes(16),iv=c.randomBytes(12),e=c.createCipheriv('aes-256-gcm',c.scryptSync('pw-1',s,32),iv);
const ct=Buffer.concat([e.update('from node'),e.final()]);fs.writeFileSync(d+'/node.bin',Buffer.concat([Buffer.from('ADALBK1'),s,iv,e.getAuthTag(),ct]))`
	out, err := exec.Command(node, "-e", script, dir).CombinedOutput()
	if err != nil || string(out) != "from go" {
		t.Fatalf("node could not open it: %s %v", out, err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "node.bin"))
	if p, err := unlockPiece(b, "pw-1"); err != nil || string(p) != "from node" {
		t.Fatalf("go could not open node's: %q %v", p, err)
	}
}
