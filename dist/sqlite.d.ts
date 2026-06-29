import type { MigrationSpec, SqliteMigrationResult, ThreadProjectHint } from "./types.js";
type SqliteTable = "threads" | "local_thread_catalog" | "agent_jobs" | "automations" | "automation_runs";
interface SqliteCandidate {
    database: string;
    table: SqliteTable;
}
export declare function sqlite3Available(): boolean;
export declare function discoverSqliteCandidates(codexHome: string): SqliteCandidate[];
export declare function inspectSqlite(codexHome: string): SqliteMigrationResult[];
export declare function sqliteWritePreflight(codexHome: string): string[];
export declare function migrateSqlite(codexHome: string, spec: MigrationSpec, options: {
    write: boolean;
    backupDir?: string;
    threadProjectHints?: ThreadProjectHint[];
    onProgress?: (event: {
        surface: "sqlite";
        current: number;
        total: number;
        label: string;
    }) => void;
}): SqliteMigrationResult[];
export declare function providerCounts(codexHome: string): Array<{
    modelProvider: string;
    count: number;
}>;
export declare function projectCounts(codexHome: string): Array<{
    cwd: string;
    count: number;
}>;
export {};
