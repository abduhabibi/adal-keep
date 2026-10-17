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

	// Port 4000 is the one and only Adal Keep port (backend/.env).
	// If the Run-at-login entry already started the server, do not spawn a
	// second node process — just open the UI.
	ready := serverReady(3 * time.Second)
	if ready {
		fmt.Println("[✓] Server already running on port 4000.")
	} else {
		fmt.Println("[*] Starting server...")
		// Through run-server.bat when present: it restarts the server when it
		// exits (after an update from the Settings page, for example).
		cmd := exec.Command(nodeExe, serverJS)
		cmd.Dir = filepath.Join(root, "backend")
		if bat := filepath.Join(root, "run-server.bat"); fileExists(bat) {
			cmd = exec.Command("cmd", "/c", bat)
			cmd.Dir = root
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err != nil {
			showError("Could not start the server:\n" + err.Error())
			return
		}

		fmt.Println("[*] Waiting for server...")
		ready = serverReady(45 * time.Second)
	}

	if !ready {
		fmt.Println("[!] Server may still be starting. Opening the browser anyway...")
	} else {
		fmt.Println("[✓] Server ready!")
	}

	// Open the UI — Brave when installed, otherwise the default browser.
	fmt.Println("[*] Opening Adal Keep...")
	openUI("http://localhost:4000")

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

// serverReady polls the health endpoint until it answers or the budget runs out.
func serverReady(budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://localhost:4000/api/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// braveExe returns the path of an installed Brave browser, or "" if absent.
func braveExe() string {
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// openUI opens the Adal Keep web UI in Brave when available.
func openUI(url string) {
	if b := braveExe(); b != "" {
		if err := exec.Command(b, url).Start(); err == nil {
			return
		}
	}
	exec.Command("cmd", "/c", "start", "", url).Run()
}

func showError(msg string) {
	fmt.Println()
	fmt.Println("[ERROR]", msg)
	fmt.Println()
	fmt.Println("Press ENTER to exit...")
	fmt.Scanln()
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
