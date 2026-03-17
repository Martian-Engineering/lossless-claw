import { describe, it, expect } from "vitest";
import { projectId, projectDbPath, projectMetaPath } from "../../src/daemon/project.js";

describe("projectId", () => {
  it("returns sha256 hex of absolute path", () => expect(projectId("/foo")).toMatch(/^[a-f0-9]{64}$/));
  it("is deterministic", () => expect(projectId("/foo")).toBe(projectId("/foo")));
  it("differs for different paths", () => expect(projectId("/foo")).not.toBe(projectId("/bar")));
});

describe("projectDbPath", () => {
  it("returns path under .lossless-claude/projects/<id>/db.sqlite", () => {
    const p = projectDbPath("/foo/bar");
    expect(p).toContain("projects");
    expect(p).toContain("db.sqlite");
  });
});

describe("projectMetaPath", () => {
  it("returns path ending in meta.json", () => {
    expect(projectMetaPath("/foo")).toContain("meta.json");
  });
});
