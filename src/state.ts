import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  firstPathUnderParent,
  relativeFromCodexHome,
  remapPathPrefix,
  walkFilesFollowingSymlinks,
} from "./paths.js";
import { projectSourceDir } from "./jsonl.js";
import type {
  JsonStateInspectionResult,
  JsonStateMigrationResult,
  MigrationSpec,
  SessionSummary,
} from "./types.js";

const MAX_SAMPLES = 10;
const EXCLUDED_STATE_DIRS = new Set([
  ".tmp",
  "archived_sessions",
  "backups",
  "browser",
  "computer-use",
  "plugins",
  "sessions",
  "skills",
  "vendor_imports",
]);
const EXCLUDED_STATE_FILES = new Set(["auth.json", "auth.json.b2"]);

interface TransformStats {
  changedKeys: number;
  changedValues: number;
  samples: JsonStateMigrationResult["samples"];
  sampleKeys: Set<string>;
  projectChanges: Map<string, { fromCwd: string; toCwd: string; entries: number }>;
}

export function discoverJsonStateFiles(codexHome: string): string[] {
  const files = new Set<string>();
  const globalState = path.join(codexHome, ".codex-global-state.json");
  const processManager = path.join(codexHome, "process_manager", "chat_processes.json");

  if (fs.existsSync(globalState)) {
    files.add(globalState);
  }

  if (fs.existsSync(processManager)) {
    files.add(processManager);
  }

  walkFilesFollowingSymlinks(codexHome, {
    excludeDir: (dir) => isExcludedStateDir(codexHome, dir),
    includeFile: (_file, name) => name.endsWith(".json") && !EXCLUDED_STATE_FILES.has(name),
  }).forEach((file) => files.add(file));

  return [...files].sort();
}

export function migrateJsonState(
  codexHome: string,
  spec: MigrationSpec,
  options: {
    write: boolean;
    backupDir?: string;
    onProgress?: (event: {
      surface: "state";
      current: number;
      total: number;
      label: string;
    }) => void;
  },
): JsonStateMigrationResult {
  if (spec.mode === "provider") {
    return emptyStateResult();
  }

  const files = discoverJsonStateFiles(codexHome);
  let matchedFiles = 0;
  let changedFiles = 0;
  let changedKeys = 0;
  let changedValues = 0;
  const samples: JsonStateMigrationResult["samples"] = [];
  const sampleKeys = new Set<string>();
  const projectChanges = new Map<string, { fromCwd: string; toCwd: string; entries: number }>();

  files.forEach((file, index) => {
    options.onProgress?.({
      surface: "state",
      current: index + 1,
      total: files.length,
      label: relativeFromCodexHome(codexHome, file),
    });

    const content = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const stats: TransformStats = {
      changedKeys: 0,
      changedValues: 0,
      samples,
      sampleKeys,
      projectChanges,
    };
    const transformed = transformJsonValue(parsed, spec, stats, relativeFromCodexHome(codexHome, file));

    if (stats.changedKeys === 0 && stats.changedValues === 0) {
      return;
    }

    matchedFiles += 1;
    changedFiles += 1;
    changedKeys += stats.changedKeys;
    changedValues += stats.changedValues;

    if (options.write) {
      if (!options.backupDir) {
        throw new Error("backupDir is required when writing JSON state changes");
      }

      backupFile(codexHome, options.backupDir, file);
      fs.writeFileSync(file, `${JSON.stringify(transformed, null, 2)}\n`);
    }
  });

  return {
    scannedFiles: files.length,
    matchedFiles,
    changedFiles,
    changedKeys,
    changedValues,
    projectChanges: [...projectChanges.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd)),
    samples,
  };
}

export function inspectJsonState(codexHome: string): JsonStateInspectionResult {
  const files = discoverJsonStateFiles(codexHome);
  const inspected: JsonStateInspectionResult["files"] = [];
  let pathKeys = 0;
  let pathValues = 0;

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const counts = countStatePaths(parsed);
      pathKeys += counts.pathKeys;
      pathValues += counts.pathValues;
      inspected.push({
        file: relativeFromCodexHome(codexHome, file),
        pathKeys: counts.pathKeys,
        pathValues: counts.pathValues,
      });
    } catch (error) {
      inspected.push({
        file: relativeFromCodexHome(codexHome, file),
        pathKeys: 0,
        pathValues: 0,
        parseError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scannedFiles: files.length,
    pathKeys,
    pathValues,
    files: inspected,
  };
}

function isExcludedStateDir(codexHome: string, dir: string): boolean {
  const relative = path.relative(codexHome, dir);
  const topLevel = relative.split(path.sep)[0];
  return EXCLUDED_STATE_DIRS.has(topLevel);
}

function transformJsonValue(
  value: unknown,
  spec: MigrationSpec,
  stats: TransformStats,
  file: string,
): unknown {
  if (typeof value === "string") {
    const remapped = remapStatePath(value, spec);
    if (remapped && remapped !== value) {
      stats.changedValues += 1;
      addSample(stats, file, value, remapped);
      addProjectChange(stats, spec, value, remapped);
      return remapped;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => transformJsonValue(item, spec, stats, file));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const remappedKey = remapStateKey(key, spec);
    if (remappedKey.key !== key) {
      stats.changedKeys += 1;
      addSample(stats, file, remappedKey.fromPath, remappedKey.toPath);
      addProjectChange(stats, spec, remappedKey.fromPath, remappedKey.toPath);
    }

    output[remappedKey.key] = transformJsonValue(child, spec, stats, file);
  }

  return output;
}

function countStatePaths(value: unknown): { pathKeys: number; pathValues: number } {
  if (typeof value === "string") {
    return { pathKeys: 0, pathValues: looksAbsolutePath(value) ? 1 : 0 };
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (sum, item) => {
        const counts = countStatePaths(item);
        return {
          pathKeys: sum.pathKeys + counts.pathKeys,
          pathValues: sum.pathValues + counts.pathValues,
        };
      },
      { pathKeys: 0, pathValues: 0 },
    );
  }

  if (!value || typeof value !== "object") {
    return { pathKeys: 0, pathValues: 0 };
  }

  let pathKeys = 0;
  let pathValues = 0;
  for (const [key, child] of Object.entries(value)) {
    if (looksPathKey(key)) {
      pathKeys += 1;
    }

    const counts = countStatePaths(child);
    pathKeys += counts.pathKeys;
    pathValues += counts.pathValues;
  }

  return { pathKeys, pathValues };
}

function remapStatePath(candidate: string, spec: MigrationSpec): string | undefined {
  if (spec.mode === "provider") {
    return undefined;
  }

  if (spec.mode === "projects") {
    return remapPathPrefix(candidate, spec.originalDir, spec.targetDir);
  }

  const session: SessionSummary = {
    file: "",
    cwd: candidate,
    archived: false,
  };
  const sourceDir = projectSourceDir(spec, session);
  return sourceDir ? remapPathPrefix(candidate, sourceDir, spec.targetDir) : undefined;
}

function remapStateKey(
  key: string,
  spec: MigrationSpec,
): {
  key: string;
  fromPath: string;
  toPath: string;
} {
  const exact = remapStatePath(key, spec);
  if (exact && exact !== key) {
    return { key: exact, fromPath: key, toPath: exact };
  }

  for (const start of pathStartIndexes(key)) {
    const candidate = key.slice(start);
    const remapped = remapStatePath(candidate, spec);
    if (remapped && remapped !== candidate) {
      return {
        key: `${key.slice(0, start)}${remapped}`,
        fromPath: candidate,
        toPath: remapped,
      };
    }
  }

  return { key, fromPath: key, toPath: key };
}

function pathStartIndexes(value: string): number[] {
  const starts: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const previous = index === 0 ? "" : value[index - 1];
    if ((index === 0 || previous === ":" || previous === "=") && value[index] === "/") {
      starts.push(index);
    }

    if (
      (index === 0 || previous === ":" || previous === "=") &&
      index + 2 < value.length &&
      /[A-Za-z]/.test(value[index]) &&
      value[index + 1] === ":" &&
      (value[index + 2] === "\\" || value[index + 2] === "/")
    ) {
      starts.push(index);
    }
  }

  return starts;
}

function looksAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^~[/\\]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function looksPathKey(value: string): boolean {
  return (
    looksAbsolutePath(value) ||
    value.includes(":/") ||
    /:[A-Za-z]:[\\/]/.test(value)
  );
}

function addSample(
  stats: TransformStats,
  file: string,
  fromCwd: string,
  toCwd: string,
): void {
  const key = `${file}:${fromCwd}:${toCwd}`;
  if (stats.sampleKeys.has(key) || stats.samples.length >= MAX_SAMPLES) {
    return;
  }

  stats.sampleKeys.add(key);
  stats.samples.push({ file, fromCwd, toCwd });
}

function addProjectChange(
  stats: TransformStats,
  spec: MigrationSpec,
  fromCwd: string,
  toCwd: string,
): void {
  if (spec.mode === "provider") {
    return;
  }

  const roots = projectChangeRoots(spec, fromCwd, toCwd);
  const key = `${roots.fromCwd}\0${roots.toCwd}`;
  const current = stats.projectChanges.get(key) ?? { ...roots, entries: 0 };
  current.entries += 1;
  stats.projectChanges.set(key, current);
}

function projectChangeRoots(
  spec: Exclude<MigrationSpec, { mode: "provider" }>,
  fromCwd: string,
  toCwd: string,
): { fromCwd: string; toCwd: string } {
  if (spec.mode === "projects") {
    const fromRoot = firstPathUnderParent(fromCwd, spec.originalDir);
    const toRoot = fromRoot ? remapPathPrefix(fromRoot, spec.originalDir, spec.targetDir) : undefined;
    return fromRoot && toRoot ? { fromCwd: fromRoot, toCwd: toRoot } : { fromCwd, toCwd };
  }

  const session: SessionSummary = {
    file: "",
    cwd: fromCwd,
    archived: false,
  };
  const fromRoot = projectSourceDir(spec, session) ?? fromCwd;
  return { fromCwd: fromRoot, toCwd: spec.targetDir };
}

function backupFile(codexHome: string, backupDir: string, file: string): void {
  const relative = relativeFromCodexHome(codexHome, file);
  const backupPath = path.join(backupDir, relative);
  ensureDir(path.dirname(backupPath));
  fs.copyFileSync(file, backupPath);
}

function emptyStateResult(): JsonStateMigrationResult {
  return {
    scannedFiles: 0,
    matchedFiles: 0,
    changedFiles: 0,
    changedKeys: 0,
    changedValues: 0,
    projectChanges: [],
    samples: [],
  };
}
