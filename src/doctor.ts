import fs from "node:fs";
import path from "node:path";
import { countSessionFiles } from "./jsonl.js";
import { normalizeDir } from "./paths.js";
import { inspectSqlite, projectCounts, providerCounts, sqlite3Available } from "./sqlite.js";
import type { DoctorResult } from "./types.js";

export function runDoctor(codexHomeInput: string): DoctorResult {
  const codexHome = normalizeDir(codexHomeInput);
  const sessionsPath = path.join(codexHome, "sessions");
  const archivedPath = path.join(codexHome, "archived_sessions");
  const warnings: string[] = [];

  if (!fs.existsSync(codexHome)) {
    warnings.push(`Codex home does not exist: ${codexHome}`);
  }

  const sqliteAvailable = sqlite3Available();
  if (!sqliteAvailable) {
    warnings.push("sqlite3 is not available; SQLite thread catalog migration will be skipped");
  }

  return {
    ok: warnings.length === 0,
    codexHome,
    platform: {
      node: process.platform,
      pathSeparator: path.sep,
    },
    sqlite3Available: sqliteAvailable,
    sessionsDir: {
      path: sessionsPath,
      exists: fs.existsSync(sessionsPath),
      files: countSessionFiles(sessionsPath),
    },
    archivedSessionsDir: {
      path: archivedPath,
      exists: fs.existsSync(archivedPath),
      files: countSessionFiles(archivedPath),
    },
    sqlite: inspectSqlite(codexHome),
    providers: providerCounts(codexHome),
    projects: projectCounts(codexHome).slice(0, 20),
    warnings,
  };
}
