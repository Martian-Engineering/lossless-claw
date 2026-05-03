import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import {
  createLcmDatabaseConnection,
  closeLcmConnection,
} from "../src/db/connection.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { createLcmCommand } from "../src/plugin/lcm-command.js";

type FakeBuildResult = {
  built: number;
  skipped: number;
  errors: string[];
};

function createRebuildFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-rebuild-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const config = resolveLcmConfig({}, { dbPath });

  const buildDailyRollups = vi.fn(
    async (_id: number, _opts?: unknown): Promise<FakeBuildResult> => ({
      built: 1,
      skipped: 0,
      errors: [],
    }),
  );
  const buildWeeklyMonthlyRollups = vi.fn(
    async (_id: number, _opts?: unknown): Promise<FakeBuildResult> => ({
      built: 1,
      skipped: 0,
      errors: [],
    }),
  );
  const rollupBuilder = { buildDailyRollups, buildWeeklyMonthlyRollups };

  const getLcm = async () => ({
    rotateSessionStorageWithBackup: vi.fn(),
    getRollupBuilder: () => rollupBuilder,
    getConversationStore: () => conversationStore,
  });

  const command = createLcmCommand({
    db,
    config,
    // biome-ignore lint/suspicious/noExplicitAny: test-only typing
    getLcm: getLcm as any,
  });

  return {
    tempDir,
    dbPath,
    db,
    command,
    conversationStore,
    buildDailyRollups,
    buildWeeklyMonthlyRollups,
  };
}

function makeContext(
  args?: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/lossless ${args}` : "/lossless",
    args,
    config: {
      plugins: {
        entries: { "lossless-claw": { enabled: true } },
        slots: { contextEngine: "lossless-claw" },
      },
    },
    requestConversationBinding: async () => ({
      status: "error" as const,
      message: "unsupported",
    }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    sessionKey: "agent:rebuild:main",
    ...overrides,
  };
}

describe("/lossless rebuild-rollups", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("passes daysBack to buildWeeklyMonthlyRollups when explicit", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "rebuild-session",
      sessionKey: "agent:rebuild:main",
    });

    const result = await fixture.command.handler(
      makeContext("rebuild-rollups 7"),
    );

    expect(result.text).toContain("Lossless Claw Rebuild Rollups");
    expect(fixture.buildDailyRollups).toHaveBeenCalledTimes(1);
    expect(fixture.buildWeeklyMonthlyRollups).toHaveBeenCalledTimes(1);

    const dailyArgs = fixture.buildDailyRollups.mock.calls[0];
    expect(dailyArgs?.[1]).toMatchObject({ daysBack: 7 });

    const aggArgs = fixture.buildWeeklyMonthlyRollups.mock.calls[0];
    expect(aggArgs?.[1]).toEqual({ daysBack: 7 });
  });

  it("passes default daysBack=7 to buildWeeklyMonthlyRollups when omitted", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "rebuild-session",
      sessionKey: "agent:rebuild:main",
    });

    await fixture.command.handler(makeContext("rebuild-rollups"));

    const aggArgs = fixture.buildWeeklyMonthlyRollups.mock.calls[0];
    expect(aggArgs?.[1]).toEqual({ daysBack: 7 });
  });

  it("passes daysBack=30 to buildWeeklyMonthlyRollups when requested", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "rebuild-session",
      sessionKey: "agent:rebuild:main",
    });

    await fixture.command.handler(makeContext("rebuild-rollups 30"));

    const aggArgs = fixture.buildWeeklyMonthlyRollups.mock.calls[0];
    expect(aggArgs?.[1]).toEqual({ daysBack: 30 });
  });
});
