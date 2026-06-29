import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, firstAncestorWithBasename, firstPathUnderParent, isSameOrInside, relativeFromCodexHome, resolvePath, remapPathPrefix, } from "./paths.js";
import { projectSourceDir, sessionMatches } from "./jsonl.js";
export function sqlite3Available() {
    try {
        execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
export function discoverSqliteCandidates(codexHome) {
    const stateDatabases = [
        path.join(codexHome, "state_5.sqlite"),
        path.join(codexHome, "sqlite", "state_5.sqlite"),
    ];
    const desktopDatabases = [
        path.join(codexHome, "codex-dev.db"),
        path.join(codexHome, "sqlite", "codex-dev.db"),
    ];
    return [
        ...stateDatabases.flatMap((database) => [
            { database, table: "threads" },
            { database, table: "agent_jobs" },
        ]),
        ...desktopDatabases.flatMap((database) => [
            { database, table: "local_thread_catalog" },
            { database, table: "automations" },
            { database, table: "automation_runs" },
        ]),
    ];
}
export function inspectSqlite(codexHome) {
    if (!sqlite3Available()) {
        return discoverSqliteCandidates(codexHome).map((candidate) => skipped(candidate, "sqlite3 not found on PATH"));
    }
    return discoverSqliteCandidates(codexHome).map((candidate) => {
        try {
            if (!fs.existsSync(candidate.database)) {
                return skipped(candidate, "database not found");
            }
            if (!tableExists(candidate.database, candidate.table)) {
                return skipped(candidate, "table not found");
            }
            const rows = readRows(candidate.database, candidate.table);
            return {
                database: candidate.database,
                table: candidate.table,
                scannedRows: rows.length,
                matchedRows: 0,
                changedRows: 0,
                insertedRows: 0,
                projectChanges: [],
                missingRolloutPaths: countMissingRolloutPaths(codexHome, candidate, rows),
                skipped: false,
            };
        }
        catch (error) {
            return skipped(candidate, sqliteErrorMessage(error));
        }
    });
}
export function sqliteWritePreflight(codexHome) {
    if (!sqlite3Available()) {
        return [];
    }
    const errors = [];
    for (const candidate of discoverSqliteCandidates(codexHome)) {
        try {
            if (!fs.existsSync(candidate.database)) {
                continue;
            }
            if (!tableExists(candidate.database, candidate.table)) {
                continue;
            }
            countRows(candidate.database, candidate.table);
        }
        catch (error) {
            errors.push(`${candidate.database}: ${sqliteErrorMessage(error)}`);
        }
    }
    return errors;
}
export function migrateSqlite(codexHome, spec, options) {
    if (!sqlite3Available()) {
        return discoverSqliteCandidates(codexHome).map((candidate) => skipped(candidate, "sqlite3 not found on PATH"));
    }
    const candidates = discoverSqliteCandidates(codexHome);
    const stateThreadRows = readStateThreadRows(codexHome);
    return candidates.map((candidate, index) => {
        options.onProgress?.({
            surface: "sqlite",
            current: index + 1,
            total: candidates.length,
            label: `${relativeFromCodexHome(codexHome, candidate.database)}:${candidate.table}`,
        });
        try {
            if (!fs.existsSync(candidate.database)) {
                return skipped(candidate, "database not found");
            }
            if (!tableExists(candidate.database, candidate.table)) {
                return skipped(candidate, "table not found");
            }
            const rows = readRows(candidate.database, candidate.table);
            const missingRolloutPaths = countMissingRolloutPaths(codexHome, candidate, rows);
            const threadHints = new Map((options.threadProjectHints ?? []).map((hint) => [hint.id, hint]));
            const updatePairs = rows.flatMap((row) => {
                const updated = updateForRow(candidate.table, row, spec, threadHints);
                return updated ? [{ before: row, after: updated }] : [];
            });
            const updates = updatePairs.map((pair) => pair.after);
            const insertPairs = candidate.table === "local_thread_catalog"
                ? desktopCatalogBackfillRows(codexHome, candidate.database, spec, rows, stateThreadRows, threadHints)
                : [];
            const inserts = insertPairs.map((pair) => pair.insert);
            const projectChanges = sqliteProjectChanges(candidate.table, spec, [
                ...updatePairs,
                ...insertPairs.map((pair) => ({ before: pair.source, after: pair.insert })),
            ], threadHints);
            if (options.write && (updates.length > 0 || inserts.length > 0)) {
                if (!options.backupDir) {
                    throw new Error("backupDir is required when writing SQLite changes");
                }
                backupSqlite(codexHome, options.backupDir, candidate.database);
                if (candidate.table === "local_thread_catalog") {
                    applyDesktopCatalogChanges(candidate.database, spec, updates, inserts);
                }
                else {
                    applyUpdates(candidate.database, candidate.table, spec, updates);
                }
            }
            return {
                database: candidate.database,
                table: candidate.table,
                scannedRows: rows.length,
                matchedRows: updates.length + inserts.length,
                changedRows: updates.length + inserts.length,
                insertedRows: inserts.length,
                projectChanges,
                missingRolloutPaths,
                skipped: false,
            };
        }
        catch (error) {
            if (options.write) {
                throw error;
            }
            return skipped(candidate, sqliteErrorMessage(error));
        }
    });
}
export function providerCounts(codexHome) {
    const rows = aggregateRows(codexHome);
    const counts = new Map();
    for (const row of rows) {
        if (!row.model_provider) {
            continue;
        }
        counts.set(row.model_provider, (counts.get(row.model_provider) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([modelProvider, count]) => ({ modelProvider, count }))
        .sort((a, b) => b.count - a.count || a.modelProvider.localeCompare(b.modelProvider));
}
export function projectCounts(codexHome) {
    const rows = aggregateRows(codexHome);
    const counts = new Map();
    for (const row of rows) {
        if (!row.cwd) {
            continue;
        }
        counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([cwd, count]) => ({ cwd, count }))
        .sort((a, b) => b.count - a.count || a.cwd.localeCompare(b.cwd));
}
function aggregateRows(codexHome) {
    if (!sqlite3Available()) {
        return [];
    }
    const rows = [];
    const seen = new Set();
    for (const candidate of discoverSqliteCandidates(codexHome)) {
        try {
            if (!isThreadCatalogTable(candidate.table)) {
                continue;
            }
            if (!fs.existsSync(candidate.database) || !tableExists(candidate.database, candidate.table)) {
                continue;
            }
            for (const row of readRows(candidate.database, candidate.table)) {
                const key = `${row.id}:${row.cwd}:${row.model_provider}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    rows.push(row);
                }
            }
        }
        catch {
            continue;
        }
    }
    return rows;
}
function updateForRow(table, row, spec, threadHints = new Map()) {
    if (table === "agent_jobs") {
        return updateAgentJobRow(row, spec);
    }
    if (table === "automations") {
        return updateAutomationRow(row, spec);
    }
    if (table === "automation_runs") {
        return updateAutomationRunRow(row, spec);
    }
    if (spec.mode === "provider") {
        if (!row.model_provider) {
            return undefined;
        }
        const shouldUpdate = row.model_provider !== spec.targetProvider &&
            (!spec.fromProvider || row.model_provider === spec.fromProvider);
        return shouldUpdate ? { ...row, model_provider: spec.targetProvider } : undefined;
    }
    if (!row.cwd) {
        return undefined;
    }
    const session = {
        file: "",
        id: row.id,
        cwd: row.cwd,
        modelProvider: row.model_provider,
        archived: false,
    };
    if (!sessionMatches(session, spec)) {
        const hinted = threadHints.get(row.id);
        if (!hinted) {
            return undefined;
        }
        return {
            ...row,
            cwd: hinted.toCwd,
            agent_path: row.agent_path
                ? remapPathPrefix(row.agent_path, hinted.fromCwd, hinted.toCwd) ?? row.agent_path
                : row.agent_path,
        };
    }
    const sourceDir = spec.mode === "projects" ? spec.originalDir : projectSourceDir(spec, session);
    if (!sourceDir) {
        return undefined;
    }
    const nextCwd = remapPathPrefix(row.cwd, sourceDir, spec.targetDir);
    const nextAgentPath = row.agent_path
        ? remapPathPrefix(row.agent_path, sourceDir, spec.targetDir)
        : undefined;
    if ((!nextCwd || nextCwd === row.cwd) && (!nextAgentPath || nextAgentPath === row.agent_path)) {
        return undefined;
    }
    return {
        ...row,
        cwd: nextCwd ?? row.cwd,
        agent_path: nextAgentPath ?? row.agent_path,
    };
}
function updateAgentJobRow(row, spec) {
    if (spec.mode === "provider") {
        return undefined;
    }
    const nextInput = row.input_csv_path
        ? remapGlobalPath(row.input_csv_path, spec)
        : undefined;
    const nextOutput = row.output_csv_path
        ? remapGlobalPath(row.output_csv_path, spec)
        : undefined;
    if ((!nextInput || nextInput === row.input_csv_path) &&
        (!nextOutput || nextOutput === row.output_csv_path)) {
        return undefined;
    }
    return {
        ...row,
        input_csv_path: nextInput ?? row.input_csv_path,
        output_csv_path: nextOutput ?? row.output_csv_path,
    };
}
function updateAutomationRow(row, spec) {
    if (spec.mode === "provider" || !row.cwds) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(row.cwds);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) {
        return undefined;
    }
    let changed = false;
    const nextCwds = parsed.map((cwd) => {
        if (typeof cwd !== "string") {
            return cwd;
        }
        const nextCwd = remapCwdLikePath(cwd, spec);
        if (nextCwd && nextCwd !== cwd) {
            changed = true;
            return nextCwd;
        }
        return cwd;
    });
    return changed ? { ...row, cwds: JSON.stringify(nextCwds) } : undefined;
}
function updateAutomationRunRow(row, spec) {
    if (spec.mode === "provider" || !row.source_cwd) {
        return undefined;
    }
    const nextSourceCwd = remapCwdLikePath(row.source_cwd, spec);
    if (!nextSourceCwd || nextSourceCwd === row.source_cwd) {
        return undefined;
    }
    return { ...row, source_cwd: nextSourceCwd };
}
function remapGlobalPath(candidate, spec) {
    return remapCwdLikePath(candidate, spec);
}
function remapCwdLikePath(candidate, spec) {
    if (spec.mode === "provider") {
        return undefined;
    }
    if (spec.mode === "projects") {
        return remapPathPrefix(candidate, spec.originalDir, spec.targetDir);
    }
    const session = {
        file: "",
        cwd: candidate,
        archived: false,
    };
    const sourceDir = projectSourceDir(spec, session);
    return sourceDir ? remapPathPrefix(candidate, sourceDir, spec.targetDir) : undefined;
}
function sqliteProjectChanges(table, spec, rows, threadHints) {
    if (spec.mode === "provider") {
        return [];
    }
    const changes = new Map();
    for (const row of rows) {
        const mapping = sqliteRowProjectMapping(table, spec, row.before, row.after, threadHints);
        if (!mapping) {
            continue;
        }
        const key = `${mapping.fromCwd}\0${mapping.toCwd}`;
        const current = changes.get(key) ?? { ...mapping, rows: 0 };
        current.rows += 1;
        changes.set(key, current);
    }
    return [...changes.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd));
}
function sqliteRowProjectMapping(table, spec, before, after, threadHints) {
    const hinted = isThreadCatalogTable(table) ? threadHints.get(after.id) : undefined;
    if (hinted) {
        return { fromCwd: hinted.fromCwd, toCwd: hinted.toCwd };
    }
    const beforeCandidate = before ? firstPathValue(before) : undefined;
    const afterCandidate = firstPathValue(after);
    if (!beforeCandidate && !afterCandidate) {
        return undefined;
    }
    if (spec.mode === "projects") {
        const fromCwd = (beforeCandidate ? firstPathUnderParent(beforeCandidate, spec.originalDir) : undefined) ??
            (afterCandidate ? remapTargetProjectToSource(afterCandidate, spec) : undefined);
        const toCwd = (afterCandidate ? firstPathUnderParent(afterCandidate, spec.targetDir) : undefined) ??
            (fromCwd ? remapPathPrefix(fromCwd, spec.originalDir, spec.targetDir) : undefined);
        return fromCwd && toCwd ? { fromCwd, toCwd } : undefined;
    }
    const fromCwd = spec.fromDir ??
        (beforeCandidate ? firstAncestorWithBasename(beforeCandidate, spec.projectName) : undefined) ??
        (afterCandidate && !isSameOrInside(afterCandidate, spec.targetDir)
            ? firstAncestorWithBasename(afterCandidate, spec.projectName)
            : undefined);
    if (!fromCwd) {
        return undefined;
    }
    return { fromCwd, toCwd: spec.targetDir };
}
function remapTargetProjectToSource(candidate, spec) {
    const targetProject = firstPathUnderParent(candidate, spec.targetDir);
    return targetProject ? remapPathPrefix(targetProject, spec.targetDir, spec.originalDir) : undefined;
}
function firstPathValue(row) {
    if (row.cwd) {
        return row.cwd;
    }
    if (row.agent_path) {
        return row.agent_path;
    }
    if (row.input_csv_path) {
        return row.input_csv_path;
    }
    if (row.output_csv_path) {
        return row.output_csv_path;
    }
    if (row.source_cwd) {
        return row.source_cwd;
    }
    if (row.cwds) {
        try {
            const parsed = JSON.parse(row.cwds);
            if (Array.isArray(parsed)) {
                return parsed.find((value) => typeof value === "string");
            }
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function tableExists(database, table) {
    const sql = `select count(*) as count from sqlite_master where type = 'table' and name = ${sqlString(table)};`;
    const rows = queryJson(database, sql);
    return rows[0]?.count === 1;
}
function countRows(database, table) {
    const rows = queryJson(database, `select count(*) as count from ${quoteIdentifier(table)};`);
    return rows[0]?.count ?? 0;
}
function readRows(database, table) {
    if (table === "agent_jobs") {
        return queryJson(database, `select id, input_csv_path, output_csv_path from ${quoteIdentifier(table)} order by id;`);
    }
    if (table === "automations") {
        return queryJson(database, `select id, cwds from ${quoteIdentifier(table)} order by id;`);
    }
    if (table === "automation_runs") {
        return queryJson(database, `select thread_id as id, source_cwd from ${quoteIdentifier(table)} order by thread_id;`);
    }
    const idColumn = table === "threads" ? "id" : "thread_id";
    const columns = tableColumns(database, table);
    const rolloutPathSelect = columns.has("rollout_path") ? ", rollout_path" : ", null as rollout_path";
    const agentPathSelect = columns.has("agent_path") ? ", agent_path" : ", null as agent_path";
    const localCatalogFilter = table === "local_thread_catalog" ? " where host_id = 'local'" : "";
    return queryJson(database, `select ${quoteIdentifier(idColumn)} as id, cwd, model_provider${rolloutPathSelect}${agentPathSelect} from ${quoteIdentifier(table)}${localCatalogFilter} order by ${quoteIdentifier(idColumn)};`);
}
function isThreadCatalogTable(table) {
    return table === "threads" || table === "local_thread_catalog";
}
function tableColumns(database, table) {
    const rows = queryJson(database, `pragma table_info(${quoteIdentifier(table)});`);
    return new Set(rows.map((row) => row.name));
}
function countMissingRolloutPaths(codexHome, candidate, rows) {
    if (candidate.table !== "threads") {
        return 0;
    }
    return rows.filter((row) => {
        if (!row.rollout_path) {
            return false;
        }
        return !fs.existsSync(resolvePath(row.rollout_path, codexHome));
    }).length;
}
function desktopCatalogBackfillRows(codexHome, catalogDatabase, spec, existingRows, stateThreadRows, threadHints) {
    const existingIds = new Set(existingRows.map((row) => row.id));
    const insertedIds = new Set();
    const observationBase = readCatalogObservationSequence(catalogDatabase);
    const inserts = [];
    for (const row of stateThreadRows) {
        if (existingIds.has(row.id) || insertedIds.has(row.id)) {
            continue;
        }
        const catalogRow = desktopCatalogRowForThread(codexHome, row, spec, observationBase + inserts.length + 1, threadHints);
        if (!catalogRow) {
            continue;
        }
        insertedIds.add(catalogRow.id);
        inserts.push({ source: row, insert: catalogRow });
    }
    return inserts;
}
function desktopCatalogRowForThread(codexHome, row, spec, observationSequence, threadHints) {
    const nextRow = threadRowAfterMigration(row, spec, threadHints);
    if (!nextRow?.cwd || !nextRow.model_provider) {
        return undefined;
    }
    if (row.has_preview === 0 || row.preview === "") {
        return undefined;
    }
    if (row.rollout_path && !fs.existsSync(resolvePath(row.rollout_path, codexHome))) {
        return undefined;
    }
    return {
        id: row.id,
        cwd: nextRow.cwd,
        model_provider: nextRow.model_provider,
        display_title: nonEmpty(row.title) ?? row.id,
        source_created_at: timestampForCatalog(row.created_at_ms, row.created_at),
        source_updated_at: timestampForCatalog(row.updated_at_ms, row.updated_at),
        source_kind: "local",
        source_detail: null,
        git_branch: row.git_branch ?? null,
        observation_sequence: observationSequence,
        missing_candidate: 0,
    };
}
function threadRowAfterMigration(row, spec, threadHints) {
    if (spec.mode === "provider") {
        const updated = updateForRow("threads", row, spec, threadHints);
        if (updated) {
            return updated;
        }
        return row.model_provider === spec.targetProvider ? row : undefined;
    }
    if (!row.cwd) {
        return undefined;
    }
    const session = {
        file: "",
        id: row.id,
        cwd: row.cwd,
        modelProvider: row.model_provider,
        archived: false,
    };
    if (sessionMatches(session, spec)) {
        return updateForRow("threads", row, spec, threadHints) ?? row;
    }
    const hinted = threadHints.get(row.id);
    if (hinted) {
        return { ...row, cwd: hinted.toCwd };
    }
    return isAlreadyAtTarget(row.cwd, spec) ? row : undefined;
}
function isAlreadyAtTarget(cwd, spec) {
    if (spec.mode === "provider") {
        return false;
    }
    return isSameOrInside(cwd, spec.targetDir);
}
function readStateThreadRows(codexHome) {
    const databases = [
        path.join(codexHome, "state_5.sqlite"),
        path.join(codexHome, "sqlite", "state_5.sqlite"),
    ];
    const rowsById = new Map();
    for (const database of databases) {
        if (!fs.existsSync(database)) {
            continue;
        }
        try {
            if (!tableExists(database, "threads")) {
                continue;
            }
            for (const row of readThreadSourceRows(database)) {
                const previous = rowsById.get(row.id);
                if (!previous || threadRowScore(row) >= threadRowScore(previous)) {
                    rowsById.set(row.id, row);
                }
            }
        }
        catch {
            continue;
        }
    }
    return [...rowsById.values()];
}
function readThreadSourceRows(database) {
    const columns = tableColumns(database, "threads");
    const selected = [
        "id",
        optionalColumn(columns, "rollout_path", "null"),
        optionalColumn(columns, "cwd", "null"),
        optionalColumn(columns, "model_provider", "null"),
        optionalColumn(columns, "title", "id"),
        optionalColumn(columns, "created_at", "0"),
        optionalColumn(columns, "updated_at", "0"),
        optionalColumn(columns, "created_at_ms", "null"),
        optionalColumn(columns, "updated_at_ms", "null"),
        optionalColumn(columns, "git_branch", "null"),
        columns.has("preview")
            ? "case when preview <> '' then 1 else 0 end as has_preview"
            : "1 as has_preview",
    ].join(", ");
    return queryJson(database, `select ${selected} from threads order by id;`);
}
function optionalColumn(columns, column, fallback) {
    return columns.has(column)
        ? quoteIdentifier(column)
        : `${fallback} as ${quoteIdentifier(column)}`;
}
function readCatalogObservationSequence(database) {
    let maxSequence = 0;
    try {
        const rows = queryJson(database, "select max(observation_sequence) as value from local_thread_catalog;");
        maxSequence = Math.max(maxSequence, Number(rows[0]?.value ?? 0));
    }
    catch {
        return maxSequence;
    }
    try {
        if (tableExists(database, "local_thread_catalog_sync_state")) {
            const rows = queryJson(database, "select max(observation_sequence) as value from local_thread_catalog_sync_state;");
            maxSequence = Math.max(maxSequence, Number(rows[0]?.value ?? 0));
        }
    }
    catch {
        return maxSequence;
    }
    return maxSequence;
}
function threadRowScore(row) {
    const timestamp = timestampForCatalog(row.updated_at_ms, row.updated_at);
    const previewBonus = row.has_preview || row.preview ? 1 : 0;
    const rolloutBonus = row.rollout_path ? 1 : 0;
    return timestamp * 100 + previewBonus * 10 + rolloutBonus;
}
function timestampForCatalog(ms, seconds) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
        return ms;
    }
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }
    return 0;
}
function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function applyUpdates(database, table, spec, updates) {
    const idColumn = idColumnForTable(table);
    const statements = [];
    if (table === "local_thread_catalog" && tableExists(database, "local_thread_catalog_metadata")) {
        statements.push([
            "insert into local_thread_catalog_metadata (id, catalog_revision) values (1, 1)",
            "on conflict(id) do update set catalog_revision = catalog_revision + 1;",
        ].join(" "));
    }
    statements.push(...updates.map((row) => updateStatementForRow(table, spec, row, idColumn)));
    execSql(database, ["begin immediate;", ...statements, "commit;"].join("\n"));
}
function applyDesktopCatalogChanges(database, spec, updates, inserts) {
    const statements = [];
    const idColumn = idColumnForTable("local_thread_catalog");
    if (tableExists(database, "local_thread_catalog_metadata")) {
        statements.push([
            "insert into local_thread_catalog_metadata (id, catalog_revision) values (1, 1)",
            "on conflict(id) do update set catalog_revision = catalog_revision + 1;",
        ].join(" "));
    }
    if (tableExists(database, "local_thread_catalog_hosts")) {
        statements.push("insert into local_thread_catalog_hosts (host_id, host_kind) values ('local', 'local') on conflict(host_id) do nothing;");
    }
    statements.push(...updates.map((row) => updateStatementForRow("local_thread_catalog", spec, row, idColumn)), ...inserts.map(insertDesktopCatalogStatement));
    if (inserts.length > 0 && tableExists(database, "local_thread_catalog_sync_state")) {
        const maxObservation = Math.max(...inserts.map((row) => row.observation_sequence ?? 0));
        statements.push([
            "insert into local_thread_catalog_sync_state",
            "(host_id, watermark_updated_at, initial_build_complete, observation_sequence)",
            `values ('local', null, 1, ${maxObservation})`,
            "on conflict(host_id) do update set",
            "initial_build_complete = 1,",
            "observation_sequence = max(observation_sequence, excluded.observation_sequence);",
        ].join(" "));
    }
    execSql(database, ["begin immediate;", ...statements, "commit;"].join("\n"));
}
function updateStatementForRow(table, spec, row, idColumn) {
    if (spec.mode === "provider" && isThreadCatalogTable(table) && row.model_provider) {
        return `update ${quoteIdentifier(table)} set model_provider = ${sqlString(row.model_provider)} where ${whereClauseForRow(table, idColumn, row)};`;
    }
    return `update ${quoteIdentifier(table)} set ${assignmentsForRow(table, row).join(", ")} where ${whereClauseForRow(table, idColumn, row)};`;
}
function whereClauseForRow(table, idColumn, row) {
    const idClause = `${quoteIdentifier(idColumn)} = ${sqlString(row.id)}`;
    return table === "local_thread_catalog"
        ? `host_id = 'local' and ${idClause}`
        : idClause;
}
function insertDesktopCatalogStatement(row) {
    return [
        "insert into local_thread_catalog",
        "(host_id, thread_id, display_title, source_created_at, source_updated_at, cwd,",
        "source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate)",
        "values",
        `(${[
            "'local'",
            sqlString(row.id),
            sqlString(row.display_title ?? row.id),
            sqlNumber(row.source_created_at ?? 0),
            sqlNumber(row.source_updated_at ?? 0),
            sqlString(row.cwd ?? ""),
            sqlString(row.source_kind ?? "local"),
            sqlNullableString(row.source_detail),
            sqlString(row.model_provider ?? ""),
            sqlNullableString(row.git_branch),
            sqlNumber(row.observation_sequence ?? 0),
            sqlNumber(row.missing_candidate ?? 0),
        ].join(", ")})`,
    ].join(" ") + ";";
}
function idColumnForTable(table) {
    return table === "threads" || table === "agent_jobs" || table === "automations"
        ? "id"
        : "thread_id";
}
function assignmentsForRow(table, row) {
    if (table === "threads" || table === "local_thread_catalog") {
        const assignments = row.cwd ? [`cwd = ${sqlString(row.cwd)}`] : [];
        if (table === "threads" && row.agent_path) {
            assignments.push(`agent_path = ${sqlString(row.agent_path)}`);
        }
        return assignments;
    }
    if (table === "agent_jobs") {
        return [
            row.input_csv_path ? `input_csv_path = ${sqlString(row.input_csv_path)}` : undefined,
            row.output_csv_path ? `output_csv_path = ${sqlString(row.output_csv_path)}` : undefined,
        ].filter((assignment) => assignment !== undefined);
    }
    if (table === "automations") {
        return row.cwds ? [`cwds = ${sqlString(row.cwds)}`] : [];
    }
    return row.source_cwd ? [`source_cwd = ${sqlString(row.source_cwd)}`] : [];
}
function queryJson(database, sql) {
    const stdout = execFileSync("sqlite3", ["-json", database], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
    });
    return stdout.trim() ? JSON.parse(stdout) : [];
}
function execSql(database, sql) {
    execFileSync("sqlite3", [database], {
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
    });
}
function backupSqlite(codexHome, backupDir, database) {
    const relative = relativeFromCodexHome(codexHome, database);
    const backupPath = path.join(backupDir, relative);
    ensureDir(path.dirname(backupPath));
    if (fs.existsSync(backupPath)) {
        return;
    }
    execSql(database, `vacuum into ${sqlString(backupPath)};`);
}
function skipped(candidate, reason) {
    return {
        database: candidate.database,
        table: candidate.table,
        scannedRows: 0,
        matchedRows: 0,
        changedRows: 0,
        insertedRows: 0,
        projectChanges: [],
        missingRolloutPaths: 0,
        skipped: true,
        reason,
    };
}
function sqliteErrorMessage(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    return error.message.replace(/\s+/g, " ").trim();
}
function sqlString(value) {
    return `'${value.replaceAll("'", "''")}'`;
}
function sqlNullableString(value) {
    return typeof value === "string" ? sqlString(value) : "null";
}
function sqlNumber(value) {
    return Number.isFinite(value) ? String(value) : "0";
}
function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
//# sourceMappingURL=sqlite.js.map