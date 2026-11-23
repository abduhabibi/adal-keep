package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// presenceTest: a clean map, our agency 47040, this PC's id, loopback counted as the office.
func presenceTest(t *testing.T) {
	t.Helper()
	t.Setenv("ADAL_PC_NUMBER", "47040")
	oldTag, oldOK, oldSw, oldAccept, oldID, oldHost := ownAgencyTag, presenceAddrOK, presenceSwitch, acceptServer, identityPath, hostServer
	ownAgencyTag = func() string { return agencyTag("47040") }
	presenceAddrOK = func(ip net.IP) bool { return ip.To4() != nil }
	acceptServer = func(string) bool { return true }
	idp := filepath.Join(t.TempDir(), "main-pc.json")
	identityPath = func() string { return idp }
	myPCID = "aaaaaaaaaaaa"
	presenceMu.Lock()
	presenceMap = map[string]presenceEntry{}
	presenceMu.Unlock()
	t.Cleanup(func() {
		ownAgencyTag, presenceAddrOK, presenceSwitch, acceptServer, identityPath, hostServer = oldTag, oldOK, oldSw, oldAccept, oldID, oldHost
		myPCID = ""
	})
}

func TestPCIDMadeOnceAndNeverAgain(t *testing.T) {
	root := t.TempDir()
	id := ensurePCID(root)
	if !ownIDRe.MatchString(id) {
		t.Fatalf("id %q", id)
	}
	for i := 0; i < 3; i++ {
		if again := ensurePCID(root); again != id {
			t.Fatalf("id made again: %s → %s", id, again)
		}
	}
	// The file lost or damaged (an antivirus, a cut power): the copy brings the same id back.
	os.WriteFile(filepath.Join(root, "companion-id"), []byte("garbage!"), 0o644)
	if again := ensurePCID(root); again != id {
		t.Fatalf("damaged file: %s → %s", id, again)
	}
	os.Remove(filepath.Join(root, "companion-id"))
	if again := ensurePCID(root); again != id {
		t.Fatalf("lost file: %s → %s", id, again)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "companion-id")); strings.TrimSpace(string(b)) != id {
		t.Fatal("the file was not put back")
	}
	// standby.go uses the same id.
	if companionOwnID(root) != id {
		t.Fatal("standby does not use the permanent id")
	}
	// Another PC gets another id.
	if other := ensurePCID(t.TempDir()); other == id {
		t.Fatal("two PCs with one id")
	}
}

func TestPresenceKeepsOnlyOurAgencyOnOurNetwork(t *testing.T) {
	presenceTest(t)
	presenceAddrOK = func(ip net.IP) bool { return lanUsable(ip) && ip.To4()[0] == 192 }
	tag := agencyTag("47040")
	msg := presenceMessage(tag, "bbbbbbbbbbbb", 4000, "pc", "Reception", false)
	if e, ok := parsePresence(msg); !ok || e.ID != "bbbbbbbbbbbb" || e.Port != 4000 || e.Name != "Reception" {
		t.Fatalf("parse: %+v %v", e, ok)
	}
	if _, ok := presenceHeard(msg, "192.168.1.7"); !ok {
		t.Fatal("our PC on our network was not kept")
	}
	for _, c := range []struct{ msg, ip, why string }{
		{presenceMessage(agencyTag("99999"), "cccccccccccc", 4000, "main", "", false), "192.168.1.8", "another agency"},
		{presenceMessage(tag, "dddddddddddd", 4000, "pc", "", false), "100.89.1.2", "Tailscale"},
		{presenceMessage(tag, "dddddddddddd", 4000, "pc", "", false), "169.254.3.4", "link-local"},
		{presenceMessage(tag, "dddddddddddd", 4000, "pc", "", false), "10.86.0.5", "another subnet"},
		{presenceMessage(tag, myPCID, 4000, "pc", "", false), "192.168.1.9", "this PC itself"},
		{"ADAL_KEEP_PC_V1|" + tag + "|x|4000|pc", "192.168.1.9", "a bad id"},
	} {
		if _, ok := presenceHeard(c.msg, c.ip); ok {
			t.Fatalf("%s was kept", c.why)
		}
	}
	if e, ok := presenceOf("bbbbbbbbbbbb"); !ok || e.url() != "http://192.168.1.7:4000" {
		t.Fatalf("map: %+v", e)
	}
	presenceFailed("bbbbbbbbbbbb")
	if _, ok := presenceOf("bbbbbbbbbbbb"); ok {
		t.Fatal("a failed address was still given")
	}
}

// listenOn: a fake Adal Keep at ip:port (the same port on two loopback addresses = one PC that moved).
func listenOn(t *testing.T, addr string, h http.Handler) *httptest.Server {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("cannot listen on %s: %v", addr, err)
	}
	s := &httptest.Server{Listener: ln, Config: &http.Server{Handler: h}}
	s.Start()
	t.Cleanup(s.Close)
	return s
}

func mainInfo(id, mac string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/companion/info" {
			fmt.Fprintf(w, `{"service":"adal-keep","name":"Main","macs":[%q],"pc_id":%q}`, mac, id)
			return
		}
		http.NotFound(w, r)
	})
}

// The main PC gets a new address in the middle of the day, and a new Wi-Fi card
// address too (random hardware addresses): the Companion follows it by its id.
func TestMainPCMovesMidSessionAndChangesItsMAC(t *testing.T) {
	presenceTest(t)
	presenceSwitch = switchToMainAt
	t.Setenv("ADAL_HOST_URL", "")
	conf, _ := companionConfPath() // next to the test program
	os.Remove(conf)
	t.Cleanup(func() { os.Remove(conf) })
	const mainID = "0123456789ab"
	a := listenOn(t, "127.0.0.1:0", mainInfo(mainID, "aa:bb:cc:dd:ee:01"))
	port := a.Listener.Addr().(*net.TCPAddr).Port
	hostServer = a.URL
	if !pingServer() {
		t.Fatal("main PC A did not answer")
	}
	if got := loadIdentity().PCID; got != mainID {
		t.Fatalf("main PC's id not learned from /api/companion/info: %q", got)
	}
	tag := agencyTag("47040")
	presenceHeard(presenceMessage(tag, mainID, port, "main", "Main", false), "127.0.0.1")
	if hostServer != a.URL {
		t.Fatalf("moved while nothing changed: %s", hostServer)
	}
	// It moves: the old address is dead, the same PC (same id) answers at a new one, with a new MAC.
	a.Close()
	b := listenOn(t, fmt.Sprintf("127.0.0.2:%d", port), mainInfo(mainID, "06:11:22:33:44:55"))
	presenceHeard(presenceMessage(tag, mainID, port, "main", "Main", true), "127.0.0.2")
	deadline := time.Now().Add(5 * time.Second)
	for strings.TrimRight(hostServer, "/") != b.URL && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if strings.TrimRight(hostServer, "/") != b.URL {
		t.Fatalf("the Companion did not follow the main PC: %s (want %s)", hostServer, b.URL)
	}
	if conf, _ := os.ReadFile(conf); !strings.Contains(string(conf), b.URL) {
		t.Fatalf("new address not saved: %s", conf)
	}
	// The new card is only a hint; the id stays what it is.
	if id := loadIdentity(); id.PCID != mainID || len(id.Macs) == 0 || id.Macs[0] != "06:11:22:33:44:55" {
		t.Fatalf("identity after the move: %+v", id)
	}
	// discoverServer looks at the id first (no broadcast, no MAC needed).
	if info := discoverServer(200 * time.Millisecond); info == nil || info.URL != b.URL {
		t.Fatalf("discoverServer: %+v", info)
	}
}

// Another PC broadcasting the main role with our tag is not taken until it says our number is its own.
func TestMainIDLearnedOnlyFromOurMain(t *testing.T) {
	presenceTest(t)
	acceptServer = func(string) bool { return false }
	presenceHeard(presenceMessage(agencyTag("47040"), "feedfeedfeed", 4000, "main", "", false), "127.0.0.5")
	time.Sleep(100 * time.Millisecond)
	if loadIdentity().PCID != "" {
		t.Fatal("an id learned from a PC that is not ours")
	}
	acceptServer = func(string) bool { return true }
	presenceHeard(presenceMessage(agencyTag("47040"), "feedfeedfeed", 4000, "main", "", false), "127.0.0.5")
	deadline := time.Now().Add(2 * time.Second)
	for loadIdentity().PCID == "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if loadIdentity().PCID != "feedfeedfeed" {
		t.Fatal("our main PC's id was not learned")
	}
}

func TestRandomHardwareAddressWarned(t *testing.T) {
	lan := []net.Addr{&net.IPNet{IP: net.IPv4(192, 168, 1, 20), Mask: net.CIDRMask(24, 32)}}
	ifs := []net.Interface{
		{Name: "Wi-Fi", Flags: net.FlagUp, HardwareAddr: net.HardwareAddr{0x06, 0x11, 0x22, 0x33, 0x44, 0x55}}, // locally administered
		{Name: "Ethernet", Flags: net.FlagUp, HardwareAddr: net.HardwareAddr{0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e}},
		{Name: "Down", HardwareAddr: net.HardwareAddr{0x02, 0, 0, 0, 0, 1}},
	}
	got := randomMACs(ifs, func(net.Interface) []net.Addr { return lan })
	if len(got) != 1 || !strings.HasPrefix(got[0], "Wi-Fi ") {
		t.Fatalf("random MACs: %v", got)
	}
}

// Over a real socket: a message on the presence port lands in the map.
func TestPresenceOverUDP(t *testing.T) {
	presenceTest(t)
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	port := c.LocalAddr().(*net.UDPAddr).Port
	c.Close()
	oldPort := presencePort
	presencePort = port
	defer func() { presencePort = oldPort }()
	t.Setenv("ADAL_PRESENCE_TO", fmt.Sprintf("127.0.0.1:%d", port))
	root := t.TempDir()
	startPresence(root)
	if myPCID == "" {
		t.Fatal("no id")
	}
	s, _ := net.Dial("udp4", fmt.Sprintf("127.0.0.1:%d", port))
	defer s.Close()
	s.Write([]byte(presenceMessage(agencyTag("47040"), "beefbeefbeef", 4000, "pc", "PC2", false)))
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if e, ok := presenceOf("beefbeefbeef"); ok && e.IP == "127.0.0.1" {
			// Its own message (sent to itself by ADAL_PRESENCE_TO) is never in the map.
			if _, self := presenceOf(myPCID); self {
				t.Fatal("this PC heard itself")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the message was not heard")
}
