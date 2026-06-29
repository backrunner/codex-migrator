import fs from "node:fs";
import path from "node:path";
import { ensureDir, relativeFromCodexHome, remapPathPrefix } from "./paths.js";
import { projectSourceDir } from "./jsonl.js";
import type { ConfigMigrationResult, MigrationSpec, SessionSummary } from "./types.js";

const MAX_SAMPLES = 10;
const projectSectionPattern = /^\[projects\."((?:\\.|[^"\\])*)"\](\s*)$/;

export function migrateConfigToml(
  codexHome: string,
  spec: MigrationSpec,
  options: {
    write: boolean;
    backupDir?: string;
  },
): ConfigMigrationResult {
  const file = path.join(codexHome, "config.toml");

  if (spec.mode === "provider") {
    return emptyConfigResult(true, "provider migration does not affect config.toml");
  }

  if (!fs.existsSync(file)) {
    return emptyConfigResult(true, "config.toml not found");
  }

  const content = fs.readFileSync(file, "utf8");
  const migration = transformConfigToml(content, spec);

  if (options.write && migration.changedSections > 0) {
    if (!options.backupDir) {
      throw new Error("backupDir is required when writing config.toml changes");
    }

    backupFile(codexHome, options.backupDir, file);
    fs.writeFileSync(file, migration.content);
  }

  return {
    scannedFiles: 1,
    matchedSections: migration.matchedSections,
    changedSections: migration.changedSections,
    projectChanges: migration.projectChanges,
    samples: migration.samples,
    skipped: false,
  };
}

export function transformConfigToml(
  content: string,
  spec: MigrationSpec,
): {
  content: string;
  matchedSections: number;
  changedSections: number;
  projectChanges: ConfigMigrationResult["projectChanges"];
  samples: ConfigMigrationResult["samples"];
} {
  let matchedSections = 0;
  let changedSections = 0;
  const samples: ConfigMigrationResult["samples"] = [];
  const sampleKeys = new Set<string>();
  const projectChanges = new Map<string, { fromCwd: string; toCwd: string; sections: number }>();
  const projectSections = new Map<
    number,
    {
      fromCwd: string;
      toCwd: string;
      suffix: string;
      matched: boolean;
      changed: boolean;
    }
  >();
  const targetOwners = new Map<string, number>();
  const duplicateProjectSections = new Set<number>();
  const blocks = parseTomlBlocks(content);

  blocks.forEach((block, index) => {
    const header = block.lines[0];
    const match = projectSectionPattern.exec(header);
    if (!match) {
      return;
    }

    const fromCwd = unescapeTomlBasicString(match[1]);
    const remapped = remapProjectConfigPath(fromCwd, spec);
    const toCwd = remapped ?? fromCwd;
    const projectSection = {
      fromCwd,
      toCwd,
      suffix: match[2],
      matched: remapped !== undefined,
      changed: remapped !== undefined && remapped !== fromCwd,
    };
    const previous = targetOwners.get(toCwd);
    if (previous !== undefined) {
      const previousSection = projectSections.get(previous);
      const currentIsCanonicalTarget = fromCwd === toCwd;
      const previousIsCanonicalTarget = previousSection?.fromCwd === previousSection?.toCwd;

      if (currentIsCanonicalTarget && !previousIsCanonicalTarget) {
        duplicateProjectSections.add(previous);
        targetOwners.set(toCwd, index);
      } else {
        duplicateProjectSections.add(index);
      }
    }

    if (previous === undefined) {
      targetOwners.set(toCwd, index);
    }

    projectSections.set(index, projectSection);

    if (!projectSection.matched) {
      return;
    }

    if (!sampleKeys.has(fromCwd) && samples.length < MAX_SAMPLES) {
      sampleKeys.add(fromCwd);
      samples.push({ fromCwd, toCwd });
    }

    const key = `${fromCwd}\0${toCwd}`;
    const current = projectChanges.get(key) ?? { fromCwd, toCwd, sections: 0 };
    current.sections += 1;
    projectChanges.set(key, current);
  });

  for (const [index, section] of projectSections) {
    if (section.matched) {
      matchedSections += 1;
    }

    if (section.changed || duplicateProjectSections.has(index)) {
      changedSections += 1;
    }
  }

  const lines = blocks.flatMap((block, index) => {
    if (duplicateProjectSections.has(index)) {
      return [];
    }

    const section = projectSections.get(index);
    if (!section?.changed) {
      return block.lines;
    }

    return [
      `[projects."${escapeTomlBasicString(section.toCwd)}"]${section.suffix}`,
      ...block.lines.slice(1),
    ];
  });

  return {
    content: lines.join("\n"),
    matchedSections,
    changedSections,
    projectChanges: [...projectChanges.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd)),
    samples,
  };
}

function parseTomlBlocks(content: string): Array<{ lines: string[] }> {
  const lines = content.split("\n");
  const blocks: Array<{ lines: string[] }> = [];
  let current: string[] = [];

  for (const line of lines) {
    if (current.length > 0 && isTomlSectionHeader(line)) {
      blocks.push({ lines: current });
      current = [line];
      continue;
    }

    current.push(line);
  }

  blocks.push({ lines: current });
  return blocks;
}

function isTomlSectionHeader(line: string): boolean {
  return /^\[\[?[^\]]+\]\]?\s*$/.test(line);
}

function remapProjectConfigPath(projectPath: string, spec: MigrationSpec): string | undefined {
  if (spec.mode === "provider") {
    return undefined;
  }

  if (spec.mode === "projects") {
    return remapPathPrefix(projectPath, spec.originalDir, spec.targetDir);
  }

  const session: SessionSummary = {
    file: "",
    cwd: projectPath,
    archived: false,
  };
  const sourceDir = projectSourceDir(spec, session);
  return sourceDir ? remapPathPrefix(projectPath, sourceDir, spec.targetDir) : undefined;
}

function emptyConfigResult(skipped: boolean, reason?: string): ConfigMigrationResult {
  return {
    scannedFiles: 0,
    matchedSections: 0,
    changedSections: 0,
    projectChanges: [],
    samples: [],
    skipped,
    reason,
  };
}

function backupFile(codexHome: string, backupDir: string, file: string): void {
  const relative = relativeFromCodexHome(codexHome, file);
  const backupPath = path.join(backupDir, relative);
  ensureDir(path.dirname(backupPath));
  fs.copyFileSync(file, backupPath);
}

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\(["\\btnfr])/g, (_, escaped: string) => {
    switch (escaped) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      default:
        return escaped;
    }
  });
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r");
}
