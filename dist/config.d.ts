import type { ConfigMigrationResult, MigrationSpec } from "./types.js";
export declare function migrateConfigToml(codexHome: string, spec: MigrationSpec, options: {
    write: boolean;
    backupDir?: string;
}): ConfigMigrationResult;
export declare function transformConfigToml(content: string, spec: MigrationSpec): {
    content: string;
    matchedSections: number;
    changedSections: number;
    projectChanges: ConfigMigrationResult["projectChanges"];
    samples: ConfigMigrationResult["samples"];
};
