/**
 * Pattern Regression Test Suite for LCM
 *
 * Validates that LCM tools integrate correctly with OpenClaw's session,
 * cron, and agent infrastructure. Designed to catch integration failures
 * that emerge in production but are difficult to detect manually.
 *
 * @module test/pattern-regression
 */

import { describe, it, expect, beforeAll, afterAll } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LCM_DB_PATH = process.env.LCM_DB_PATH || join(process.env.HOME || '/home/moltbot', '.openclaw', 'lcm.db');
const OPENCLAW_BINARY = process.env.OPENCLAW_BINARY || 'openclaw';
const TEST_TIMEOUT_MS = 60000;

/**
 * Test fixture: creates a temporary conversation with known content
 * for validating LCM compaction and expansion.
 */
interface TestFixture {
  conversationId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  summaries: string[];
}

/**
 * Pattern 001: LCM Tools Integration
 * Validates that lcm_grep, lcm_expand, and lcm_describe work correctly
 * after compaction.
 */
describe('Pattern 001: LCM Tools Integration', () => {
  let fixture: TestFixture;

  beforeAll(() => {
    // Create test conversation with known facts
    fixture = {
      conversationId: `test-${Date.now()}`,
      messages: [
        { role: 'user', content: 'Reminder: Kubernetes cluster pve has 8 nodes' },
        { role: 'assistant', content: 'Got it, I will monitor pve cluster' },
        { role: 'user', content: 'The backup cron runs at 2 AM AEDT daily' },
        { role: 'assistant', content: 'Acknowledged: backup at 02:00 Australia/Melbourne' },
      ],
      summaries: [],
    };
  });

  it('should find facts via lcm_grep after compaction', async () => {
    const result = await runOpenClawTool('lcm_grep', {
      pattern: 'pve.*8.*nodes',
      mode: 'regex',
      conversationId: fixture.conversationId,
    });

    expect(result.status).toBe('ok');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].snippet).toMatch(/8.*nodes|pve.*8/i);
  });

  it('should expand summaries via lcm_expand', async () => {
    const result = await runOpenClawTool('lcm_expand', {
      summaryIds: fixture.summaries,
      includeMessages: true,
    });

    expect(result.status).toBe('ok');
    expect(result.expanded).toContain('8 nodes');
  });

  it('should answer focused queries via lcm_expand_query', async () => {
    const result = await runOpenClawTool('lcm_expand_query', {
      query: 'How many nodes does pve cluster have?',
      prompt: 'What is the node count for pve?',
      conversationId: fixture.conversationId,
    });

    expect(result.status).toBe('ok');
    expect(result.answer).toMatch(/8/i);
  });
});

/**
 * Pattern 002: Compaction Completes Without Error
 * Validates that the summarizer can successfully compact a conversation.
 */
describe('Pattern 002: Compaction', () => {
  it('should compact a conversation without errors', async () => {
    const result = await runOpenClawCommand([
      'lcm',
      'compact',
      '--force',
      '--min-tokens', '100',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('Error');
  });
});

/**
 * Pattern 003: Auth Profile Validation
 * Validates that the summarizer uses the correct auth profile.
 */
describe('Pattern 003: Auth Profiles', () => {
  it('should use configured summarizer model', async () => {
    const config = readFileSync(join(process.env.HOME || '/home/moltbot', '.openclaw', 'openclaw.json'), 'utf-8');
    const parsed = JSON.parse(config);
    const lcmPlugin = parsed.plugins?.find((p: { id: string }) => p.id === 'lcm');

    expect(lcmPlugin).toBeDefined();
    expect(lcmPlugin.config?.summarizerModel).toBeDefined();
  });
});

/**
 * Helper: Run an OpenClaw tool via CLI
 */
async function runOpenClawTool(tool: string, params: Record<string, unknown>): Promise<{ status: string; [key: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const args = ['tool', 'call', tool, '--params', JSON.stringify(params)];
    const proc = spawn(OPENCLAW_BINARY, args, { timeout: TEST_TIMEOUT_MS });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Tool ${tool} failed: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Invalid JSON from ${tool}: ${stdout}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Helper: Run an OpenClaw CLI command
 */
async function runOpenClawCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(OPENCLAW_BINARY, args, { timeout: TEST_TIMEOUT_MS });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on('error', reject);
  });
}