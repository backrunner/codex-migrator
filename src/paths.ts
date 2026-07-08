import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type PathApi = typeof path.posix;

interface WalkFilesOptions {
  excludeDir?: (dir: string, name: string) => boolean;
  includeFile?: (file: string, name: string) => boolean;
}

export function expandPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function resolvePath(input: string, base = process.cwd()): string {
  const expanded = expandPath(input);
  return path.resolve(base, expanded);
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME
    ? resolvePath(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

export function normalizeDir(input: string): string {
  const resolved = resolvePath(input);
  return stripTrailingSeparator(resolved);
}

export function stripTrailingSeparator(input: string): string {
  return stripTrailingSeparatorWith(path, input);
}

export function historyBasename(input: string): string {
  return historyPathApi(input).basename(input);
}

export function firstAncestorWithBasename(
  input: string,
  basename: string,
): string | undefined {
  const api = historyPathApi(input);
  const normalized = normalizeHistoryPathWith(api, input);
  const parsed = api.parse(normalized);
  const relative = api.relative(parsed.root, normalized);
  const segments = relative.split(api.sep).filter((segment) => segment.length > 0);

  let current = parsed.root;
  for (const segment of segments) {
    current = api.join(current, segment);
    if (sameProjectBasename(segment, basename)) {
      return stripTrailingSeparatorWith(api, current);
    }
  }

  return undefined;
}

export function isHistoryPathAbsolute(input: string): boolean {
  return historyPathApi(input).isAbsolute(input);
}

export function sameHistoryPath(left: string, right: string): boolean {
  const api = historyPathApi(left, right);
  return comparableHistoryPath(left, api) === comparableHistoryPath(right, api);
}

export function normalizeHistoryPath(input: string, ...context: string[]): string {
  const api = historyPathApi(input, ...context);
  const expanded = expandPath(input);
  const normalized = api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(expanded);
  return stripTrailingSeparatorWith(api, normalized);
}

export function normalizeExistingHistoryPath(input: string, ...context: string[]): string {
  const normalized = normalizeHistoryPath(input, ...context);
  if (historyPathApi(input, ...context) === path.win32) {
    if (process.platform === "win32" && fs.existsSync(normalized)) {
      return stripTrailingSeparatorWith(path.win32, fs.realpathSync.native(normalized));
    }

    return normalized;
  }

  if (!fs.existsSync(normalized)) {
    return normalized;
  }

  return canonicalizeExistingPosixPath(normalized);
}

export function stripTrailingSeparatorWith(api: PathApi, input: string): string {
  const parsed = api.parse(input);
  let output = input;

  while (output.length > parsed.root.length && output.endsWith(api.sep)) {
    output = output.slice(0, -1);
  }

  return output;
}

export function isSameOrInside(candidate: string, parent: string): boolean {
  const api = historyPathApi(candidate, parent);
  const normalizedCandidate = comparableHistoryPath(candidate, api);
  const normalizedParent = comparableHistoryPath(parent, api);

  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}${api.sep}`)
  );
}

export function remapPathPrefix(
  candidate: string,
  originalDir: string,
  targetDir: string,
): string | undefined {
  const api = historyPathApi(candidate, originalDir, targetDir);
  const normalizedCandidate = normalizeHistoryPathWith(api, candidate);
  const normalizedOriginal = normalizeHistoryPathWith(api, originalDir);
  const normalizedTarget = normalizeHistoryPathWith(api, targetDir);

  if (!isSameOrInside(normalizedCandidate, normalizedOriginal)) {
    return undefined;
  }

  const relative = api.relative(normalizedOriginal, normalizedCandidate);
  return relative ? api.join(normalizedTarget, relative) : normalizedTarget;
}

export function firstPathUnderParent(candidate: string, parent: string): string | undefined {
  const api = historyPathApi(candidate, parent);
  const normalizedCandidate = normalizeHistoryPathWith(api, candidate);
  const normalizedParent = normalizeHistoryPathWith(api, parent);

  if (!isSameOrInside(normalizedCandidate, normalizedParent)) {
    return undefined;
  }

  const relative = api.relative(normalizedParent, normalizedCandidate);
  if (!relative) {
    return normalizedParent;
  }

  const firstSegment = relative.split(api.sep).find((segment) => segment.length > 0);
  return firstSegment ? api.join(normalizedParent, firstSegment) : normalizedParent;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function pathIsDirectory(filePath: string): boolean {
  return statFollowingSymlink(filePath)?.isDirectory() ?? false;
}

export function walkFilesFollowingSymlinks(
  dir: string,
  options: WalkFilesOptions = {},
  seenDirectories = new Set<string>(),
): string[] {
  const stat = statFollowingSymlink(dir);
  if (!stat?.isDirectory()) {
    return [];
  }

  const realDir = realpathForTraversal(dir);
  if (seenDirectories.has(realDir)) {
    return [];
  }
  seenDirectories.add(realDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const kind = pathKindForDirent(dir, entry);

    if (kind === "directory") {
      if (!options.excludeDir?.(fullPath, entry.name)) {
        files.push(...walkFilesFollowingSymlinks(fullPath, options, seenDirectories));
      }
      continue;
    }

    if (kind === "file" && (options.includeFile?.(fullPath, entry.name) ?? true)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

export function relativeFromCodexHome(codexHome: string, filePath: string): string {
  const relative = path.relative(codexHome, filePath);
  return relative.startsWith("..") ? path.basename(filePath) : relative;
}

function historyPathApi(...values: string[]): PathApi {
  return values.some(isWindowsPathLike) ? path.win32 : path.posix;
}

function isWindowsPathLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}

function normalizeHistoryPathWith(api: PathApi, input: string): string {
  const expanded = expandPath(input);
  const normalized = api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(expanded);
  return stripTrailingSeparatorWith(api, normalized);
}

function comparableHistoryPath(input: string, api: PathApi): string {
  const normalized = normalizeHistoryPathWith(api, input);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function sameProjectBasename(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function statFollowingSymlink(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function realpathForTraversal(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function pathKindForDirent(parent: string, entry: fs.Dirent): "directory" | "file" | "other" {
  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isFile()) {
    return "file";
  }

  if (!entry.isSymbolicLink()) {
    return "other";
  }

  const stat = statFollowingSymlink(path.join(parent, entry.name));
  if (stat?.isDirectory()) {
    return "directory";
  }

  return stat?.isFile() ? "file" : "other";
}

function canonicalizeExistingPosixPath(input: string): string {
  const normalized = stripTrailingSeparatorWith(path.posix, input);
  const parsed = path.posix.parse(normalized);
  const relative = path.posix.relative(parsed.root, normalized);
  const segments = relative.split(path.posix.sep).filter((segment) => segment.length > 0);
  let current = parsed.root;

  for (const segment of segments) {
    let next = segment;
    try {
      const entries = fs.readdirSync(current);
      next =
        entries.find((entry) => entry === segment) ??
        entries.find((entry) => entry.toLowerCase() === segment.toLowerCase()) ??
        segment;
    } catch {
      next = segment;
    }

    current = path.posix.join(current, next);
  }

  return stripTrailingSeparatorWith(path.posix, current);
}
