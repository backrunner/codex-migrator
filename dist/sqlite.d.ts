import type { MigrationSpec, SqliteMigrationResult } from "./types.js";
interface SqliteCandidate {
    database: string;
    table: "threads" | "local_thread_catalog";
}
export declare function sqlite3Available(): boolean;
export declare function discoverSqliteCandidates(codexHome: string): SqliteCandidate[];
export declare function inspectSqlite(codexHome: string): SqliteMigrationResult[];
export declare function sqliteWritePreflight(codexHome: string): string[];
export declare function migrateSqlite(codexHome: string, spec: MigrationSpec, options: {
    write: boolean;
    backupDir?: string;
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
