package events

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type Event struct {
	ClientID  string                 `json:"client_id"`
	Type      string                 `json:"type"`
	Data      map[string]interface{} `json:"data"`
	Timestamp string                 `json:"timestamp"`
}

type Sender struct {
	serverURL string
	clientID  string
	http      *http.Client
}

func NewSender(serverURL, clientID string) *Sender {
	return &Sender{
		serverURL: serverURL,
		clientID:  clientID,
		http:      &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *Sender) Send(eventType string, data map[string]interface{}) {
	event := Event{
		ClientID:  s.clientID,
		Type:      eventType,
		Data:      data,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	body, err := json.Marshal(event)
	if err != nil {
		log.Printf("❌ Marshal error: %v", err)
		return
	}

	resp, err := s.http.Post(s.serverURL+"/api/messaging/ai/event", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("⚠️ Send failed (server offline?): %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		log.Printf("⚠️ Server returned %d for event %s", resp.StatusCode, eventType)
	}
}

func (s *Sender) StartHeartbeat() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		s.Send("heartbeat", map[string]interface{}{"status": "alive"})
	}
}
