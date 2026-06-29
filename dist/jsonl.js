import fs from "node:fs";
import path from "node:path";
import { ensureDir, firstAncestorWithBasename, firstPathUnderParent, isHistoryPathAbsolute, isSameOrInside, relativeFromCodexHome, remapPathPrefix, } from "./paths.js";
const MAX_SAMPLES = 10;
export function discoverSessionFiles(codexHome, includeArchived, onProgress) {
    const roots = [
        { dir: path.join(codexHome, "sessions"), archived: false },
    ];
    if (includeArchived) {
        roots.push({ dir: path.join(codexHome, "archived_sessions"), archived: true });
    }
    const files = roots.flatMap(({ dir, archived }) => walkJsonl(dir).map((file) => ({ archived, file })));
    return files.map(({ file, archived }, index) => {
        onProgress?.({
            surface: "scan",
            current: index + 1,
            total: files.length,
            label: relativeFromCodexHome(codexHome, file),
        });
        return {
            ...readSessionSummary(file),
            archived,
            file,
        };
    });
}
export function countSessionFiles(dir) {
    return walkJsonl(dir).length;
}
export function migrateJsonlFiles(sessions, spec, options) {
    const result = {
        scannedFiles: sessions.length,
        matchedFiles: 0,
        changedFiles: 0,
        changedLines: 0,
        threadProjectHints: [],
        projectChanges: [],
        samples: [],
    };
    const sampleKeys = new Set();
    const threadHints = new Map();
    const projectChanges = new Map();
    sessions.forEach((session, index) => {
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
        const migration = transformJsonlContent(fs.readFileSync(session.file, "utf8"), spec, session);
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
        if (options.write) {
            if (!options.backupDir) {
                throw new Error("backupDir is required when writing JSONL changes");
            }
            backupFile(options.codexHome, options.backupDir, session.file);
            fs.writeFileSync(session.file, migration.content);
        }
    });
    result.threadProjectHints = [...threadHints.values()].sort((a, b) => a.id.localeCompare(b.id));
    result.projectChanges = [...projectChanges.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd));
    return result;
}
export function transformJsonlContent(content, spec, session) {
    const lines = content.split("\n");
    let changedLines = 0;
    let firstFromProvider;
    let firstFromCwd;
    let firstToCwd;
    const projectChanges = new Map();
    const transformed = lines.map((line) => {
        if (line.trim() === "") {
            return line;
        }
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return line;
        }
        const payload = asObject(parsed.payload);
        if (!payload) {
            return line;
        }
        let changed = false;
        if (spec.mode === "provider" && parsed.type === "session_meta") {
            const currentProvider = asString(payload.model_provider);
            const shouldUpdate = currentProvider !== spec.targetProvider &&
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
        return JSON.stringify(parsed);
    });
    const sample = {
        file: session.file,
        id: session.id,
    };
    if (spec.mode === "provider") {
        sample.fromProvider = firstFromProvider ?? session.modelProvider;
        sample.toProvider = spec.targetProvider;
    }
    else {
        const projectSample = projectSampleMapping(spec, session);
        sample.fromCwd = projectSample?.fromCwd ?? firstFromCwd ?? session.cwd;
        sample.toCwd = projectSample?.toCwd ?? firstToCwd;
    }
    return {
        content: transformed.join("\n"),
        changedLines,
        projectChanges: [...projectChanges.values()],
        sample,
    };
}
function addProjectChange(changes, spec, fromCwd, toCwd) {
    if (spec.mode === "provider") {
        return;
    }
    const roots = projectChangeRoots(spec, fromCwd, toCwd);
    const key = `${roots.fromCwd}\0${roots.toCwd}`;
    const current = changes.get(key) ?? { ...roots, lines: 0 };
    current.lines += 1;
    changes.set(key, current);
}
function projectChangeRoots(spec, fromCwd, toCwd) {
    if (spec.mode === "projects") {
        const fromRoot = firstPathUnderParent(fromCwd, spec.originalDir);
        const toRoot = fromRoot ? remapPathPrefix(fromRoot, spec.originalDir, spec.targetDir) : undefined;
        return fromRoot && toRoot ? { fromCwd: fromRoot, toCwd: toRoot } : { fromCwd, toCwd };
    }
    const fromRoot = projectSourceDirForPath(spec, fromCwd) ?? fromCwd;
    return { fromCwd: fromRoot, toCwd: spec.targetDir };
}
export function readSessionSummary(file) {
    const fd = fs.openSync(file, "r");
    const chunk = Buffer.alloc(128 * 1024);
    const chunks = [];
    const maxFirstLineBytes = 32 * 1024 * 1024;
    let offset = 0;
    try {
        let firstLine;
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
        const parsed = JSON.parse(firstLine);
        const payload = asObject(parsed.payload);
        if (parsed.type !== "session_meta" || !payload) {
            return {};
        }
        return {
            id: asString(payload.session_id) ?? asString(payload.id),
            cwd: asString(payload.cwd),
            modelProvider: asString(payload.model_provider),
        };
    }
    catch {
        return {};
    }
    finally {
        fs.closeSync(fd);
    }
}
export function sessionMatches(session, spec) {
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
export function projectSourceDir(spec, session) {
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
function projectSourceDirForPath(spec, candidate) {
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
function projectSampleMapping(spec, session) {
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
function fileChangeSampleKey(sample, spec) {
    if (spec.mode === "provider") {
        return `provider:${sample.id ?? sample.file}`;
    }
    return `project:${sample.fromCwd ?? sample.file}`;
}
function remapCwd(cwd, spec, session) {
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
function remapWorkspaceRoot(workspaceRoot, spec, session) {
    if (spec.mode === "projects") {
        return remapPathPrefix(workspaceRoot, spec.originalDir, spec.targetDir);
    }
    if (spec.mode !== "project") {
        return undefined;
    }
    const sourceDir = projectSourceDirForPath(spec, workspaceRoot) ?? projectSourceDir(spec, session);
    return sourceDir ? remapPathPrefix(workspaceRoot, sourceDir, spec.targetDir) : undefined;
}
function walkJsonl(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkJsonl(fullPath));
        }
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            out.push(fullPath);
        }
    }
    return out.sort();
}
function backupFile(codexHome, backupDir, file) {
    const relative = relativeFromCodexHome(codexHome, file);
    const backupPath = path.join(backupDir, relative);
    ensureDir(path.dirname(backupPath));
    fs.copyFileSync(file, backupPath);
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
//# sourceMappingURL=jsonl.js.map