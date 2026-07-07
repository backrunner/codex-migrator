export type JsonObject = Record<string, unknown>;

export type MigrationMode = "provider" | "project" | "projects";

export interface GlobalOptions {
  codexHome: string;
  json: boolean;
  archived: boolean;
  yes: boolean;
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
  jsonlPlan?: JsonlMigrationPlan;
  onJsonlPlan?: (plan: JsonlMigrationPlan) => void;
  onProgress?: (event: ProgressEvent) => void;
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
  threadProjectHints: ThreadProjectHint[];
  projectChanges: Array<{
    fromCwd: string;
    toCwd: string;
    files: number;
    lines: number;
  }>;
  samples: FileChangeSample[];
}

export interface JsonlFileFingerprint {
  file: string;
  archived: boolean;
  size: bigint;
  mtimeNs: bigint;
}

export interface PlannedJsonlSession {
  session: SessionSummary;
  fingerprint: JsonlFileFingerprint;
}

export interface PlannedJsonlLineChange {
  index: number;
  line: string;
}

export interface PlannedJsonlFileChange {
  session: SessionSummary;
  fingerprint: JsonlFileFingerprint;
  changedLines: number;
  lineChanges: PlannedJsonlLineChange[];
  projectChanges: Array<{
    fromCwd: string;
    toCwd: string;
    lines: number;
  }>;
  sample: FileChangeSample;
}

export interface JsonlMigrationPlan {
  version: 1;
  codexHome: string;
  includeArchived: boolean;
  action: MigrationSpec;
  sessions: PlannedJsonlSession[];
  changes: PlannedJsonlFileChange[];
  result: JsonlMigrationResult;
}

export interface ThreadProjectHint {
  id: string;
  fromCwd: string;
  toCwd: string;
}

export interface ConfigMigrationResult {
  scannedFiles: number;
  matchedSections: number;
  changedSections: number;
  changedValues: number;
  projectChanges: Array<{
    fromCwd: string;
    toCwd: string;
    sections: number;
  }>;
  providerChanges: Array<{
    fromProvider: string;
    toProvider: string;
    sections: number;
    values: number;
  }>;
  samples: Array<{
    fromCwd?: string;
    toCwd?: string;
    fromProvider?: string;
    toProvider?: string;
  }>;
  skipped: boolean;
  reason?: string;
}

export interface JsonStateMigrationResult {
  scannedFiles: number;
  matchedFiles: number;
  changedFiles: number;
  changedKeys: number;
  changedValues: number;
  projectChanges: Array<{
    fromCwd: string;
    toCwd: string;
    entries: number;
  }>;
  samples: Array<{
    file: string;
    fromCwd: string;
    toCwd: string;
  }>;
}

export interface JsonStateInspectionResult {
  scannedFiles: number;
  pathKeys: number;
  pathValues: number;
  files: Array<{
    file: string;
    pathKeys: number;
    pathValues: number;
    parseError?: string;
  }>;
}

export interface SqliteMigrationResult {
  database: string;
  table: string;
  scannedRows: number;
  matchedRows: number;
  changedRows: number;
  insertedRows: number;
  projectChanges: Array<{
    fromCwd: string;
    toCwd: string;
    rows: number;
  }>;
  missingRolloutPaths: number;
  skipped: boolean;
  reason?: string;
}

export interface MigrationResult {
  ok: boolean;
  dryRun: boolean;
  action: MigrationSpec;
  codexHome: string;
  backupDir?: string;
  projects: ProjectMigrationSummary[];
  jsonl: JsonlMigrationResult;
  config: ConfigMigrationResult;
  state: JsonStateMigrationResult;
  sqlite: SqliteMigrationResult[];
  warnings: string[];
}

export interface ProjectMigrationSummary {
  fromCwd: string;
  toCwd: string;
  targetExists: boolean;
  jsonlFiles: number;
  configSections: number;
  stateEntries: number;
  sqliteRows: number;
}

export interface ProgressEvent {
  surface: "scan" | "jsonl" | "config" | "state" | "sqlite" | "restore";
  current: number;
  total: number;
  label: string;
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
  state: JsonStateInspectionResult;
  indexFiles: {
    history: {
      path: string;
      exists: boolean;
      entries: number;
    };
    sessionIndex: {
      path: string;
      exists: boolean;
      entries: number;
    };
  };
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
