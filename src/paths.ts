import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type PathApi = typeof path.posix;

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

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
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
