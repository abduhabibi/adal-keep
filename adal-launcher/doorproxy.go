// doorproxy.go — how the app door (127.0.0.1:47802, appwindow.go) reaches the server.
//
// Go's default transport keeps only 2 idle connections to the server: a page asking
// 6 things at once (a list, its photos) closed 4 and dialled them again on the next
// burst, and "localhost" was looked up on every new one. Now 16 are kept and
// 127.0.0.1 is dialled straight (localhost only when that fails).
// Off: ADAL_DOOR_POOL=0 (Go's default, as before).
package main

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

func doorPoolOn() bool { return os.Getenv("ADAL_DOOR_POOL") != "0" }

// doorTransport: nil = Go's default transport.
func doorTransport(target *url.URL) http.RoundTripper {
	if !doorPoolOn() {
		return nil
	}
	d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	port := target.Port()
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if c, err := d.DialContext(ctx, "tcp4", net.JoinHostPort("127.0.0.1", port)); err == nil {
				return c, nil
			}
			return d.DialContext(ctx, network, addr) // a server on IPv6 only (ADAL_LISTEN_HOST)
		},
		MaxIdleConns:          32,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
		// No ResponseHeaderTimeout: the live view's pictures are one endless answer.
	}
}
