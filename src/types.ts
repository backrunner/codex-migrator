export type JsonObject = Record<string, unknown>;

export type MigrationMode = "provider" | "project" | "projects";

export interface GlobalOptions {
  codexHome: string;
  json: boolean;
  archived: boolean;
}

export interface ProviderMigrationSpec {
  mode: "provider";
  targetProvider: string;
  fromProvider?: string;
}

export interface SingleProjectMigrationSpec {
  mode: "project";
  projectName: string;
  targetDir: string;
  fromDir?: string;
}

export interface ProjectsMigrationSpec {
  mode: "projects";
  originalDir: string;
  targetDir: string;
}

export type MigrationSpec =
  | ProviderMigrationSpec
  | SingleProjectMigrationSpec
  | ProjectsMigrationSpec;

export interface ExecutionOptions {
  write: boolean;
  codexHome: string;
  includeArchived: boolean;
  includeJsonl: boolean;
  includeSqlite: boolean;
  json: boolean;
}

export interface SessionSummary {
  file: string;
  id?: string;
  cwd?: string;
  modelProvider?: string;
  archived: boolean;
}

export interface FileChangeSample {
  file: string;
  id?: string;
  fromProvider?: string;
  toProvider?: string;
  fromCwd?: string;
  toCwd?: string;
}

export interface JsonlMigrationResult {
  scannedFiles: number;
  matchedFiles: number;
  changedFiles: number;
  changedLines: number;
  samples: FileChangeSample[];
}

export interface SqliteMigrationResult {
  database: string;
  table: string;
  scannedRows: number;
  matchedRows: number;
  changedRows: number;
  skipped: boolean;
  reason?: string;
}

export interface MigrationResult {
  ok: boolean;
  dryRun: boolean;
  action: MigrationSpec;
  codexHome: string;
  backupDir?: string;
  jsonl: JsonlMigrationResult;
  sqlite: SqliteMigrationResult[];
  warnings: string[];
}

export interface BackupListResult {
  ok: boolean;
  codexHome: string;
  backups: Array<{
    name: string;
    path: string;
    updatedAt: string;
    files: number;
  }>;
  warnings: string[];
}

export interface RestoreResult {
  ok: boolean;
  dryRun: boolean;
  codexHome: string;
  backupDir: string;
  restoredFiles: number;
  sqliteFiles: number;
  removedWalFiles: number;
  samples: Array<{
    from: string;
    to: string;
  }>;
  warnings: string[];
}

export interface DoctorResult {
  ok: boolean;
  codexHome: string;
  platform: {
    node: NodeJS.Platform;
    pathSeparator: string;
  };
  sqlite3Available: boolean;
  sessionsDir: {
    path: string;
    exists: boolean;
    files: number;
  };
  archivedSessionsDir: {
    path: string;
    exists: boolean;
    files: number;
  };
  sqlite: SqliteMigrationResult[];
  providers: Array<{ modelProvider: string; count: number }>;
  projects: Array<{ cwd: string; count: number }>;
  warnings: string[];
}
