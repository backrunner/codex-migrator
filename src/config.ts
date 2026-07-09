import fs from "node:fs";
import path from "node:path";
import { ensureDir, relativeFromCodexHome, remapPathPrefix } from "./paths.js";
import { projectSourceDir } from "./jsonl.js";
import type {
  ConfigMigrationResult,
  MigrationSpec,
  ProviderMigrationSpec,
  SessionSummary,
} from "./types.js";

const MAX_SAMPLES = 10;
const OFFICIAL_MODEL_PROVIDERS = new Set(["openai"]);
const projectSectionPattern = /^\[projects\."((?:\\.|[^"\\])*)"\](\s*)$/;
const providerSectionPattern =
  /^\[model_providers\.((?:"(?:\\.|[^"\\])*")|(?:'(?:[^']*)')|(?:[A-Za-z0-9_-]+))\](\s*)$/;

export function migrateConfigToml(
  codexHome: string,
  spec: MigrationSpec,
  options: {
    write: boolean;
    backupDir?: string;
  },
): ConfigMigrationResult {
  const file = path.join(codexHome, "config.toml");

  if (!fs.existsSync(file)) {
    return emptyConfigResult(true, "config.toml not found");
  }

  const content = fs.readFileSync(file, "utf8");
  const migration = transformConfigToml(content, spec);

  if (options.write && (migration.changedSections > 0 || migration.changedValues > 0)) {
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
    changedValues: migration.changedValues,
    projectChanges: migration.projectChanges,
    providerChanges: migration.providerChanges,
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
  changedValues: number;
  projectChanges: ConfigMigrationResult["projectChanges"];
  providerChanges: ConfigMigrationResult["providerChanges"];
  samples: ConfigMigrationResult["samples"];
} {
  if (spec.mode === "provider") {
    return transformProviderConfigToml(content, spec);
  }

  return transformProjectConfigToml(content, spec);
}

function transformProjectConfigToml(
  content: string,
  spec: Exclude<MigrationSpec, { mode: "provider" }>,
): ReturnType<typeof transformConfigToml> {
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
    changedValues: 0,
    projectChanges: [...projectChanges.values()].sort((a, b) => a.fromCwd.localeCompare(b.fromCwd)),
    providerChanges: [],
    samples,
  };
}

function transformProviderConfigToml(
  content: string,
  spec: ProviderMigrationSpec,
): ReturnType<typeof transformConfigToml> {
  let matchedSections = 0;
  let changedSections = 0;
  let changedValues = 0;
  const samples: ConfigMigrationResult["samples"] = [];
  const sampleKeys = new Set<string>();
  const providerChanges = new Map<
    string,
    { fromProvider: string; toProvider: string; sections: number; values: number }
  >();
  const providerSections = new Map<
    number,
    {
      fromProvider: string;
      toProvider: string;
      suffix: string;
      style: TomlKeyStyle;
      matched: boolean;
      changed: boolean;
      remove: boolean;
    }
  >();
  const targetOwners = new Map<string, number>();
  const duplicateProviderSections = new Set<number>();
  const blocks = parseTomlBlocks(content);

  blocks.forEach((block, index) => {
    const header = block.lines[0];
    const match = providerSectionPattern.exec(header);
    if (!match) {
      return;
    }

    const key = parseTomlKey(match[1]);
    if (!key) {
      return;
    }

    const fromProvider = key.value;
    const matched = spec.fromProvider !== undefined && fromProvider === spec.fromProvider;
    const toProvider = matched ? spec.targetProvider : fromProvider;
    const remove =
      matched &&
      fromProvider !== toProvider &&
      !isOfficialModelProvider(fromProvider) &&
      isOfficialModelProvider(toProvider);
    const providerSection = {
      fromProvider,
      toProvider,
      suffix: match[2],
      style: key.style,
      matched,
      changed: matched && fromProvider !== toProvider,
      remove,
    };
    const previous = targetOwners.get(toProvider);
    if (previous !== undefined) {
      const previousSection = providerSections.get(previous);
      const currentIsCanonicalTarget = fromProvider === toProvider;
      const previousIsCanonicalTarget = previousSection?.fromProvider === previousSection?.toProvider;

      if (currentIsCanonicalTarget && !previousIsCanonicalTarget) {
        duplicateProviderSections.add(previous);
        targetOwners.set(toProvider, index);
      } else {
        duplicateProviderSections.add(index);
      }
    }

    if (previous === undefined) {
      targetOwners.set(toProvider, index);
    }

    providerSections.set(index, providerSection);

    if (!providerSection.matched) {
      return;
    }

    if (providerSection.changed) {
      addProviderSample(samples, sampleKeys, fromProvider, toProvider);
      const current = providerChanges.get(fromProvider) ?? {
        fromProvider,
        toProvider,
        sections: 0,
        values: 0,
      };
      current.sections += 1;
      providerChanges.set(fromProvider, current);
    }
  });

  for (const [index, section] of providerSections) {
    if (section.matched) {
      matchedSections += 1;
    }

    if (section.changed || section.remove || duplicateProviderSections.has(index)) {
      changedSections += 1;
    }
  }

  const lines = blocks.flatMap((block, index) => {
    if (duplicateProviderSections.has(index)) {
      return [];
    }

    const section = providerSections.get(index);
    if (section?.remove) {
      return [];
    }

    const outputLines =
      section?.changed
        ? [
            `[model_providers.${formatTomlKey(section.toProvider, section.style)}]${section.suffix}`,
            ...block.lines.slice(1),
          ]
        : block.lines;

    return outputLines.map((line, lineIndex) => {
      if (section?.changed && lineIndex > 0) {
        const replacedName = replaceTomlStringAssignment(line, "name", (value) =>
          value === section.fromProvider ? section.toProvider : undefined,
        );
        if (replacedName !== line) {
          changedValues += 1;
          incrementProviderValueChange(providerChanges, section.fromProvider, section.toProvider);
          return replacedName;
        }
      }

      const replacedModelProvider = replaceTomlStringAssignment(line, "model_provider", (value) => {
        if (value === spec.targetProvider) {
          return undefined;
        }

        if (spec.fromProvider === undefined) {
          return spec.targetProvider;
        }

        return value === spec.fromProvider ? spec.targetProvider : undefined;
      });

      if (replacedModelProvider !== line) {
        changedValues += 1;
        const fromProvider = parseTomlStringAssignmentValue(line, "model_provider") ?? spec.fromProvider;
        if (fromProvider) {
          addProviderSample(samples, sampleKeys, fromProvider, spec.targetProvider);
          incrementProviderValueChange(providerChanges, fromProvider, spec.targetProvider);
        }
      }

      return replacedModelProvider;
    });
  });

  return {
    content: lines.join("\n"),
    matchedSections,
    changedSections,
    changedValues,
    projectChanges: [],
    providerChanges: [...providerChanges.values()].sort((a, b) =>
      a.fromProvider.localeCompare(b.fromProvider),
    ),
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
    changedValues: 0,
    projectChanges: [],
    providerChanges: [],
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

type TomlKeyStyle = "bare" | "basic" | "literal";

function parseTomlKey(value: string): { value: string; style: TomlKeyStyle } | undefined {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return {
      value: unescapeTomlBasicString(value.slice(1, -1)),
      style: "basic",
    };
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return {
      value: value.slice(1, -1),
      style: "literal",
    };
  }

  if (isTomlBareKey(value)) {
    return {
      value,
      style: "bare",
    };
  }

  return undefined;
}

function formatTomlKey(value: string, preferredStyle: TomlKeyStyle): string {
  if (preferredStyle === "bare" && isTomlBareKey(value)) {
    return value;
  }

  if (preferredStyle === "literal" && !value.includes("'")) {
    return `'${value}'`;
  }

  return `"${escapeTomlBasicString(value)}"`;
}

function isTomlBareKey(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isOfficialModelProvider(provider: string): boolean {
  return OFFICIAL_MODEL_PROVIDERS.has(provider);
}

function replaceTomlStringAssignment(
  line: string,
  key: string,
  replacement: (value: string) => string | undefined,
): string {
  const parsed = parseTomlStringAssignment(line, key);
  if (!parsed) {
    return line;
  }

  const nextValue = replacement(parsed.value);
  if (nextValue === undefined || nextValue === parsed.value) {
    return line;
  }

  return `${parsed.prefix}${formatTomlString(nextValue, parsed.quote)}${parsed.suffix}`;
}

function parseTomlStringAssignmentValue(line: string, key: string): string | undefined {
  return parseTomlStringAssignment(line, key)?.value;
}

function parseTomlStringAssignment(
  line: string,
  key: string,
):
  | {
      prefix: string;
      value: string;
      quote: "\"" | "'";
      suffix: string;
    }
  | undefined {
  const escapedKey = escapeRegExp(key);
  const match = new RegExp(`^(\\s*${escapedKey}\\s*=\\s*)(?:"((?:\\\\.|[^"\\\\])*)"|'([^']*)')(\\s*(?:#.*)?)$`).exec(
    line,
  );
  if (!match) {
    return undefined;
  }

  if (match[2] !== undefined) {
    return {
      prefix: match[1],
      value: unescapeTomlBasicString(match[2]),
      quote: "\"",
      suffix: match[4],
    };
  }

  return {
    prefix: match[1],
    value: match[3],
    quote: "'",
    suffix: match[4],
  };
}

function formatTomlString(value: string, preferredQuote: "\"" | "'"): string {
  if (preferredQuote === "'" && !value.includes("'")) {
    return `'${value}'`;
  }

  return `"${escapeTomlBasicString(value)}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addProviderSample(
  samples: ConfigMigrationResult["samples"],
  sampleKeys: Set<string>,
  fromProvider: string,
  toProvider: string,
): void {
  if (sampleKeys.has(fromProvider) || samples.length >= MAX_SAMPLES) {
    return;
  }

  sampleKeys.add(fromProvider);
  samples.push({ fromProvider, toProvider });
}

function incrementProviderValueChange(
  providerChanges: Map<string, { fromProvider: string; toProvider: string; sections: number; values: number }>,
  fromProvider: string,
  toProvider: string,
): void {
  const current = providerChanges.get(fromProvider) ?? {
    fromProvider,
    toProvider,
    sections: 0,
    values: 0,
  };
  current.values += 1;
  providerChanges.set(fromProvider, current);
}
