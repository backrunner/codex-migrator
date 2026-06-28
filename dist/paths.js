import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function expandPath(input) {
    if (input === "~") {
        return os.homedir();
    }
    if (input.startsWith("~/")) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}
export function resolvePath(input, base = process.cwd()) {
    const expanded = expandPath(input);
    return path.resolve(base, expanded);
}
export function defaultCodexHome() {
    return process.env.CODEX_HOME
        ? resolvePath(process.env.CODEX_HOME)
        : path.join(os.homedir(), ".codex");
}
export function normalizeDir(input) {
    const resolved = resolvePath(input);
    return stripTrailingSeparator(resolved);
}
export function stripTrailingSeparator(input) {
    return stripTrailingSeparatorWith(path, input);
}
export function historyBasename(input) {
    return historyPathApi(input).basename(input);
}
export function isHistoryPathAbsolute(input) {
    return historyPathApi(input).isAbsolute(input);
}
export function sameHistoryPath(left, right) {
    const api = historyPathApi(left, right);
    return comparableHistoryPath(left, api) === comparableHistoryPath(right, api);
}
export function normalizeHistoryPath(input, ...context) {
    const api = historyPathApi(input, ...context);
    const expanded = expandPath(input);
    const normalized = api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(expanded);
    return stripTrailingSeparatorWith(api, normalized);
}
export function stripTrailingSeparatorWith(api, input) {
    const parsed = api.parse(input);
    let output = input;
    while (output.length > parsed.root.length && output.endsWith(api.sep)) {
        output = output.slice(0, -1);
    }
    return output;
}
export function isSameOrInside(candidate, parent) {
    const api = historyPathApi(candidate, parent);
    const normalizedCandidate = comparableHistoryPath(candidate, api);
    const normalizedParent = comparableHistoryPath(parent, api);
    return (normalizedCandidate === normalizedParent ||
        normalizedCandidate.startsWith(`${normalizedParent}${api.sep}`));
}
export function remapPathPrefix(candidate, originalDir, targetDir) {
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
export function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
export function pathExists(filePath) {
    return fs.existsSync(filePath);
}
export function relativeFromCodexHome(codexHome, filePath) {
    const relative = path.relative(codexHome, filePath);
    return relative.startsWith("..") ? path.basename(filePath) : relative;
}
function historyPathApi(...values) {
    return values.some(isWindowsPathLike) ? path.win32 : path.posix;
}
function isWindowsPathLike(value) {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}
function normalizeHistoryPathWith(api, input) {
    const expanded = expandPath(input);
    const normalized = api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(expanded);
    return stripTrailingSeparatorWith(api, normalized);
}
function comparableHistoryPath(input, api) {
    const normalized = normalizeHistoryPathWith(api, input);
    return api === path.win32 ? normalized.toLowerCase() : normalized;
}
//# sourceMappingURL=paths.js.map