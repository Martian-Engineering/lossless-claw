package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveOpenclawStateDirDefaultsToDotOpenclaw(t *testing.T) {
	t.Setenv("OPENCLAW_STATE_DIR", "")
	dir := resolveOpenclawStateDir()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	expected := filepath.Join(home, ".openclaw")
	if dir != expected {
		t.Fatalf("expected %q, got %q", expected, dir)
	}
}

func TestResolveOpenclawStateDirUsesEnvVar(t *testing.T) {
	t.Setenv("OPENCLAW_STATE_DIR", "/custom/state")
	dir := resolveOpenclawStateDir()
	if dir != "/custom/state" {
		t.Fatalf("expected /custom/state, got %q", dir)
	}
}

func TestResolveDataPathsUsesOpenclawStateDir(t *testing.T) {
	t.Setenv("OPENCLAW_STATE_DIR", "/custom/tui")
	paths, err := resolveDataPaths()
	if err != nil {
		t.Fatalf("resolveDataPaths: %v", err)
	}
	if paths.openclawDir != "/custom/tui" {
		t.Fatalf("expected openclawDir /custom/tui, got %q", paths.openclawDir)
	}
	if paths.lcmDBPath != "/custom/tui/lcm.db" {
		t.Fatalf("expected lcmDBPath /custom/tui/lcm.db, got %q", paths.lcmDBPath)
	}
	if paths.agentsDir != "/custom/tui/agents" {
		t.Fatalf("expected agentsDir /custom/tui/agents, got %q", paths.agentsDir)
	}
}

func TestResolveDataPathsFallsBackToDotOpenclaw(t *testing.T) {
	t.Setenv("OPENCLAW_STATE_DIR", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	paths, err := resolveDataPaths()
	if err != nil {
		t.Fatalf("resolveDataPaths: %v", err)
	}
	expected := filepath.Join(home, ".openclaw")
	if paths.openclawDir != expected {
		t.Fatalf("expected openclawDir %q, got %q", expected, paths.openclawDir)
	}
}
