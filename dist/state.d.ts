import type { JsonStateInspectionResult, JsonStateMigrationResult, MigrationSpec } from "./types.js";
export declare function discoverJsonStateFiles(codexHome: string): string[];
export declare function migrateJsonState(codexHome: string, spec: MigrationSpec, options: {
    write: boolean;
    backupDir?: string;
    onProgress?: (event: {
        surface: "state";
        current: number;
        total: number;
        label: string;
    }) => void;
}): JsonStateMigrationResult;
export declare function inspectJsonState(codexHome: string): JsonStateInspectionResult;
