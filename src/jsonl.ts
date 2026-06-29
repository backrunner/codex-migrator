import fs from "node:fs";
import path from "node:path";
import {
  ensureDir,
  firstAncestorWithBasename,
  firstPathUnderParent,
  historyBasename,
  isHistoryPathAbsolute,
  isSameOrInside,
  normalizeHistoryPath,
  relativeFromCodexHome,
  remapPathPrefix,
} from "./paths.js";
import type {
  FileChangeSample,
  JsonObject,
  JsonlFileFingerprint,
  JsonlMigrationPlan,
  JsonlMigrationResult,
  MigrationSpec,
  PlannedJsonlFileChange,
  PlannedJsonlLineChange,
  PlannedJsonlSession,
  SessionSummary,
} from "./types.js";

const MAX_SAMPLES = 10;
const JSONL_PLAN_VERSION = 1;

export function discoverSessionFiles(
  codexHome: string,
  includeArchived: boolean,
  onProgress?: (event: {
    surface: "scan";
    current: number;
    total: number;
    label: string;
  }) => void,
): PlannedJsonlSession[] {
  const fingerprints = discoverJsonlFingerprints(codexHome, includeArchived);

  return fingerprints.map((fingerprint, index) => {
    onProgress?.({
      surface: "scan",
      current: index + 1,
      total: fingerprints.length,
      label: relativeFromCodexHome(codexHome, fingerprint.file),
    });

    return {
      session: {
        ...readSessionSummary(fingerprint.file),
        archived: fingerprint.archived,
        file: fingerprint.file,
      },
      fingerprint,
    };
  });
}

export function countSessionFiles(dir: string): number {
  return walkJsonl(dir).length;
}

export function validateJsonlPlan(
  plan: JsonlMigrationPlan,
  codexHome: string,
  includeArchived: boolean,
  spec: MigrationSpec,
): void {
  if (plan.version !== JSONL_PLAN_VERSION) {
    throw new Error("JSONL migration preview is from an unsupported plan version");
  }

  if (plan.codexHome !== codexHome || plan.includeArchived !== includeArchived) {
    throw new Error("JSONL migration preview does not match the current migration options");
  }

  if (!migrationSpecsEqual(plan.action, spec)) {
    throw new Error("JSONL migration preview does not match the current migration action");
  }

  const currentFingerprints = discoverJsonlFingerprints(codexHome, includeArchived);
  const currentByFile = new Map(currentFingerprints.map((fingerprint) => [fingerprint.file, fingerprint]));
  if (currentByFile.size !== plan.sessions.length) {
    throw new Error("JSONL session files changed after preview; run the migration again");
  }

  for (const planned of plan.sessions) {
    const current = currentByFile.get(planned.session.file);
    if (!current || !sameFingerprint(current, planned.fingerprint)) {
      throw new Error("JSONL session files changed after preview; run the migration again");
    }
  }
}

export function applyJsonlPlan(
  plan: JsonlMigrationPlan,
  options: {
    codexHome: string;
    backupDir: string;
    onProgress?: (event: {
      surface: "jsonl";
      current: number;
      total: number;
      label: string;
    }) => void;
  },
): JsonlMigrationResult {
  plan.changes.forEach((change, index) => {
    options.onProgress?.({
      surface: "jsonl",
      current: index + 1,
      total: plan.changes.length,
      label: relativeFromCodexHome(options.codexHome, change.session.file),
    });

    const content = fs.readFileSync(change.session.file, "utf8");
    const nextContent = applyLineChanges(content, change.lineChanges);
    backupFile(options.codexHome, options.backupDir, change.session.file);
    fs.writeFileSync(change.session.file, nextContent);
  });

  return plan.result;
}

export function migrateJsonlFiles(
  sessions: PlannedJsonlSession[],
  spec: MigrationSpec,
  options: {
    write: boolean;
    codexHome: string;
    includeArchived: boolean;
    backupDir?: string;
    onPlan?: (plan: JsonlMigrationPlan) => void;
    onProgress?: (event: {
      surface: "jsonl";
      current: number;
      total: number;
      label: string;
    }) => void;
  },
): JsonlMigrationResult {
  if (options.write) {
    throw new Error("migrateJsonlFiles writes must use applyJsonlPlan");
  }

  const result: JsonlMigrationResult = {
    scannedFiles: sessions.length,
    matchedFiles: 0,
    changedFiles: 0,
    changedLines: 0,
    threadProjectHints: [],
    projectChanges: [],
    samples: [],
  };
  const sampleKeys = new Set<string>();
  const threadHints = new Map<string, { id: string; fromCwd: string; toCwd: string }>();
  const projectChanges = new Map<string, { fromCwd: string; toCwd: string; files: number; lines: number }>();
  const plannedChanges: PlannedJsonlFileChange[] = [];

  sessions.forEach(({ session, fingerprint }, index) => {
    options.onProgress?.({
      surface: "jsonl",
      current: index + 1,
      total: sessions.length,
      label: relativeFromCodexHome(options.codexHome, session.file),
    });

    const shouldScanContent = spec.mode === "project" || spec.mode === "projects";
    if (!shouldScanContent && !sessionMatches(session, spec)) {
      return;
    }

    const content = fs.readFileSync(session.file, "utf8");
    if (!contentMightContainMigrationTarget(content, spec, session)) {
      return;
    }

    const migration = transformJsonlContent(content, spec, session);

    if (migration.changedLines === 0) {
      return;
    }

    result.matchedFiles += 1;
    result.changedFiles += 1;
    result.changedLines += migration.changedLines;
    for (const change of migration.projectChanges) {
      const key = `${change.fromCwd}\0${change.toCwd}`;
      const current = projectChanges.get(key) ?? { ...change, files: 0, lines: 0 };
      current.files += 1;
      current.lines += change.lines;
      projectChanges.set(key, current);
    }
    if (session.id && migration.projectChanges.length > 0) {
      const firstProjectChange = migration.projectChanges[0];
      threadHints.set(session.id, {
        id: session.id,
        fromCwd: firstProjectChange.fromCwd,
        toCwd: firstProjectChange.toCwd,
      });
    }

    const sampleKey = fileChangeSampleKey(migration.sample, spec);
    if (!sampleKeys.has(sampleKey) && result.samples.length < MAX_SAMPLES) {
      sampleKeys.add(sampleKey);
      result.samples.push(migration.sample);
    }

    plannedChanges.push({
      session,
      fingerprint,
      changedLines: migration.changedLines,
      lineChanges: migration.lineChanges,
      projectChanges: migration.projectChanges,
      sample: migration.sample,
    });
  });

  result.threadProjectHints = [...threadHints.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.projectChanges = [...projectChanges.values()].sort((a, b) =>
    a.fromCwd.localeCompare(b.fromCwd),
  );
  options.onPlan?.({
    version: JSONL_PLAN_VERSION,
    codexHome: options.codexHome,
    includeArchived: options.includeArchived,
    action: spec,
    sessions,
    changes: plannedChanges,
    result,
  });
  return result;
}

export function transformJsonlContent(
  content: string,
  spec: MigrationSpec,
  session: SessionSummary,
): {
  content: string;
  changedLines: number;
  lineChanges: PlannedJsonlLineChange[];
  projectChanges: Array<{ fromCwd: string; toCwd: string; lines: number }>;
  sample: FileChangeSample;
} {
  const lines = content.split("\n");
  const lineChanges: PlannedJsonlLineChange[] = [];
  let changedLines = 0;
  let firstFromProvider: string | undefined;
  let firstFromCwd: string | undefined;
  let firstToCwd: string | undefined;
  const projectChanges = new Map<string, { fromCwd: string; toCwd: string; lines: number }>();

  const transformed = lines.map((line, index) => {
    if (line.trim() === "") {
      return line;
    }

    if (!lineMightContainMigrationTarget(line, spec, session)) {
      return line;
    }

    let parsed: JsonObject;
    try {
      parsed = JSON.parse(line) as JsonObject;
    } catch {
      return line;
    }

    const payload = asObject(parsed.payload);
    if (!payload) {
      return line;
    }

    let changed = false;

    if (spec.mode === "provider" && parsed.type === "session_meta") {
      const currentProvider = asString(payload.model_provider);
      const shouldUpdate =
        currentProvider !== spec.targetProvider &&
        (!spec.fromProvider || currentProvider === spec.fromProvider);

      if (shouldUpdate) {
        firstFromProvider ??= currentProvider;
        payload.model_provider = spec.targetProvider;
        changed = true;
      }
    }

    if (spec.mode === "project" || spec.mode === "projects") {
      const cwd = asString(payload.cwd);
      if (cwd) {
        const nextCwd = remapCwd(cwd, spec, session);
        if (nextCwd && nextCwd !== cwd) {
          firstFromCwd ??= cwd;
          firstToCwd ??= nextCwd;
          addProjectChange(projectChanges, spec, cwd, nextCwd);
          payload.cwd = nextCwd;
          changed = true;
        }
      }

      const workspaceRoots = payload.workspace_roots;
      if (Array.isArray(workspaceRoots)) {
        const nextRoots = workspaceRoots.map((root) => {
          if (typeof root !== "string") {
            return root;
          }

          const nextRoot = remapWorkspaceRoot(root, spec, session);
          if (nextRoot && nextRoot !== root) {
            addProjectChange(projectChanges, spec, root, nextRoot);
          }

          return nextRoot ?? root;
        });

        if (JSON.stringify(nextRoots) !== JSON.stringify(workspaceRoots)) {
          payload.workspace_roots = nextRoots;
          changed = true;
        }
      }
    }

    if (!changed) {
      return line;
    }

    changedLines += 1;
    const nextLine = JSON.stringify(parsed);
    lineChanges.push({ index, line: nextLine });
    return nextLine;
  });

  const sample: FileChangeSample = {
    file: session.file,
    id: session.id,
  };

  if (spec.mode === "provider") {
    sample.fromProvider = firstFromProvider ?? session.modelProvider;
    sample.toProvider = spec.targetProvider;
  } else {
    const projectSample = projectSampleMapping(spec, session);
    sample.fromCwd = projectSample?.fromCwd ?? firstFromCwd ?? session.cwd;
    sample.toCwd = projectSample?.toCwd ?? firstToCwd;
  }

  return {
    content: transformed.join("\n"),
    changedLines,
    lineChanges,
    projectChanges: [...projectChanges.values()],
    sample,
  };
}

function discoverJsonlFingerprints(codexHome: string, includeArchived: boolean): JsonlFileFingerprint[] {
  const roots: Array<{ dir: string; archived: boolean }> = [
    { dir: path.join(codexHome, "sessions"), archived: false },
  ];

  if (includeArchived) {
    roots.push({ dir: path.join(codexHome, "archived_sessions"), archived: true });
  }

  return roots.flatMap(({ dir, archived }) =>
    walkJsonl(dir).map((file) => fingerprintJsonlFile(file, archived)),
  );
}

function fingerprintJsonlFile(file: string, archived: boolean): JsonlFileFingerprint {
  const stat = fs.statSync(file, { bigint: true });
  return {
    file,
    archived,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sameFingerprint(left: JsonlFileFingerprint, right: JsonlFileFingerprint): boolean {
  return (
    left.file === right.file &&
    left.archived === right.archived &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function applyLineChanges(content: string, changes: PlannedJsonlLineChange[]): string {
  if (changes.length === 0) {
    return content;
  }

  const lines = content.split("\n");
  for (const change of changes) {
    lines[change.index] = change.line;
  }

  return lines.join("\n");
}

function migrationSpecsEqual(left: MigrationSpec, right: MigrationSpec): boolean {
  if (left.mode !== right.mode) {
    return false;
  }

  if (left.mode === "provider" && right.mode === "provider") {
    return left.targetProvider === right.targetProvider && left.fromProvider === right.fromProvider;
  }

  if (left.mode === "project" && right.mode === "project") {
    return (
      left.projectName === right.projectName &&
      left.targetDir === right.targetDir &&
      left.fromDir === right.fromDir
    );
  }

  return (
    left.mode === "projects" &&
    right.mode === "projects" &&
    left.originalDir === right.originalDir &&
    left.targetDir === right.targetDir
  );
}

function contentMightContainMigrationTarget(
  content: string,
  spec: MigrationSpec,
  session: SessionSummary,
): boolean {
  if (spec.mode === "provider") {
    return true;
  }

  if (!hasProjectPathPayloadKey(content)) {
    return false;
  }

  if (spec.mode === "projects") {
    return contentMayContainPath(content, spec.originalDir, false);
  }

  return projectPrefilterCandidates(spec, session).some(({ value, includeBasename }) =>
    contentMayContainPath(content, value, includeBasename),
  );
}

function lineMightContainMigrationTarget(
  line: string,
  spec: MigrationSpec,
  session: SessionSummary,
): boolean {
  if (spec.mode === "provider") {
    return true;
  }

  if (!hasProjectPathPayloadKey(line)) {
    return false;
  }

  if (spec.mode === "projects") {
    return contentMayContainPath(line, spec.originalDir, false);
  }

  return projectPrefilterCandidates(spec, session).some(({ value, includeBasename }) =>
    contentMayContainPath(line, value, includeBasename),
  );
}

function hasProjectPathPayloadKey(content: string): boolean {
  return content.includes("\"cwd\"") || content.includes("\"workspace_roots\"");
}

function projectPrefilterCandidates(
  spec: MigrationSpec,
  session: SessionSummary,
): Array<{ value: string; includeBasename: boolean }> {
  if (spec.mode !== "project") {
    return [];
  }

  if (spec.fromDir) {
    return [{ value: spec.fromDir, includeBasename: false }];
  }

  if (isHistoryPathAbsolute(spec.projectName)) {
    return [{ value: spec.projectName, includeBasename: false }];
  }

  const sessionSource = session.cwd ? firstAncestorWithBasename(session.cwd, spec.projectName) : undefined;
  return [
    sessionSource ? { value: sessionSource, includeBasename: false } : undefined,
    { value: spec.projectName, includeBasename: true },
  ].filter((candidate): candidate is { value: string; includeBasename: boolean } => Boolean(candidate));
}

function contentMayContainPath(content: string, candidate: string, includeBasename: boolean): boolean {
  const normalized = normalizeHistoryPath(candidate);
  const needles = new Set([candidate, normalized, jsonStringFragment(candidate), jsonStringFragment(normalized)]);

  if (includeBasename) {
    const basename = historyBasename(normalized);
    needles.add(basename);
    needles.add(jsonStringFragment(basename));
  }

  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    if (content.includes(needle)) {
      return true;
    }

    const slashEscapedNeedle = needle.replaceAll("/", "\\/");
    if (slashEscapedNeedle !== needle && content.includes(slashEscapedNeedle)) {
      return true;
    }
  }

  const lowerContent = content.toLowerCase();
  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    if (lowerContent.includes(needle.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function addProjectChange(
  changes: Map<string, { fromCwd: string; toCwd: string; lines: number }>,
  spec: MigrationSpec,
  fromCwd: string,
  toCwd: string,
): void {
  if (spec.mode === "provider") {
    return;
  }

  const roots = projectChangeRoots(spec, fromCwd, toCwd);
  const key = `${roots.fromCwd}\0${roots.toCwd}`;
  const current = changes.get(key) ?? { ...roots, lines: 0 };
  current.lines += 1;
  changes.set(key, current);
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

  const fromRoot = projectSourceDirForPath(spec, fromCwd) ?? fromCwd;
  return { fromCwd: fromRoot, toCwd: spec.targetDir };
}

export function readSessionSummary(file: string): Omit<SessionSummary, "file" | "archived"> {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(128 * 1024);
  const chunks: Buffer[] = [];
  const maxFirstLineBytes = 32 * 1024 * 1024;
  let offset = 0;

  try {
    let firstLine: string | undefined;

    while (offset < maxFirstLineBytes) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead === 0) {
        break;
      }

      const slice = chunk.subarray(0, bytesRead);
      const newlineIndex = slice.indexOf(10);

      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex));
        firstLine = Buffer.concat(chunks).toString("utf8");
        break;
      }

      chunks.push(Buffer.from(slice));
      offset += bytesRead;
    }

    firstLine ??= Buffer.concat(chunks).toString("utf8");

    if (!firstLine) {
      return {};
    }

    const parsed = JSON.parse(firstLine) as JsonObject;
    const payload = asObject(parsed.payload);

    if (parsed.type !== "session_meta" || !payload) {
      return {};
    }

    return {
      id: asString(payload.session_id) ?? asString(payload.id),
      cwd: asString(payload.cwd),
      modelProvider: asString(payload.model_provider),
    };
  } catch {
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

export function sessionMatches(session: SessionSummary, spec: MigrationSpec): boolean {
  if (spec.mode === "provider") {
    if (!session.modelProvider || session.modelProvider === spec.targetProvider) {
      return false;
    }

    return !spec.fromProvider || session.modelProvider === spec.fromProvider;
  }

  if (!session.cwd) {
    return false;
  }

  if (spec.mode === "project") {
    const sourceDir = projectSourceDir(spec, session);
    return sourceDir ? isSameOrInside(session.cwd, sourceDir) : false;
  }

  return remapPathPrefix(session.cwd, spec.originalDir, spec.targetDir) !== undefined;
}

export function projectSourceDir(
  spec: MigrationSpec,
  session: Pick<SessionSummary, "cwd">,
): string | undefined {
  if (spec.mode !== "project") {
    return undefined;
  }

  if (spec.fromDir) {
    return spec.fromDir;
  }

  if (isHistoryPathAbsolute(spec.projectName)) {
    return spec.projectName;
  }

  if (!session.cwd) {
    return undefined;
  }

  return projectSourceDirForPath(spec, session.cwd);
}

function projectSourceDirForPath(
  spec: MigrationSpec,
  candidate: string,
): string | undefined {
  if (spec.mode !== "project") {
    return undefined;
  }

  if (spec.fromDir) {
    return spec.fromDir;
  }

  if (isHistoryPathAbsolute(spec.projectName)) {
    return spec.projectName;
  }

  return firstAncestorWithBasename(candidate, spec.projectName);
}

function projectSampleMapping(
  spec: MigrationSpec,
  session: Pick<SessionSummary, "cwd">,
): Pick<FileChangeSample, "fromCwd" | "toCwd"> | undefined {
  if (!session.cwd || spec.mode === "provider") {
    return undefined;
  }

  if (spec.mode === "projects") {
    const fromCwd = firstPathUnderParent(session.cwd, spec.originalDir);
    const toCwd = fromCwd ? remapPathPrefix(fromCwd, spec.originalDir, spec.targetDir) : undefined;
    return fromCwd && toCwd ? { fromCwd, toCwd } : undefined;
  }

  const fromCwd = projectSourceDir(spec, session);
  return fromCwd ? { fromCwd, toCwd: spec.targetDir } : undefined;
}

function fileChangeSampleKey(sample: FileChangeSample, spec: MigrationSpec): string {
  if (spec.mode === "provider") {
    return `provider:${sample.id ?? sample.file}`;
  }

  return `project:${sample.fromCwd ?? sample.file}`;
}

function remapCwd(
  cwd: string,
  spec: MigrationSpec,
  session: SessionSummary,
): string | undefined {
  if (spec.mode === "projects") {
    return remapPathPrefix(cwd, spec.originalDir, spec.targetDir);
  }

  if (spec.mode !== "project") {
    return undefined;
  }

  const sourceDir = projectSourceDirForPath(spec, cwd) ?? projectSourceDir(spec, session);
  if (!sourceDir) {
    return undefined;
  }

  return remapPathPrefix(cwd, sourceDir, spec.targetDir);
}

function remapWorkspaceRoot(
  workspaceRoot: string,
  spec: MigrationSpec,
  session: SessionSummary,
): string | undefined {
  if (spec.mode === "projects") {
    return remapPathPrefix(workspaceRoot, spec.originalDir, spec.targetDir);
  }

  if (spec.mode !== "project") {
    return undefined;
  }

  const sourceDir = projectSourceDirForPath(spec, workspaceRoot) ?? projectSourceDir(spec, session);
  return sourceDir ? remapPathPrefix(workspaceRoot, sourceDir, spec.targetDir) : undefined;
}

function walkJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonl(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }

  return out.sort();
}

function backupFile(codexHome: string, backupDir: string, file: string): void {
  const relative = relativeFromCodexHome(codexHome, file);
  const backupPath = path.join(backupDir, relative);
  ensureDir(path.dirname(backupPath));
  fs.copyFileSync(file, backupPath);
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
