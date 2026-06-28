import type { FileChangeSample, JsonlMigrationResult, MigrationSpec, SessionSummary } from "./types.js";
export declare function discoverSessionFiles(codexHome: string, includeArchived: boolean): SessionSummary[];
export declare function countSessionFiles(dir: string): number;
export declare function migrateJsonlFiles(sessions: SessionSummary[], spec: MigrationSpec, options: {
    write: boolean;
    codexHome: string;
    backupDir?: string;
}): JsonlMigrationResult;
export declare function transformJsonlContent(content: string, spec: MigrationSpec, session: SessionSummary): {
    content: string;
    changedLines: number;
    sample: FileChangeSample;
};
export declare function readSessionSummary(file: string): Omit<SessionSummary, "file" | "archived">;
export declare function sessionMatches(session: SessionSummary, spec: MigrationSpec): boolean;
