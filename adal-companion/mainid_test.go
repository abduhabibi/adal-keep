package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A fake Adal Keep that says whose it is by its number (as /api/pc-access/check-number does).
func fakeNumberedMain(number string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/companion/info":
			w.Write([]byte(`{"service":"adal-keep","name":"x","macs":["aa:bb:cc:dd:ee:01"]}`))
		case "/api/pc-access/check-number":
			b := make([]byte, 200)
			n, _ := r.Body.Read(b)
			if strings.Contains(string(b[:n]), `"`+number+`"`) {
				w.Write([]byte(`{"ok":true}`))
			} else {
				w.Write([]byte(`{"ok":false}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
}

// 2026-11-19: a Companion of "Adal Nuzla" opened a developer test PC of another
// agency on the same Wi-Fi.
func TestAnotherAgencysMainPCIsRefusedEverywhere(t *testing.T) {
	ours, theirs := fakeNumberedMain("47040"), fakeNumberedMain("99999")
	defer ours.Close()
	defer theirs.Close()
	t.Setenv("ADAL_PC_NUMBER", "47040")
	old := identityPath
	idp := filepath.Join(t.TempDir(), "main-pc.json")
	identityPath = func() string { return idp }
	defer func() { identityPath = old }()

	if !serverIsOurs(ours.URL) || serverIsOurs(theirs.URL) {
		t.Fatal("serverIsOurs must take only the main PC with our number")
	}
	// A typed / saved address that now answers as another agency's PC.
	if !refusedServer(theirs.URL) || refusedServer(ours.URL) {
		t.Fatal("refusedServer: another agency's PC must be refused, ours not")
	}
	// An address that does not answer is not "refused" (the main PC may be off).
	if refusedServer("http://127.0.0.1:1") {
		t.Fatal("an address that does not answer was refused")
	}
	// The MAC finder: the neighbour table holds the other agency's card at the card's address.
	oldN := neighbourTableFn
	defer func() { neighbourTableFn = oldN }()
	saveIdentity(mainIdentity{Macs: []string{"aa:bb:cc:dd:ee:01"}, URL: theirs.URL})
	host := strings.TrimPrefix(theirs.URL, "http://")
	ip := host[:strings.LastIndex(host, ":")]
	neighbourTableFn = func() map[string]string { return map[string]string{ip: "aa:bb:cc:dd:ee:01"} }
	if got := findByMAC(); got != "" {
		t.Fatalf("the MAC finder took another agency's PC: %s", got)
	}
	// Broadcast and scan answers go through acceptServer: another agency's never.
	if acceptServer(theirs.URL) {
		t.Fatal("acceptServer took another agency's PC")
	}
	// The ping: nothing is sent to a PC that is not ours.
	hostServer = theirs.URL
	if pingServer() || hostServer != "" {
		t.Fatalf("pingServer kept another agency's PC: %q", hostServer)
	}
	hostServer = ours.URL
	if !pingServer() || hostServer != ours.URL {
		t.Fatal("pingServer dropped our own main PC")
	}
	hostServer = ""
	os.Unsetenv("ADAL_HOST_URL")
}

// Without a number, an old install still only takes the network card it knew.
func TestNoNumberStillChecksTheCard(t *testing.T) {
	m := fakeNumberedMain("1")
	defer m.Close()
	t.Setenv("ADAL_PC_NUMBER", "")
	old := identityPath
	idp := filepath.Join(t.TempDir(), "main-pc.json")
	identityPath = func() string { return idp }
	defer func() { identityPath = old }()
	if !serverIsOurs(m.URL) {
		t.Fatal("nothing known: taken as before")
	}
	saveIdentity(mainIdentity{Macs: []string{"aa:bb:cc:dd:ee:99"}})
	if serverIsOurs(m.URL) {
		t.Fatal("another card taken")
	}
	saveIdentity(mainIdentity{Macs: []string{"aa:bb:cc:dd:ee:01"}})
	if !serverIsOurs(m.URL) {
		t.Fatal("the known card refused")
	}
}

// Release offers: only from the same agency.
func TestReleaseOfferFromAnotherAgencyIsIgnored(t *testing.T) {
	old := ownAgencyTag
	defer func() { ownAgencyTag = old }()
	ownAgencyTag = func() string { return agencyTag("47040") }
	u := newUpdater(t.TempDir())
	u.built = nil
	line := func(tag string) string {
		return releaseMagic + "|" + strings.Repeat("9", 40) + "|2099-01-01T00:00:00.000Z|47810|/lan" + tag
	}
	from := net.IPv4(10, 99, 88, 77)
	if _, newer := u.heard(line("|"+agencyTag("99999")), from); newer {
		t.Fatal("heard another agency's release")
	}
	if _, newer := u.heard(line(""), from); newer {
		t.Fatal("heard an offer that does not say whose it is")
	}
	if len(u.peersWith(strings.Repeat("9", 40))) != 0 {
		t.Fatal("another agency's PC kept as a peer")
	}
	if _, newer := u.heard(line("|"+agencyTag("47040")), from); !newer {
		t.Fatal("our own agency's offer refused")
	}
	// Not joined (no number): listens to nobody, offers nothing.
	ownAgencyTag = func() string { return "" }
	if _, newer := u.heard(line("|"+agencyTag("47040")), from); newer {
		t.Fatal("a PC without an agency listened")
	}
	if agencyTag("470 40") != agencyTag("47040") || strings.Contains(agencyTag("47040"), "47040") {
		t.Fatal("tag must be a stable hash of the digits")
	}
}
