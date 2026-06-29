import type { FileChangeSample, JsonlMigrationResult, MigrationSpec, SessionSummary } from "./types.js";
export declare function discoverSessionFiles(codexHome: string, includeArchived: boolean, onProgress?: (event: {
    surface: "scan";
    current: number;
    total: number;
    label: string;
}) => void): SessionSummary[];
export declare function countSessionFiles(dir: string): number;
export declare function migrateJsonlFiles(sessions: SessionSummary[], spec: MigrationSpec, options: {
    write: boolean;
    codexHome: string;
    backupDir?: string;
    onProgress?: (event: {
        surface: "jsonl";
        current: number;
        total: number;
        label: string;
    }) => void;
}): JsonlMigrationResult;
export declare function transformJsonlContent(content: string, spec: MigrationSpec, session: SessionSummary): {
    content: string;
    changedLines: number;
    projectChanges: Array<{
        fromCwd: string;
        toCwd: string;
        lines: number;
    }>;
    sample: FileChangeSample;
};
export declare function readSessionSummary(file: string): Omit<SessionSummary, "file" | "archived">;
export declare function sessionMatches(session: SessionSummary, spec: MigrationSpec): boolean;
export declare function projectSourceDir(spec: MigrationSpec, session: Pick<SessionSummary, "cwd">): string | undefined;
