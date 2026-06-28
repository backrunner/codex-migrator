import type { BackupListResult, RestoreResult } from "./types.js";
export declare function listBackups(codexHomeInput: string): BackupListResult;
export declare function restoreBackup(codexHomeInput: string, backupInput: string, options: {
    write: boolean;
}): RestoreResult;
