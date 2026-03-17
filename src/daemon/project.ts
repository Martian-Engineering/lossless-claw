import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_DIR = join(homedir(), ".lossless-claude");

export const projectId = (cwd: string): string =>
  createHash("sha256").update(cwd).digest("hex");

export const projectDir = (cwd: string): string =>
  join(BASE_DIR, "projects", projectId(cwd));

export const projectDbPath = (cwd: string): string =>
  join(projectDir(cwd), "db.sqlite");

export const projectMetaPath = (cwd: string): string =>
  join(projectDir(cwd), "meta.json");
