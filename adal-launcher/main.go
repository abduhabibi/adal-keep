package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	root, err := os.Executable()
	if err != nil {
		fmt.Println("Error: cannot determine install path")
		fmt.Scanln()
		os.Exit(1)
	}
	root = filepath.Dir(root)

	nodeExe := filepath.Join(root, "runtime", "node.exe")
	serverJS := filepath.Join(root, "backend", "server.js")
	agentExe := filepath.Join(root, "adal-agent.exe")
	companionExe := filepath.Join(root, "adal-companion.exe")

	// Verify Node exists
	if _, err := os.Stat(nodeExe); os.IsNotExist(err) {
		showError("Node.js runtime not found.\nPlease reinstall Adal Keep.")
		return
	}

	fmt.Println("============================================")
	fmt.Println("   ADAL KEEP - Starting...")
	fmt.Println("============================================")
	fmt.Println()

	// Start background agent
	if _, err := os.Stat(agentExe); err == nil {
		fmt.Println("[*] Starting background agent...")
		exec.Command(agentExe).Start()
	}

	// Start companion if present
	if _, err := os.Stat(companionExe); err == nil {
		fmt.Println("[*] Starting companion agent...")
		exec.Command(companionExe).Start()
	}

	// Start backend server
	fmt.Println("[*] Starting server...")
	cmd := exec.Command(nodeExe, serverJS)
	cmd.Dir = filepath.Join(root, "backend")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Start()

	// Wait for server to be ready
	fmt.Println("[*] Waiting for server...")
	ready := false
	for i := 0; i < 30; i++ {
		time.Sleep(500 * time.Millisecond)
		resp, err := http.Get("http://localhost:4000/api/health")
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			ready = true
			break
		}
	}

	if !ready {
		fmt.Println("[!] Server may still be starting. Opening browser anyway...")
	} else {
		fmt.Println("[✓] Server ready!")
	}

	// Open browser
	fmt.Println("[*] Opening Adal Keep...")
	exec.Command("cmd", "/c", "start", "http://localhost:3000").Run()

	fmt.Println()
	fmt.Println("============================================")
	fmt.Println("   Adal Keep is running!")
	fmt.Println("   Browser should open automatically.")
	fmt.Println("   DO NOT close this window.")
	fmt.Println("============================================")
	fmt.Println()
	fmt.Println("Press ENTER to stop Adal Keep...")
	fmt.Scanln()

	// Cleanup
	fmt.Println("[*] Stopping services...")
	exec.Command("taskkill", "/f", "/im", "adal-agent.exe").Run()
	exec.Command("taskkill", "/f", "/im", "adal-companion.exe").Run()

	// Kill node process listening on port 4000
	out, _ := exec.Command("cmd", "/c", "netstat -aon | findstr :4000 | findstr LISTENING").Output()
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) >= 5 {
			pid := parts[len(parts)-1]
			exec.Command("taskkill", "/f", "/pid", pid).Run()
		}
	}

	fmt.Println("[✓] Adal Keep stopped.")
	time.Sleep(1 * time.Second)
}

func showError(msg string) {
	fmt.Println()
	fmt.Println("[ERROR]", msg)
	fmt.Println()
	fmt.Println("Press ENTER to exit...")
	fmt.Scanln()
}
