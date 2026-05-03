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

  it("echoes the rejected input in the error text on invalid daysBack (P3)", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const tooLarge = await fixture.command.handler(
      makeContext("rebuild-rollups 366"),
    );
    expect(tooLarge.text).toContain("[1, 365]");
    expect(tooLarge.text).toContain("`366`");

    const nonInt = await fixture.command.handler(
      makeContext("rebuild-rollups 7.0"),
    );
    expect(nonInt.text).toContain("`7.0`");

    const negative = await fixture.command.handler(
      makeContext("rebuild-rollups -3"),
    );
    expect(negative.text).toContain("`-3`");

    const garbage = await fixture.command.handler(
      makeContext("rebuild-rollups abc"),
    );
    expect(garbage.text).toContain("`abc`");
  });

  it("appends a (...N more suppressed) marker when error totals exceed 3 (P3)", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "rebuild-suppressed",
      sessionKey: "agent:rebuild:main",
    });

    fixture.buildDailyRollups.mockResolvedValueOnce({
      built: 0,
      skipped: 0,
      errors: ["d-err-1", "d-err-2", "d-err-3"],
    });
    fixture.buildWeeklyMonthlyRollups.mockResolvedValueOnce({
      built: 0,
      skipped: 0,
      errors: ["w-err-1", "w-err-2", "m-err-1"],
    });

    const result = await fixture.command.handler(
      makeContext("rebuild-rollups 7"),
    );

    expect(result.text).toContain("d-err-1");
    expect(result.text).toContain("d-err-2");
    expect(result.text).toContain("d-err-3");
    expect(result.text).not.toContain("w-err-1");
    expect(result.text).toContain("(...3 more suppressed)");
  });

  it("does not emit the suppression marker when error count is at most 3 (P3)", async () => {
    const fixture = createRebuildFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "rebuild-suppressed-edge",
      sessionKey: "agent:rebuild:main",
    });

    fixture.buildDailyRollups.mockResolvedValueOnce({
      built: 0,
      skipped: 0,
      errors: ["only-1", "only-2"],
    });
    fixture.buildWeeklyMonthlyRollups.mockResolvedValueOnce({
      built: 0,
      skipped: 0,
      errors: ["only-3"],
    });

    const result = await fixture.command.handler(
      makeContext("rebuild-rollups 7"),
    );

    expect(result.text).toContain("only-1");
    expect(result.text).toContain("only-2");
    expect(result.text).toContain("only-3");
    expect(result.text).not.toMatch(/more suppressed/);
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
