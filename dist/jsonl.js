import fs from "node:fs";
import path from "node:path";
import { ensureDir, historyBasename, isHistoryPathAbsolute, relativeFromCodexHome, remapPathPrefix, sameHistoryPath, } from "./paths.js";
const MAX_SAMPLES = 10;
export function discoverSessionFiles(codexHome, includeArchived) {
    const roots = [
        { dir: path.join(codexHome, "sessions"), archived: false },
    ];
    if (includeArchived) {
        roots.push({ dir: path.join(codexHome, "archived_sessions"), archived: true });
    }
    return roots.flatMap(({ dir, archived }) => walkJsonl(dir).map((file) => ({
        ...readSessionSummary(file),
        archived,
        file,
    })));
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
        samples: [],
    };
    for (const session of sessions) {
        if (!sessionMatches(session, spec)) {
            continue;
        }
        result.matchedFiles += 1;
        const migration = transformJsonlContent(fs.readFileSync(session.file, "utf8"), spec, session);
        if (migration.changedLines === 0) {
            continue;
        }
        result.changedFiles += 1;
        result.changedLines += migration.changedLines;
        if (result.samples.length < MAX_SAMPLES) {
            result.samples.push(migration.sample);
        }
        if (options.write) {
            if (!options.backupDir) {
                throw new Error("backupDir is required when writing JSONL changes");
            }
            backupFile(options.codexHome, options.backupDir, session.file);
            fs.writeFileSync(session.file, migration.content);
        }
    }
    return result;
}
export function transformJsonlContent(content, spec, session) {
    const lines = content.split("\n");
    let changedLines = 0;
    let firstFromProvider;
    let firstFromCwd;
    let firstToCwd;
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
                    return remapWorkspaceRoot(root, spec, session) ?? root;
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
        sample.fromCwd = firstFromCwd ?? session.cwd;
        sample.toCwd = firstToCwd;
    }
    return {
        content: transformed.join("\n"),
        changedLines,
        sample,
    };
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
        if (spec.fromDir) {
            return sameHistoryPath(session.cwd, spec.fromDir);
        }
        if (isHistoryPathAbsolute(spec.projectName)) {
            return sameHistoryPath(session.cwd, spec.projectName);
        }
        return historyBasename(session.cwd) === spec.projectName;
    }
    return remapPathPrefix(session.cwd, spec.originalDir, spec.targetDir) !== undefined;
}
function remapCwd(cwd, spec, session) {
    if (spec.mode === "projects") {
        return remapPathPrefix(cwd, spec.originalDir, spec.targetDir);
    }
    if (spec.mode !== "project" || !sessionMatches(session, spec)) {
        return undefined;
    }
    if (!session.cwd) {
        return undefined;
    }
    return remapPathPrefix(cwd, session.cwd, spec.targetDir);
}
function remapWorkspaceRoot(workspaceRoot, spec, session) {
    if (spec.mode === "projects") {
        return remapPathPrefix(workspaceRoot, spec.originalDir, spec.targetDir);
    }
    if (spec.mode !== "project" || !session.cwd) {
        return undefined;
    }
    return remapPathPrefix(workspaceRoot, session.cwd, spec.targetDir);
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