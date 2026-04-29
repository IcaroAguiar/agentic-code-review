#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { externalToolbelt } from "./lib/external-toolbelt.mjs";
import { normalizedGateSummary } from "./lib/gate-categories.mjs";

const startCwd = process.cwd();
const ignoredDirs = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function splitLines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean) : [];
}

function run(cmd, args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 24,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString?.().trim() || "",
      stderr: error.stderr?.toString?.().trim() || error.message,
    };
  }
}

function parseArgs(argv) {
  const roots = [];
  let discoverDepth = 3;
  let includeClean = false;
  let base = "";
  let head = "";
  let json = false;
  let configPath = "";
  let runExternalTools = false;
  let allowToolDownloads = false;
  let externalToolTimeoutMs = 60_000;
  const externalTools = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root" || arg === "--repo") {
      roots.push(resolve(argv[index + 1]));
      index += 1;
    } else if (arg.startsWith("--root=") || arg.startsWith("--repo=")) {
      roots.push(resolve(arg.split("=").slice(1).join("=")));
    } else if (arg === "--discover-depth") {
      discoverDepth = Number.parseInt(argv[index + 1] || "3", 10);
      index += 1;
    } else if (arg.startsWith("--discover-depth=")) {
      discoverDepth = Number.parseInt(arg.split("=")[1] || "3", 10);
    } else if (arg === "--include-clean") {
      includeClean = true;
    } else if (arg === "--run-external-tools") {
      runExternalTools = true;
    } else if (arg === "--allow-tool-downloads") {
      allowToolDownloads = true;
    } else if (arg === "--external-tool") {
      externalTools.push(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--external-tool=")) {
      externalTools.push(arg.split("=").slice(1).join("="));
    } else if (arg === "--external-tool-timeout-ms") {
      externalToolTimeoutMs = Number.parseInt(argv[index + 1] || "60000", 10);
      index += 1;
    } else if (arg.startsWith("--external-tool-timeout-ms=")) {
      externalToolTimeoutMs = Number.parseInt(arg.split("=").slice(1).join("=") || "60000", 10);
    } else if (arg === "--base") {
      base = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--base=")) {
      base = arg.split("=").slice(1).join("=");
    } else if (arg === "--head") {
      head = argv[index + 1] || "";
      index += 1;
    } else if (arg.startsWith("--head=")) {
      head = arg.split("=").slice(1).join("=");
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      configPath = resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--config=")) {
      configPath = resolve(arg.split("=").slice(1).join("="));
    }
  }

  return { roots, discoverDepth, includeClean, base, head, json, configPath, runExternalTools, allowToolDownloads, externalToolTimeoutMs, externalTools: externalTools.filter(Boolean) };
}

const defaultConfig = {
  rules: {},
  severities: {},
  thresholds: {
    largeFileLines: 500,
    veryLargeFileLines: 1000,
    largeRefactorLines: 800,
    largeRefactorChangedLines: 50,
    longFunctionLines: 80,
    veryLongFunctionLines: 140,
    highImportCount: 25,
    wideConstructorParams: 8,
  },
  ignorePaths: [],
  customQuestions: [],
  externalToolTimeoutMs: undefined,
};

function readJsonConfig(path) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid agentic-code-review config at ${path}: ${error.message}`);
  }
}

function findConfigPath(root, explicitPath) {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : "";
  const candidate = join(root, ".agentic-reviewrc.json");
  return existsSync(candidate) ? candidate : "";
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    rules: { ...(base.rules || {}), ...(override.rules || {}) },
    severities: { ...(base.severities || {}), ...(override.severities || {}) },
    thresholds: { ...(base.thresholds || {}), ...(override.thresholds || {}) },
    ignorePaths: [...(base.ignorePaths || []), ...(override.ignorePaths || [])],
    customQuestions: [...(base.customQuestions || []), ...(override.customQuestions || [])],
  };
}

function pathPatternToRegex(pattern) {
  const normalized = String(pattern || "").replace(/^\.\//, "");
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`(^|/)${escaped}($|/)`);
}

function gitRoot(path) {
  const result = run("git", ["rev-parse", "--show-toplevel"], path);
  return result.ok ? result.stdout : "";
}

function discoverGitRoots(path, maxDepth) {
  const directRoot = gitRoot(path);
  const found = new Set();
  if (directRoot) found.add(directRoot);

  function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.name === ".git")) {
      const root = gitRoot(dir);
      if (root) found.add(root);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      visit(join(dir, entry.name), depth + 1);
    }
  }

  visit(path, 0);
  return [...found];
}

function parseNameStatus(output) {
  return splitLines(output).map((line) => {
    const parts = line.split("\t");
    const rawStatus = parts[0] || "?";
    const status = rawStatus[0] || "?";
    const path = status === "R" || status === "C" ? parts[2] : parts[1];
    const previousPath = status === "R" || status === "C" ? parts[1] : undefined;
    return { path, status, previousPath };
  }).filter((entry) => entry.path);
}

function resolveBase(root, explicitBase) {
  if (explicitBase) return explicitBase;

  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  const candidates = [
    upstream.ok ? upstream.stdout : "",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const mergeBase = run("git", ["merge-base", "HEAD", candidate], root);
    if (mergeBase.ok && mergeBase.stdout) return mergeBase.stdout;
  }

  return "";
}

function changedFileEntries(root, base) {
  const baseRef = resolveBase(root, base);
  if (args.head) {
    const committedRange = baseRef ? `${baseRef}...${args.head}` : args.head;
    const committed = run("git", ["diff", "--name-status", committedRange], root);
    return parseNameStatus(committed.ok ? committed.stdout : "");
  }

  const committed = baseRef ? run("git", ["diff", "--name-status", `${baseRef}...HEAD`], root) : { ok: true, stdout: "" };
  const staged = run("git", ["diff", "--cached", "--name-status"], root);
  const unstaged = run("git", ["diff", "--name-status"], root);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], root);
  const entries = [
    ...parseNameStatus(committed.ok ? committed.stdout : ""),
    ...parseNameStatus(staged.ok ? staged.stdout : ""),
    ...parseNameStatus(unstaged.ok ? unstaged.stdout : ""),
    ...splitLines(untracked.ok ? untracked.stdout : "").map((path) => ({ path, status: "A" })),
  ];

  const byPath = new Map();
  for (const entry of entries) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

function parseChangedLines(diffOutput) {
  const linesByFile = new Map();
  let currentFile = "";

  for (const line of splitLines(diffOutput)) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).trim();
      currentFile = file === "/dev/null" ? "" : file.replace(/^b\//, "");
      if (currentFile && !linesByFile.has(currentFile)) linesByFile.set(currentFile, new Set());
      continue;
    }

    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match || !currentFile) continue;
    const start = Number.parseInt(match[1], 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    const target = linesByFile.get(currentFile) || new Set();
    for (let offset = 0; offset < count; offset += 1) {
      target.add(start + offset);
    }
    linesByFile.set(currentFile, target);
  }

  return linesByFile;
}

function mergeChangedLines(target, source) {
  for (const [file, lines] of source.entries()) {
    const existing = target.get(file) || new Set();
    for (const line of lines) existing.add(line);
    target.set(file, existing);
  }
}

function changedLineMap(root, base, entries) {
  const baseRef = resolveBase(root, base);
  const result = new Map();

  if (args.head) {
    const committedRange = baseRef ? `${baseRef}...${args.head}` : args.head;
    const committed = run("git", ["diff", "--unified=0", committedRange], root);
    if (committed.ok) mergeChangedLines(result, parseChangedLines(committed.stdout));
    for (const entry of entries) {
      if (entry.status === "A" && !result.has(entry.path)) {
        result.set(entry.path, null);
      }
    }
    return result;
  }

  if (baseRef) {
    const committed = run("git", ["diff", "--unified=0", `${baseRef}...HEAD`], root);
    if (committed.ok) mergeChangedLines(result, parseChangedLines(committed.stdout));
  }

  const staged = run("git", ["diff", "--cached", "--unified=0"], root);
  if (staged.ok) mergeChangedLines(result, parseChangedLines(staged.stdout));

  const unstaged = run("git", ["diff", "--unified=0"], root);
  if (unstaged.ok) mergeChangedLines(result, parseChangedLines(unstaged.stdout));

  for (const entry of entries) {
    if (entry.status === "A" && !result.has(entry.path)) {
      result.set(entry.path, null);
    }
  }

  return result;
}

function readFile(root, file) {
  if (args.head) {
    const result = run("git", ["show", `${args.head}:${file}`], root);
    return result.ok ? result.stdout : "";
  }

  const path = join(root, file);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isCode(file) {
  return /\.(astro|bash|c|cc|cjs|clj|cpp|cs|cts|dart|ex|exs|go|h|hpp|java|jl|js|jsx|kt|kts|lua|m|mm|mjs|mts|php|pl|prisma|py|r|rb|rs|scala|sh|sql|swift|ts|tsx|zsh)$/.test(file);
}

function isStructuredConfig(file) {
  return /\.(json|toml|ya?ml)$/.test(file) || /(^|\/)(Dockerfile|Makefile|Rakefile|Gemfile|go\.mod|Cargo\.toml|requirements.*\.txt|pyproject\.toml)$/.test(file);
}

function isGeneratedOrLocalArtifact(file) {
  return /(^|\/)(\.playwright-cli|playwright-report|test-results|coverage|dist|build)\//.test(file)
    || /(^|\/)\.vscode\//.test(file)
    || /(^|\/)docs\/ai\/screenshots\//.test(file)
    || /(^|\/)(vendor|third[-_]party|generated)\//i.test(file)
    || /\.(min|bundle)\.[cm]?[jt]sx?$/i.test(file)
    || /(^|\/)pdf(\.|js|js-dist|worker)/i.test(file);
}

function isAppendOnlyLedger(file) {
  return /(^|\/)(CHANGELOG|changelog|changeset|release-notes|releases?)(\.[\w-]+)?$/.test(file)
    || /(^|\/)(changelog|changesets|release-notes|releases?)\//i.test(file)
    || /(^|\/)src\/lib\/data\/changelog\.[cm]?[tj]sx?$/.test(file);
}

function isSqlOrMigration(file) {
  return /\.sql$/i.test(file) || /(^|\/)(migrations?|schema\.prisma)\//i.test(file);
}

function isContractLikeFile(file) {
  return /(^|\/)(contracts?|schemas?|dto|sdks?|openapi|graphql|proto)\//i.test(file)
    || /\.(contract|contracts|schema|schemas|dto|openapi|graphql|proto|client|sdk)\./i.test(file)
    || /(^|\/)(api-client|client-api|generated-client)\//i.test(file);
}

function isPublicBoundaryFile(file) {
  return isContractLikeFile(file)
    || /(^|\/)(presenters?|serializers?|mappers?|transformers?|responses?|resources?)\//i.test(file)
    || /\.(presenter|serializer|mapper|transformer|response|resource)\./i.test(file)
    || /\b(public|external|client|api|response|resource|contract|view-model|viewmodel)\b/i.test(file);
}

function isTest(file) {
  return /(^|\/)(__tests__|tests?|e2e|specs?|features?)\//.test(file)
    || /\.(spec|test|e2e)\.[cm]?[tj]sx?$/.test(file)
    || /^test_.*\.py$/.test(basename(file))
    || /_test\.(py|go|exs)$/.test(basename(file))
    || /(Test|Tests|Spec|Specs)\.(java|kt|kts|cs|scala|php|swift)$/.test(basename(file))
    || /_(spec|test)\.rb$/.test(file)
    || /_spec\.rb$/.test(file)
    || /\.feature$/.test(file);
}

function addFinding(findings, rule, severity, repo, file, line, text, suggestion) {
  findings.push({
    rule,
    severity,
    repo,
    file,
    line,
    text: String(text || "").trim().slice(0, 260),
    suggestion,
  });
}

function shouldScanLine(repo, file, line) {
  const changedLines = repo.changedLines?.get(file);
  if (changedLines === null) return true;
  if (!changedLines) return false;
  return changedLines.has(line);
}

function windowTouchesChangedLine(repo, file, startLine, lineCount) {
  const changedLines = repo.changedLines?.get(file);
  if (changedLines === null) return true;
  if (!changedLines) return false;
  for (let offset = 0; offset < lineCount; offset += 1) {
    if (changedLines.has(startLine + offset)) return true;
  }
  return false;
}

function changedLineCount(repo, file) {
  const changedLines = repo.changedLines?.get(file);
  if (changedLines === null) return Number.POSITIVE_INFINITY;
  return changedLines?.size || 0;
}

function compressFindings(findings) {
  const byKey = new Map();
  for (const finding of findings) {
    const key = [finding.repo, finding.rule, finding.severity, finding.file, finding.text, finding.suggestion].join("\0");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding, count: 1, lines: [finding.line] });
      continue;
    }
    existing.count += 1;
    existing.lines.push(finding.line);
  }

  return [...byKey.values()].map((finding) => {
    if (finding.count === 1) return finding;
    const uniqueLines = [...new Set(finding.lines)].slice(0, 8).join(", ");
    return {
      ...finding,
      line: uniqueLines || finding.line,
      text: `${finding.text} (${finding.count} occurrences${uniqueLines ? `; lines ${uniqueLines}` : ""})`,
    };
  });
}

function existingFiles(root, entries) {
  if (args.head) {
    return entries
      .filter((entry) => entry.status !== "D")
      .map((entry) => entry.path)
      .filter((file) => !isGeneratedOrLocalArtifact(file));
  }

  return entries.map((entry) => entry.path).filter((file) => existsSync(join(root, file)) && !isGeneratedOrLocalArtifact(file));
}

function stripInlineNoise(line) {
  return line.replace(/\/\/.*$/, "").replace(/#.*$/, "").trim();
}

function hasLocalLiteral(line) {
  return /(["'`])(?:\/Users\/|\/home\/|\/tmp\/|\/var\/folders\/|C:\\|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?)/.test(line)
    || /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(line);
}

function scanText(repo) {
  const findings = [];
  const literalCounts = new Map();
  const literalLocations = new Map();
  const helperFunctions = new Map();
  const ignoredDuplicatedLiterals = new Set([
    "true",
    "false",
    "null",
    "undefined",
    "id",
    "name",
    "type",
    "status",
    "tenantId",
    "userId",
    "orgId",
    "createdAt",
    "updatedAt",
    "deletedAt",
  ]);

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) || isStructuredConfig(value))) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const extension = extname(file);
    const testFileForFile = isTest(file);

    if (isCode(file) && !testFileForFile && changedLineCount(repo, file) > 0) {
      for (const match of text.matchAll(/\bfunction\s+([a-z][A-Za-z0-9_$]*)\s*\([^)]*\)\s*{|(?:const|let)\s+([a-z][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g)) {
        const name = match[1] || match[2];
        if (!name) continue;
        const record = helperFunctions.get(name) || { files: new Set(), lines: [] };
        record.files.add(file);
        record.lines.push({ file, line: lineForFirstOccurrence(text, match[0]) });
        helperFunctions.set(name, record);
      }
    }

    if (isCode(file) && !testFileForFile && changedLineCount(repo, file) > 0 && /\bisError\b/.test(text) && /\b\w+\.isError\b/.test(text) && /catch\s*(?:\([^)]*\))?\s*{[\s\S]{0,700}return\s+null\s*;/.test(text)) {
      findings.push({
        rule: "error-state-masked-by-null-fallback",
        severity: "medium",
        repo: repo.name,
        file,
        line: lineForFirstOccurrence(text, "return null"),
        text: "A catch block returns null while the file still derives UI error state from query.isError/isError.",
        suggestion: "Choose one explicit strategy: treat null as an expected per-item fallback and remove unreachable/global error UI, or return an explicit result status so partial/total failures remain visible.",
      });
    }

    if (isCode(file) && !testFileForFile && changedLineCount(repo, file) > 0 && /(patch|branding|changed|merge|draft|persisted)/i.test(file + text)) {
      const undefinedSentinelWindows = [...text.matchAll(/\breturn\s+undefined\s*;/g)]
        .map((match) => text.slice(Math.max(0, match.index - 700), Math.min(text.length, match.index + 700)))
        .filter((window) => /(patch|branding|changed|merge|draft|persisted|apply[A-Za-z0-9_]*Patch|buildChangedValue|deepMerge|mergeDeep)/i.test(file + window));
      if (undefinedSentinelWindows.length > 0 && /!==\s*undefined|===\s*undefined/.test(text) && !/\bNO_CHANGE\b|Symbol\s*\(\s*["'`]NO_CHANGE|noChange/i.test(text)) {
        findings.push({
          rule: "patch-undefined-no-change-ambiguity",
          severity: "medium",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "return undefined"),
          text: "Patch code appears to use undefined both as a real value and as the internal no-change sentinel.",
          suggestion: "Use an explicit NO_CHANGE sentinel or a documented null/delete semantics so removals of optional nested fields cannot be silently omitted.",
        });
      }

      if (/apply[A-Za-z0-9_]*Patch|deepMerge|mergeDeep|Object\.assign|{[\s\S]{0,80}\.\.\./.test(text)
        && /undefined|null|optional|\?/.test(text)
        && !/\b(delete|DELETE|NO_CHANGE|REMOVE|unset|clear|tombstone|JsonNull|DbNull)\b/.test(text)) {
        findings.push({
          rule: "deep-merge-without-removal-semantics",
          severity: "low",
          repo: repo.name,
          file,
          line: "-",
          text: "Patch/merge code handles nested optional data but no obvious delete/null/tombstone semantics were detected.",
          suggestion: "Document and test removal semantics for optional nested fields; deep merge alone usually preserves stale values.",
        });
      }
    }

    if (isCode(file) && !testFileForFile && changedLineCount(repo, file) > 0 && /\.tsx?$/.test(file)) {
      if (/activeTab\s*={0,2}\s*["'`]settings|activeTab[\s\S]{0,120}settings/.test(text)
        && /ShowcasePreview[\s\S]{0,900}onSectionsChange\s*=\s*{\s*onSectionsChange\s*}/.test(text)
        && !/\breadOnly\b|mode\s*=\s*["'`](runtime-preview|readonly|readOnly)|noop/i.test(text)) {
        findings.push({
          rule: "preview-tab-passes-edit-callback",
          severity: "medium",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "onSectionsChange"),
          text: "A settings/appearance preview appears to pass the real structural onSectionsChange callback to ShowcasePreview.",
          suggestion: "Use a readOnly/runtime-preview mode or a noop callback when rendering appearance-only previews.",
        });
      }

      if (/\biconLibrary\b/.test(text)
        && /\b(phosphor|heroicons|tabler|remix)\b/i.test(text)
        && /\b(iconPath|<svg|<path|d=)/.test(text)
        && !/(from\s+["'`][^"'`]*(phosphor|heroicons|tabler|remix)|lucide-react|@tabler\/icons|react-icons)/i.test(text)) {
        findings.push({
          rule: "simulated-icon-library-contract",
          severity: "medium",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "iconLibrary"),
          text: "Icon library values appear to be simulated with a shared manual SVG/path rather than real library adapters.",
          suggestion: "Either rename the contract to visual style semantics or implement real adapters for each promised icon library.",
        });
      }

      const enumLikeFields = /\b(iconLibrary|iconStyle|hoverEffect|activeEffect|transitionPreset|itemRadius|height|searchStyle|actionStyle)\b/.test(text);
      if (enumLikeFields
        && /\b(normalize|sanitize)[A-Za-z0-9_]*Appearance\b/.test(text)
        && !/\b(normalizeEnum|allowed[A-Za-z0-9_]*\.includes|\.includes\s*\(|Set\s*\(|\.has\s*\()/.test(text)) {
        findings.push({
          rule: "enum-field-without-membership-normalization",
          severity: "medium",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "normalize"),
          text: "Appearance enum-like fields are normalized/sanitized without an obvious membership check against allowed values.",
          suggestion: "Use a normalizeEnum(value, allowedValues, fallback) helper for every API-provided visual enum.",
        });
      }

      if (/style\s*=\s*{{|--[a-z0-9-]+["']?\s*:/.test(text)
        && /\b(sidebar|header|appearance|branding)\.[A-Za-z0-9_.?]+/.test(text)
        && /\b(backgroundColor|gradient|radius|border|hover|active|backgroundImage|backgroundImageUrl)\b/.test(text)
        && !/\b(normalizeColorToken|normalizeGradientToken|normalizeRadiusToken|normalizeCssLengthToken|sanitizeCss|safeCss|cssToken)\b/.test(text)) {
        findings.push({
          rule: "unsanitized-branding-css-token",
          severity: "medium",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "style="),
          text: "Branding/appearance values appear to flow into inline styles or CSS custom properties without an obvious visual-token normalizer.",
          suggestion: "Centralize token validators such as normalizeColorToken, normalizeGradientToken, normalizeRadiusToken, and normalizeCssLengthToken before applying CSS.",
        });
      }

      if (/\bbackgroundColor\b[\s\S]{0,180}\.includes\s*\(\s*["'`]gradient\(|gradient\([\s\S]{0,180}\bbackgroundColor\b/.test(text)
        && !/\bbackgroundType\b|\bbackgroundGradient\b|\bgradientFrom\b|\bgradientTo\b/.test(text)) {
        findings.push({
          rule: "background-color-carries-gradient",
          severity: "low",
          repo: repo.name,
          file,
          line: lineForFirstOccurrence(text, "backgroundColor"),
          text: "A field named backgroundColor appears to carry gradient semantics.",
          suggestion: "Isolate this in an adapter or evolve the contract toward backgroundType plus explicit color/gradient/image fields.",
        });
      }
    }

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const trimmed = lineText.trim();
      const codeLike = stripInlineNoise(lineText);
      if (!isTest(file) && /^\/\/\s*(?:\d+[).]\s*)?/.test(trimmed) && /\b(busca|buscar|filtra|filtrar|mapeia|mapear|retorna|retornar|chama|chamar|cria|criar|atualiza|atualizar|remove|remover|get|fetch|filter|map|return|call|create|update|delete)\b/i.test(trimmed)) {
        addFinding(
          findings,
          "implementation-narrating-comment",
          "low",
          repo.name,
          file,
          line,
          lineText,
          "Remove comments that only narrate implementation, or replace them with the business invariant, edge case, or non-obvious reason the code exists."
        );
      }
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (!shouldScanLine(repo, file, line)) return;

      if (/\bany\b|as\s+any|unknown\s+as\s+|typing\.Any\b|interface\s*{}\s*$|map\[string\]interface\s*{}/.test(lineText)) {
        addFinding(findings, "unsafe-typing", isTest(file) ? "low" : "medium", repo.name, file, line, lineText, "Validate and narrow at the boundary instead of using unsafe or overly broad types.");
      }

      const oneLineSwallowedError = /catch\s*(\([^)]*\))?\s*{\s*}$/.test(lineText) || /except\s+[^:]*:\s*pass\s*$/.test(lineText);
      if (oneLineSwallowedError) {
        addFinding(findings, "swallowed-error", "high", repo.name, file, line, lineText, "Handle the error, rethrow with context, or log safe structured context.");
      }

      if (/catch\s*(\([^)]*\))?\s*{\s*$/.test(trimmed)) {
        const nextNonBlank = lines.slice(index + 1).find((candidate) => candidate.trim());
        if (nextNonBlank?.trim() === "}") {
          addFinding(findings, "swallowed-error", "high", repo.name, file, line, lineText, "Handle the error, rethrow with context, or log safe structured context.");
        }
      }

      if (!oneLineSwallowedError && /except\s+[^:]*:\s*$/.test(trimmed)) {
        const nextNonBlank = lines.slice(index + 1).find((candidate) => candidate.trim());
        if (nextNonBlank && /^(pass|return\s+None|return|continue)$/.test(nextNonBlank.trim())) {
          addFinding(findings, "swallowed-error", "high", repo.name, file, line, lineText, "Handle the exception with contextual recovery, rethrow, or safe logging.");
        }
      }

      if (/\b(console\.log|debugger|fmt\.Println|print\(|println!|System\.out\.println|puts\s+)/.test(lineText) && !isTest(file)) {
        addFinding(findings, "debug-artifact", "low", repo.name, file, line, lineText, "Remove debug artifacts or replace with structured project logging when intended.");
      }

      if (/\bconsole\.warn\s*\(/.test(lineText) && !isTest(file)) {
        addFinding(findings, "direct-console-warning", "low", repo.name, file, line, lineText, "Use a project logging/telemetry adapter or a small reporting helper instead of direct console.warn in production data/render flows.");
      }

      if (hasLocalLiteral(lineText)) {
        addFinding(
          findings,
          "local-literal-path-or-url",
          isTest(file) ? "low" : "medium",
          repo.name,
          file,
          line,
          lineText,
          "Avoid hardcoded local paths, localhost URLs, and machine-specific literals in committed code. Use config, temp-dir helpers, fixtures, or documented test harness values."
        );
      }

      if (/\.(only|skip)\s*\(|\b(skip|xit|xdescribe)\s*\(|@pytest\.mark\.skip|t\.Skip\(|describe\.skip/.test(lineText)) {
        addFinding(findings, "test-focus-artifact", "high", repo.name, file, line, lineText, "Remove committed focused or skipped tests unless explicitly justified.");
      }

      const testFile = isTest(file);
      const domainLiteralPattern = /\b(status|state|type|kind|role|permission|scope|event|action|mode|category|report|flag|code|queue|topic|channel|provider|source|target|operation|responseMode|reportKind)\b/i;
      const typeGuardLiteral = /\btypeof\b.*["'`](string|number|boolean|object|function|undefined|symbol|bigint)["'`]/.test(codeLike);
      if (!typeGuardLiteral && /\b(if|elif|while|for|switch|case|when|return|match|guard)\b.*["'`][A-Za-z0-9_./:-]{3,}["'`]/.test(codeLike)) {
        const severity = testFile && !domainLiteralPattern.test(codeLike) ? "low" : "medium";
        const suggestion = testFile
          ? "Test literals are acceptable when they clarify a scenario. Centralize them when they duplicate domain contracts, public statuses, roles, events, report kinds, or production vocabulary."
          : "Move repeated or logic-bearing strings behind named constants, enums, schemas, or typed value objects.";
        addFinding(findings, "magic-string", severity, repo.name, file, line, lineText, suggestion);
      }

      if (/\b(if|elif|while|for|switch|case|when|return|match|guard)\b.*(?<![\w.])-?\d{2,}(?![\w.])/.test(codeLike)) {
        addFinding(findings, "magic-number", testFile ? "low" : "medium", repo.name, file, line, lineText, "Name non-obvious numeric thresholds with constants.");
      }

      if (/\b(boolean|bool)\b|:\s*boolean|:\s*bool|=\s*(false|true|False|True)\b/.test(lineText) && /\bmode|flag|skip|force|silent|dryRun|strict|admin|enabled|disabled\b/i.test(lineText)) {
        addFinding(findings, "boolean-mode-flag", "low", repo.name, file, line, lineText, "Consider explicit options or separate functions when the flag changes behavior materially.");
      }

      const strings = [...lineText.matchAll(/["'`]([A-Za-z0-9_./:-]{4,})["'`]/g)].map((match) => match[1]);
      for (const value of strings) {
        if (/^(http|https):/.test(value)) continue;
        if (extension === ".json" || extension === ".lock") continue;
        if (isSqlOrMigration(file)) continue;
        if (isAppendOnlyLedger(file)) continue;
        if (ignoredDuplicatedLiterals.has(value)) continue;
        const key = `${value}`;
        const record = literalCounts.get(key) || { count: 0, files: new Set() };
        record.count += 1;
        record.files.add(file);
        literalCounts.set(key, record);
        const locations = literalLocations.get(key) || { prod: new Set(), tests: new Set() };
        if (testFile) locations.tests.add(file);
        else locations.prod.add(file);
        literalLocations.set(key, locations);
      }
    });
  }

  for (const [literal, record] of literalCounts.entries()) {
    if (record.count >= 4 && literal.length >= 4) {
      const locations = literalLocations.get(literal) || { prod: new Set(), tests: new Set() };
      const crossesProdAndTests = locations.prod.size > 0 && locations.tests.size > 0;
      const prodOnly = locations.prod.size > 0 && locations.tests.size === 0;
      findings.push({
        rule: "duplicated-literal",
        severity: crossesProdAndTests || prodOnly ? "medium" : "low",
        repo: repo.name,
        file: "(multiple)",
        line: "-",
        text: `${record.count} occurrences of "${literal}" across ${record.files.size} file(s); prod files: ${locations.prod.size}; test files: ${locations.tests.size}`,
        suggestion: crossesProdAndTests
          ? "This duplicated literal appears in production and tests. Prefer a canonical constant, enum, schema, fixture helper, or public contract import."
          : "Check whether this should be centralized as a named constant, enum, schema, fixture, or helper.",
      });
    }
  }

  for (const [name, record] of helperFunctions.entries()) {
    if (record.files.size < 2) continue;
    const locations = record.lines.map((entry) => `${entry.file}:${entry.line}`).join(", ");
    findings.push({
      rule: "duplicated-helper-function",
      severity: "low",
      repo: repo.name,
      file: "(multiple)",
      line: "-",
      text: `Helper function "${name}" appears in ${record.files.size} changed production files: ${locations}`,
      suggestion: "If this helper encodes a domain/UI convention, extract it to a shared local helper near the owning module to avoid future divergence.",
    });
  }

  return findings;
}

function javascriptMockModules(text) {
  return [...text.matchAll(/\b(?:vi|jest)\.mock\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
}

function javascriptImportedModules(text) {
  const modules = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) modules.add(match[1]);
  }
  return modules;
}

function lineForFirstOccurrence(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return "-";
  return text.slice(0, index).split(/\r?\n/).length;
}

function queryPatternForLine(line) {
  const patterns = [
    /\b(await\s+)?[\w.$]+\.(findMany|findFirst|findUnique|findOne|find|findAll|count|aggregate|groupBy|where|select|insert|save|filter|all|one|first|query)\s*\(/,
    /\b(session|db|repo|repository|client|prisma|knex|sequelize|mongoose|typeorm|entityManager|em|ActiveRecord|Repo)\b.*\.(query|execute|find|findAll|findOne|where|filter|select|get|all|one|first|save|create|update|delete)\s*\(/i,
    /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
    /\b(objects\.(filter|get|create)|Repo\.(all|get|insert|update|delete)|DB::table|Model::where)\b/,
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function readQueryPatternForLine(line) {
  const patterns = [
    /\b(await\s+)?[\w.$]+\.(findMany|findFirst|findUnique|findOne|find|findAll|count|aggregate|groupBy|where|select|get|filter|all|one|first|query)\s*\(/,
    /\b(session|db|repo|repository|client|prisma|knex|sequelize|mongoose|typeorm|entityManager|em|ActiveRecord|Repo)\b.*\.(query|execute|find|findAll|findOne|where|filter|select|get|all|one|first)\s*\(/i,
    /\bSELECT\s+.+\s+FROM\b/i,
    /\b(objects\.(filter|get)|Repo\.(all|get)|DB::table|Model::where)\b/,
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function writeQueryPatternForText(text) {
  return /\b(prisma|db|database|repo|repository|client|knex|sequelize|mongoose|typeorm|entityManager|em|ActiveRecord|session)\b[\s\S]{0,160}\.(create|update|delete|save|insert|upsert)\s*\(/i.test(text)
    || /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(text);
}

function scanNPlusOne(repo) {
  const findings = [];
  const loopPattern = /\b(for|foreach|while|each)\b|\.(forEach|map|reduce|collect)\s*\(/;
  const sequentialAwaitPattern = /\b(await|for\s+await)\b/;

  function scopedWindow(lines, index) {
    const lineText = lines[index] || "";
    const baseIndent = lineText.match(/^\s*/)?.[0].length || 0;
    const hasOpeningBrace = /[{([]/.test(lineText);
    let braceBalance = (lineText.match(/[{\[(]/g) || []).length - (lineText.match(/[}\])]/g) || []).length;
    const collected = [lineText];

    for (let cursor = index + 1; cursor < Math.min(index + 40, lines.length); cursor += 1) {
      const nextLine = lines[cursor] || "";
      const trimmed = nextLine.trim();
      const indent = nextLine.match(/^\s*/)?.[0].length || 0;

      if (!hasOpeningBrace && trimmed && indent <= baseIndent) break;

      collected.push(nextLine);
      braceBalance += (nextLine.match(/[{\[(]/g) || []).length - (nextLine.match(/[}\])]/g) || []).length;
      if (hasOpeningBrace && braceBalance <= 0) break;
    }

    return collected.join("\n");
  }

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const seen = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = scopedWindow(lines, index);
      const windowLineCount = window.split(/\r?\n/).length;
      if (!windowTouchesChangedLine(repo, file, line, windowLineCount)) return;
      const hasQueryInWindow = window.split(/\r?\n/).some(queryPatternForLine);
      const signature = `${file}:${line}:${window.replace(/\s+/g, " ").slice(0, 180)}`;
      if (seen.has(signature)) return;

      if (loopPattern.test(lineText) && hasQueryInWindow) {
        seen.add(signature);
        addFinding(
          findings,
          "possible-n-plus-one-query",
          "high",
          repo.name,
          file,
          line,
          window,
          "Batch the access with a bounded query, join/preload/include, id IN (...), dataloader, relation preloading, or repository method that scales independently from item count."
        );
      }

      if (/\b(Promise\.all|asyncio\.gather|Task\.WhenAll|errgroup\.Group|join_all)\b/.test(window) && hasQueryInWindow) {
        seen.add(signature);
        addFinding(
          findings,
          "parallel-n-plus-one-query",
          "high",
          repo.name,
          file,
          line,
          window,
          "Parallel per-item queries still scale with item count. Replace with bounded batched queries."
        );
      }

      const recentLoop = lines.slice(Math.max(0, index - 5), index + 1).join("\n");
      if (sequentialAwaitPattern.test(lineText) && queryPatternForLine(lineText) && /\b(for|while|foreach|each)\b/.test(recentLoop)) {
        seen.add(signature);
        addFinding(
          findings,
          "sequential-query-in-loop",
          "high",
          repo.name,
          file,
          line,
          lineText,
          "Avoid awaited/blocking per-item queries inside loops; batch, preload, or cache instead."
        );
      }
    });
  }

  return findings;
}

function scanDataConsistency(repo) {
  const findings = [];
  for (const file of existingFiles(repo.root, repo.entries).filter(isCode)) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const seenReadWriteWindows = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(index, Math.min(index + 16, lines.length)).join("\n");
      if (!windowTouchesChangedLine(repo, file, line, window.split(/\r?\n/).length)) return;

      if (readQueryPatternForLine(lineText)
        && !writeQueryPatternForText(lineText)
        && writeQueryPatternForText(window)
        && !/\b(transaction|atomic|BEGIN|COMMIT|rollback|\$transaction|TransactionScope|db\.Transaction|with_lock|select_for_update)\b/i.test(window)) {
        const signature = window.replace(/\s+/g, " ").slice(0, 220);
        if (!seenReadWriteWindows.has(signature)) {
          seenReadWriteWindows.add(signature);
          addFinding(
            findings,
            "read-then-write-without-transaction",
            "medium",
            repo.name,
            file,
            line,
            window,
            "Check whether the read/write pair needs a transaction, unique constraint, upsert, lock, or optimistic concurrency guard."
          );
        }
      }

      if (/\b(transaction|atomic|\$transaction|TransactionScope|db\.Transaction|with_lock)\b/i.test(lineText)
        && /(fetch\(|axios\.|http\.|sendMail|resend\.|stripe\.|s3\.|queue\.|requests\.|Net::HTTP|Faraday|httpClient|HttpClient|http\.Post|http\.Get)/.test(window)) {
        addFinding(
          findings,
          "external-side-effect-inside-transaction",
          "high",
          repo.name,
          file,
          line,
          window,
          "Keep network/email/payment/queue side effects outside database transactions or use an outbox/compensation pattern."
        );
      }
    });
  }
  return findings;
}

function scanRawSqlSecurity(repo) {
  const findings = [];
  for (const file of existingFiles(repo.root, repo.entries).filter(isCode)) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const seenSqlRisks = new Set();

    function rawSqlBlock(index) {
      const collected = [];
      let backtickCount = 0;
      let sawTemplateStart = false;
      for (let cursor = index; cursor < Math.min(index + 18, lines.length); cursor += 1) {
        const current = lines[cursor] || "";
        collected.push(current);
        const ticks = (current.match(/`/g) || []).length;
        backtickCount += ticks;
        if (ticks > 0) sawTemplateStart = true;
        if (sawTemplateStart && backtickCount >= 2 && /\)\s*;?\s*$/.test(current)) break;
        if (!sawTemplateStart && /\)\s*;?\s*$/.test(current)) break;
      }
      return collected.join("\n");
    }

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const startsRawSqlBlock = /\$queryRawUnsafe|\$executeRawUnsafe|rawQuery|executeQuery|whereRaw|orderByRaw|knex\.raw|sequelize\.query|createNativeQuery|Prisma\.raw|sql\.raw|literal\(|raw\(/.test(lineText);
      if (!startsRawSqlBlock) return;
      const window = rawSqlBlock(index);
      const lineCount = window.split(/\r?\n/).length;
      if (!windowTouchesChangedLine(repo, file, line, lineCount)) return;

      if (/\$queryRawUnsafe|\$executeRawUnsafe|rawQuery|executeQuery|whereRaw|orderByRaw|knex\.raw|sequelize\.query|createNativeQuery/.test(lineText)) {
        const key = `raw:${file}:${line}`;
        if (!seenSqlRisks.has(key)) {
          seenSqlRisks.add(key);
          addFinding(
            findings,
            "raw-sql-injection-risk",
            "high",
            repo.name,
            file,
            line,
            window,
            "Prefer parameterized query APIs. If raw SQL is required, prove every external value is bound separately and identifiers are allowlisted."
          );
        }
      }

      if (/(Prisma\.raw|sql\.raw|literal\(|raw\()\s*\(`[\s\S]*?\$\{/.test(window) || /(SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,360}\$\{/.test(window)) {
        const key = `interpolated:${file}:${line}`;
        if (seenSqlRisks.has(key)) return;
        seenSqlRisks.add(key);
        addFinding(
          findings,
          "interpolated-raw-sql-risk",
          "high",
          repo.name,
          file,
          line,
          window,
          "Do not interpolate external or variable input into raw SQL. Use bind parameters or allowlisted identifier maps."
        );
      }
    });
  }
  return findings;
}

function scanWebAndRuntimeSecurity(repo) {
  const findings = [];
  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(index, Math.min(index + 8, lines.length)).join("\n");
      if (!windowTouchesChangedLine(repo, file, line, window.split(/\r?\n/).length)) return;

      if (/\b(innerHTML|outerHTML|insertAdjacentHTML)\b|dangerouslySetInnerHTML/.test(lineText)
        && !/\b(DOMPurify|sanitize|sanitizeHtml|trustedTypes|SafeHtml|htmlSafe)\b/i.test(window)) {
        addFinding(
          findings,
          "potential-xss-unsanitized-html",
          "high",
          repo.name,
          file,
          line,
          window,
          "Do not render dynamic HTML without a sanitizer/trusted-types boundary. Prove the value is static or sanitized before assigning HTML."
        );
      }

      if (/\b(child_process\.)?(exec|execSync)\s*\(|\bspawn\s*\(|\bspawnSync\s*\(|\bsystem\s*\(|\bpopen\s*\(/.test(lineText)
        && /(\$\{|`|\+|req\.|request\.|params|query|body|input|argv|process\.env)/.test(window)
        && !/\b(allowlist|whitelist|validate|escapeShellArg|shellQuote|safeCommand|spawnFile)\b/i.test(window)) {
        addFinding(
          findings,
          "command-injection-risk",
          "high",
          repo.name,
          file,
          line,
          window,
          "Avoid shell string execution with dynamic input. Use argv arrays, allowlisted commands/flags, and validation at the boundary."
        );
      }

      if (/\b(fs\.)?(readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|rm|sendFile|download)\s*\(/.test(lineText)
        && /\b(req\.|request\.|params|query|body|input|filename|path|filePath|slug|name)\b/.test(window)
        && !/\b(normalize|resolve|safeJoin|basename|allowlist|validate|isSubpath|startsWith)\b/i.test(window)) {
        addFinding(
          findings,
          "path-traversal-risk",
          "high",
          repo.name,
          file,
          line,
          window,
          "Normalize and constrain user-controlled paths to an allowed root, or map user input to allowlisted file identifiers."
        );
      }

      if (/\b(console\.(log|warn|error|info)|logger\.(debug|info|warn|error))\s*\(/.test(lineText)
        && /\b(token|secret|password|credential|authorization|cookie|set-cookie|apiKey|accessToken|refreshToken)\b/i.test(window)
        && !/\b(redact|mask|safe|omit|sanitize)\b/i.test(window)) {
        addFinding(
          findings,
          "sensitive-data-logging-risk",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Do not log credentials, tokens, cookies, or secrets unless they are explicitly redacted before logging."
        );
      }
    });
  }
  return findings;
}

function scanUnboundedDataAccess(repo) {
  const findings = [];
  const listQueryPattern = /\b(findMany|findAll|all|scan|query)\s*\(|\bSELECT\s+.+\s+FROM\b/i;
  const boundedPattern = /\b(take|limit|skip|offset|cursor|pageSize|perPage|first|top|paginate|pagination|batchSize)\b|\.limit\s*\(|LIMIT\s+\d+/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const seen = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      if (!listQueryPattern.test(lineText)) return;
      const window = lines.slice(index, Math.min(index + 10, lines.length)).join("\n");
      const lineCount = window.split(/\r?\n/).length;
      if (!windowTouchesChangedLine(repo, file, line, lineCount)) return;
      if (boundedPattern.test(window)) return;
      if (/\b(count|aggregate|groupBy)\s*\(/.test(window)) return;

      const key = `${file}:${line}:${window.replace(/\s+/g, " ").slice(0, 180)}`;
      if (seen.has(key)) return;
      seen.add(key);
      addFinding(
        findings,
        "unbounded-list-query",
        "medium",
        repo.name,
        file,
        line,
        window,
        "Add an explicit limit, pagination contract, cursor/batch boundary, or prove this query is bounded by a small invariant dataset."
      );
    });
  }

  return findings;
}

function scanFrameworkSpecific(repo) {
  const findings = [];
  for (const file of existingFiles(repo.root, repo.entries).filter((value) => /\.(controller|service|repository|resolver|guard|interceptor|dto)\.[cm]?[tj]s$/.test(value))) {
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const decoratorCount = (text.match(/@(Get|Post|Put|Patch|Delete|MessagePattern|EventPattern)\b/g) || []).length;

    if (/\.controller\./.test(file) && lines.length > 240) {
      findings.push({
        rule: "large-controller",
        severity: "medium",
        repo: repo.name,
        file,
        line: "-",
        text: `${lines.length} lines, ${decoratorCount} route decorators`,
        suggestion: "Move orchestration/business logic into use cases/services and keep controllers thin.",
      });
    }

    if (/\.dto\./.test(file) && !/@(Is|Validate|Array|Type|Transform|Expose|ApiProperty)/.test(text)) {
      findings.push({
        rule: "dto-without-validation-signal",
        severity: "medium",
        repo: repo.name,
        file,
        line: "-",
        text: "DTO file has no obvious validation/serialization decorators.",
        suggestion: "Validate and transform input/output at the boundary or document why validation is external.",
      });
    }
  }
  return findings;
}

function scanPublicContractIntegrity(repo) {
  const findings = [];
  const publicTypeNamePattern = /(Public|External|Client|Response|Resource|Dto|DTO|ViewModel|View)/;
  const internalTypeNamePattern = /(Internal|Private|Legacy|State|Entity|Model|Record|Persistence|Domain|Raw|Config|Settings|Branding|Appearance|Profile|Claims|Permissions|Roles)/;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const publicish = isPublicBoundaryFile(file) || publicTypeNamePattern.test(text);

    if (publicish) {
      lines.forEach((lineText, index) => {
        const line = index + 1;
        const window = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 6)).join("\n");
        if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 3), window.split(/\r?\n/).length)) return;

        const exposesInternalMember = /(?:\.\.\.\s*(?:state|entity|model|record|domain|internal|raw|db[A-Za-z0-9_]*|persistence[A-Za-z0-9_]*|legacy[A-Za-z0-9_]*)\s*\.\s*(?:legacy|internal|private|raw|secret|token|password|credential|metadata|settings|config|profile|branding|appearance|preferences|permissions|roles|claims|state)|\b[A-Za-z_$][\w$]*\s*:\s*(?:state|entity|model|record|domain|internal|raw|db[A-Za-z0-9_]*|persistence[A-Za-z0-9_]*|legacy[A-Za-z0-9_]*)\s*\.\s*(?:legacy|internal|private|raw|secret|token|password|credential|metadata|settings|config|profile|branding|appearance|preferences|permissions|roles|claims|state))/i.test(lineText);
        const isPublicReturnOrMapping = /\b(return|serialize|present|toPublic|toResponse|toResource|public|response|dto|DTO|contract)\b/i.test(window);
        const exposingLine = lineText;
        const hasSanitizer = /\b(sanitize|sanitise|redact|strip|mask|omit|pick|allowlist|whitelist|toPublic|public[A-Za-z0-9_]*|safe[A-Za-z0-9_]*|present[A-Za-z0-9_]*)\b/i.test(exposingLine);

        if (exposesInternalMember && isPublicReturnOrMapping && !hasSanitizer) {
          addFinding(
            findings,
            "public-contract-bypasses-sanitizer",
            "high",
            repo.name,
            file,
            line,
            window,
            "Do not expose internal/raw/legacy/domain state directly from public/API response mappers. Route it through a sanitized DTO/resource/allowlist adapter and add regression coverage for omitted private fields."
          );
        }
      });
    }

    for (const declaration of text.matchAll(/\b(?:export\s+)?(?:interface|type|class)\s+([A-Z][A-Za-z0-9_$]*(?:Public|External|Client|Response|Resource|Dto|DTO|ViewModel|View)[A-Za-z0-9_$]*)\s*(?:=\s*)?{([\s\S]{0,1400}?)}\s*;?/g)) {
      const typeName = declaration[1] || "";
      const body = declaration[2] || "";
      if (!publicTypeNamePattern.test(typeName)) continue;
      for (const property of body.matchAll(/\b([A-Za-z_$][\w$]*)\??\s*:\s*([A-Z][A-Za-z0-9_.$<>[\] |&]*)/g)) {
        const propertyName = property[1] || "";
        const propertyType = property[2] || "";
        if (!internalTypeNamePattern.test(propertyType)) continue;
        if (publicTypeNamePattern.test(propertyType) || /\b(Sanitized|Safe|Redacted|Summary|Preview|Snapshot)\b/.test(propertyType)) continue;
        const line = lineForFirstOccurrence(text, property[0]);
        if (!windowTouchesChangedLine(repo, file, line === "-" ? 1 : line, 6)) continue;
        addFinding(
          findings,
          "public-response-uses-internal-type",
          "medium",
          repo.name,
          file,
          line,
          `${typeName}.${propertyName}: ${propertyType}`,
          "Public/API response types should not expose broad internal/domain/persistence types. Define a sanitized public DTO/resource type whose fields match the public contract."
        );
      }
    }
  }

  return findings;
}

function scanConfigValidationIntegrity(repo) {
  const findings = [];
  const configurableFieldPattern = /(color|colour|gradient|radius|width|height|size|spacing|opacity|shadow|blur|image|url|uri|icon|style|effect|transition|theme|appearance|branding|background|foreground|border|font|token|variant|mode|type|kind|status|role|permission|provider|scope|locale|timezone|currency)/i;
  const strongValidatorPattern = /@(IsEnum|IsIn|Matches|IsHexColor|IsUrl|IsUUID|IsBoolean|IsNumber|IsInt|Min|Max|Length|MinLength|MaxLength|Validate|ValidateIf)|z\.enum|z\.nativeEnum|z\.literal|z\.union|yup\.(mixed|number|boolean)|Joi\.(valid|allow|number|boolean)|\.(regex|url|uuid|email|min|max|int|positive|nonnegative)\s*\(|oneOf|enum:|\ballowed[A-Za-z0-9_]*\b|\bnormalizeEnum\b|\bvalidate[A-Za-z0-9_]*Token\b/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 4)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 4), window.split(/\r?\n/).length)) return;
      const stringField = /:\s*string\b/.test(lineText);
      const decoratedStringField = stringField && /@IsString\s*\(\s*\)/.test(window);
      const weakSchemaString = /(z\.string\s*\(\s*\)|Joi\.string\s*\(\s*\)|yup\.string\s*\(\s*\))/.test(window)
        && configurableFieldPattern.test(lineText)
        && /(dto|schema|input|request|settings|appearance|branding|theme|preferences)/i.test(file);
      if (!decoratedStringField && !weakSchemaString) return;
      if (decoratedStringField && !configurableFieldPattern.test(window)) return;
      if (strongValidatorPattern.test(window)) return;
      if (!/(dto|schema|config|settings|appearance|branding|theme|preferences|request|input)/i.test(file + "\n" + text.slice(0, 1200))) return;

      addFinding(
        findings,
        "config-token-weak-string-validation",
        "medium",
        repo.name,
        file,
        line,
        window,
        "String-only validation on configurable/public fields is too broad. Use enum/allowlist/pattern/range/token validators at the boundary and normalize again before runtime use."
      );
    });

    const defaultObjectMatches = [...text.matchAll(/\b(?:const|export\s+const|let|var)\s+([A-Z0-9_]*DEFAULT[A-Z0-9_]*|default[A-Z][A-Za-z0-9_]*)\s*=\s*{([\s\S]{0,1800}?)}\s*(?:as\s+const)?\s*;?/g)];
    const configurableVocabulary = new Set();
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:Color|Colour|Gradient|Radius|Style|Effect|Preset|Mode|Type|Theme|Appearance|Background|Foreground|Border|Icon|Font|Token|Variant|Height|Width))\b/g)) {
      configurableVocabulary.add(match[1]);
    }
    if (defaultObjectMatches.length >= 2 && configurableVocabulary.size >= 6) {
      const sparseDefaults = defaultObjectMatches
        .map((match) => {
          const keys = [...(match[2] || "").matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)].map((keyMatch) => keyMatch[1]);
          return { name: match[1], line: lineForFirstOccurrence(text, match[0]), keys };
        })
        .filter((entry) => entry.keys.length > 0);
      if (sparseDefaults.length >= 2) {
        const maxKeys = Math.max(...sparseDefaults.map((entry) => entry.keys.length));
        const sparse = sparseDefaults.find((entry) => entry.keys.length <= Math.max(2, Math.floor(maxKeys / 2)) && maxKeys - entry.keys.length >= 4);
        if (sparse) {
          addFinding(
            findings,
            "config-defaults-asymmetry-signal",
            "low",
            repo.name,
            file,
            sparse.line,
            `${sparse.name} has ${sparse.keys.length} default key(s), while a sibling default object has ${maxKeys}.`,
            "Check whether every configurable public/runtime field has an explicit default or normalization fallback; asymmetric defaults often cause silent runtime drift."
          );
        }
      }
    }
  }

  return findings;
}

function scanBundleSplitRisks(repo) {
  const findings = [];
  const uiEntryOrRoutePattern = /(^|\/)(main|index|app|router|routes|layout|page|shell|navigation)\.[cm]?[jt]sx?$|(^|\/)(pages?|routes?|app|layouts?|shells?)\//i;
  const heavyImportPattern = /\b(monaco-editor|@monaco-editor|codemirror|@codemirror|react-pdf|pdfjs|pdf-lib|xlsx|exceljs|papaparse|d3(?:-[a-z-]+)?|chart\.js|echarts|recharts|highcharts|mapbox-gl|leaflet|three|@react-three|lottie|framer-motion|@tiptap|slate|quill|ckeditor|mermaid|fullcalendar|video\.js|hls\.js|firebase|aws-sdk)\b/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => /\.(tsx|jsx|mts|cts|mjs|cjs|ts|js)$/.test(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    if (!uiEntryOrRoutePattern.test(file)) continue;
    const text = readFile(repo.root, file);
    const hasLazyBoundary = /\b(lazy\s*\(|dynamic\s*\(|import\s*\(|defineAsyncComponent\s*\(|loadable\s*\()/.test(text);
    const lines = text.split(/\r?\n/);

    lines.forEach((lineText, index) => {
      const line = index + 1;
      if (!shouldScanLine(repo, file, line)) return;
      if (!/^\s*import\s+(?:[^"'`]+?\s+from\s+)?["'`][^"'`]+["'`]/.test(lineText)) return;
      if (!heavyImportPattern.test(lineText)) return;
      if (hasLazyBoundary) return;

      addFinding(
        findings,
        "static-heavy-ui-import-without-lazy-boundary",
        "low",
        repo.name,
        file,
        line,
        lineText,
        "Investigate whether this heavy route/shell import belongs behind route-level code-splitting, lazy/Suspense, dynamic import, or manual chunking. Treat as blocking only when it affects the startup path or explains a measured/build bundle regression."
      );
    });
  }

  return findings;
}

function scanCouplingAndComplexity(repo) {
  const findings = [];
  const thresholds = repo.config.thresholds || defaultConfig.thresholds;

  function functionRanges(lines) {
    const ranges = [];
    const startPattern = /\b(function|async\s+function)\b|=>\s*{|^\s*(public|private|protected|static|async|export\s+async|export)?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[:\w<>,\s|&?[\]]*\s*{/;
    const controlBlockPattern = /^\s*(if|else\s+if|for|for\s+await|while|switch|catch|with|foreach)\b/;

    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] || "";
      if (controlBlockPattern.test(lineText)) continue;
      if (!startPattern.test(lineText)) continue;
      let balance = (lineText.match(/{/g) || []).length - (lineText.match(/}/g) || []).length;
      if (balance <= 0) continue;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const nextLine = lines[cursor] || "";
        balance += (nextLine.match(/{/g) || []).length - (nextLine.match(/}/g) || []).length;
        if (balance <= 0) {
          ranges.push({ start: index + 1, end: cursor + 1, length: cursor - index + 1 });
          break;
        }
      }
    }
    return ranges;
  }

  function maxControlDepth(lines, start, end) {
    let depth = 0;
    let maxDepth = 0;
    for (let index = start - 1; index < end; index += 1) {
      const lineText = lines[index] || "";
      if (/\b(if|for|while|switch|catch|try|foreach|forEach|map|reduce)\b/.test(lineText)) {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      }
      const closes = (lineText.match(/}/g) || []).length;
      if (closes > 0) depth = Math.max(0, depth - closes);
    }
    return maxDepth;
  }

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value) && !isAppendOnlyLedger(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const importCount = lines.filter((line) => /^\s*import\s|^\s*from\s+\S+\s+import\s|^\s*require\(/.test(line)).length;
    const constructorParamsText = text.match(/constructor\s*\(([\s\S]*?)\)\s*{/m)?.[1] || "";
    const constructorParams = constructorParamsText
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith("//")).length;

    if (lines.length > thresholds.largeFileLines) {
      findings.push({
        rule: "large-file-touched",
        severity: lines.length > thresholds.veryLargeFileLines ? "medium" : "low",
        repo: repo.name,
        file,
        line: "-",
        text: `${lines.length} lines; ${changedLineCount(repo, file)} changed line(s) detected`,
        suggestion: "Review whether the change adds responsibility to an already large file. Consider extracting cohesive helpers/use cases when behavior is growing.",
      });
    }

    if (lines.length > thresholds.largeRefactorLines && changedLineCount(repo, file) >= thresholds.largeRefactorChangedLines) {
      findings.push({
        rule: "single-responsibility-refactor-gate",
        severity: "medium",
        repo: repo.name,
        file,
        line: "-",
        text: `${lines.length} lines and ${changedLineCount(repo, file)} changed line(s) in one file`,
        suggestion: "Before calling the task complete, decide whether this change should extract a cohesive service/helper/use case or explicitly defer refactor with rationale.",
      });
    }

    if (importCount >= thresholds.highImportCount) {
      findings.push({
        rule: "high-import-coupling",
        severity: "low",
        repo: repo.name,
        file,
        line: "-",
        text: `${importCount} import/require statements detected`,
        suggestion: "Check for hidden coupling and whether the touched behavior belongs behind a narrower boundary.",
      });
    }

    for (const range of functionRanges(lines)) {
      if (!windowTouchesChangedLine(repo, file, range.start, range.length)) continue;
      if (range.length >= thresholds.longFunctionLines) {
        findings.push({
          rule: "long-function-touched",
          severity: range.length >= thresholds.veryLongFunctionLines ? "medium" : "low",
          repo: repo.name,
          file,
          line: range.start,
          text: `Function-like block spans ${range.length} lines and intersects changed lines`,
          suggestion: "Apply SRP/object calisthenics review: extract named steps, reduce local branching, and keep one level of abstraction per function when feasible.",
        });
      }

      const depth = maxControlDepth(lines, range.start, range.end);
      if (depth >= 4) {
        findings.push({
          rule: "deep-nesting-touched",
          severity: "low",
          repo: repo.name,
          file,
          line: range.start,
          text: `Changed function-like block reaches approximate control-flow depth ${depth}`,
          suggestion: "Prefer guard clauses, extracted policies/specifications, or small objects to reduce nested control flow.",
        });
      }
    }

    const classLikeBlocks = (text.match(/\b(class|struct|interface)\s+[A-Za-z_$][\w$]*[\s\S]*?{/g) || []).length;
    const exportedMembers = (text.match(/\bexport\s+(class|function|const|let|var|interface|type|enum)\b|^\s*export\s*{/gm) || []).length;
    if (lines.length > 500 && (classLikeBlocks >= 3 || exportedMembers >= 8)) {
      findings.push({
        rule: "multiple-responsibilities-in-large-file",
        severity: "medium",
        repo: repo.name,
        file,
        line: "-",
        text: `${classLikeBlocks} class-like block(s), ${exportedMembers} exported member(s), ${lines.length} lines`,
        suggestion: "Review SRP boundaries. Split unrelated policies, DTOs, adapters, fixtures, or orchestration into cohesive modules when the touched change adds another reason to change the file.",
      });
    }

    const changedLines = repo.changedLines?.get(file);
    if (changedLines) {
      for (const line of changedLines) {
        const lineText = lines[line - 1] || "";
        if (/\belse\b/.test(lineText) && shouldScanLine(repo, file, line)) {
          findings.push({
            rule: "else-branch-added",
            severity: "low",
            repo: repo.name,
            file,
            line,
            text: lineText,
            suggestion: "Check whether a guard clause or extracted strategy/policy would keep the branch easier to reason about.",
          });
        }
      }
    }

    if (constructorParams >= thresholds.wideConstructorParams) {
      findings.push({
        rule: "wide-constructor-dependency-surface",
        severity: "low",
        repo: repo.name,
        file,
        line: "-",
        text: `${constructorParams} constructor parameter(s) detected`,
        suggestion: "Check whether the service is accumulating responsibilities or should delegate to smaller collaborators.",
      });
    }
  }
  return findings;
}

function reviewQuestionsForRepo(repo, findings) {
  const questions = [];
  const rules = new Set(findings.map((finding) => finding.rule));
  const files = repo.entries.map((entry) => entry.path);
  const magicStringCount = findings.filter((finding) => finding.rule === "magic-string").length;

  if (rules.has("single-responsibility-refactor-gate") || rules.has("large-file-touched") || rules.has("multiple-responsibilities-in-large-file")) {
    questions.push("O escopo desta tarefa permite refatorar o arquivo grande agora, ou a revisão deve registrar a extração como follow-up explícito?");
  }

  if (rules.has("long-function-touched") || rules.has("deep-nesting-touched") || rules.has("else-branch-added")) {
    questions.push("A alteração deve obedecer estritamente Object Calisthenics/SRP nesta entrega, ou há restrição de escopo para limitar a revisão a regressões e extrações pequenas?");
  }

  if (rules.has("backend-e2e-coverage-gap")) {
    questions.push("A mudança backend altera contrato/rota/tool de forma que exige e2e/integration real, ou os testes focados existentes cobrem o caminho de produção suficiente para esta entrega?");
  }

  if (rules.has("local-or-generated-artifacts-in-diff") || files.length >= 40) {
    questions.push("Os artefatos locais/gerados ou diff amplo são intencionalmente versionados, ou devem ser removidos/isolados antes da revisão?");
  }

  if (rules.has("duplicated-literal") || magicStringCount >= 3) {
    questions.push("Os literais repetidos detectados são vocabulário de domínio deliberado/fixtures de teste, ou devem virar constantes/enums/schemas canônicos?");
  }

  if (files.length > 1 && files.some(isContractLikeFile)) {
    questions.push("Há contrato cross-repo ou consumidor externo que precisa de compatibilidade/migração antes de aprovar?");
  }

  return [...new Set([...questions, ...(repo.config.customQuestions || [])])];
}

function runtimeVerificationRequirementsForRepo(repo, findings, repositoryCount) {
  const requirements = [];
  const rules = new Set(findings.map((finding) => finding.rule));
  const files = repo.entries.map((entry) => entry.path);
  const codeFiles = files.filter((file) => isCode(file) && !isTest(file) && !isGeneratedOrLocalArtifact(file));
  const boundaryFiles = codeFiles.filter((file) => {
    if (/\.(controller|route|routes|resolver|handler|tool-executor|use-case|service|repository|hook)\./.test(file)) return true;
    if (/(^|\/)(controllers?|routes?|handlers?|resolvers?|services?|use-cases?|repositories?|hooks?|commands?|jobs?)\//.test(file)) return true;
    return false;
  });
  const contractFiles = files.filter(isContractLikeFile);
  const packageFiles = files.filter((file) => /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements.*\.txt|Gemfile|composer\.json|pom\.xml|build\.gradle|build\.gradle\.kts|Package\.swift|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|Package\.resolved)$/.test(file));
  const uiFiles = files.filter((file) => /\.(tsx|jsx|vue|svelte|astro|css|scss)$/.test(file)
    || /(^|\/)(components?|pages?|app|routes?|views?|screens?|hooks?)\//.test(file));

  if (codeFiles.length > 0) {
    requirements.push("Exercise the exact touched production code path with representative inputs. Name the real function/class/handler/route/hook/adapter/command exercised, not only the test runner.");
  }

  if (rules.has("large-file-touched") || rules.has("single-responsibility-refactor-gate") || rules.has("multiple-responsibilities-in-large-file") || rules.has("long-function-touched")) {
    requirements.push("For large-file/refactor/SRP signals, run focused behavioral tests or a production-code probe before closeout. Build/typecheck/static review are not enough after extraction or responsibility movement.");
  }

  if (boundaryFiles.length > 0 || rules.has("backend-e2e-coverage-gap")) {
    requirements.push("For changed service/controller/handler/repository/hook boundaries, prove the boundary through a focused unit/integration/e2e path or explain why the exact path cannot run.");
  }

  if (repositoryCount > 1 || contractFiles.length > 0) {
    requirements.push("For cross-repo or contract/schema/API/client changes, run producer and consumer compatibility checks or contract tests across every touched repository.");
  }

  if (uiFiles.length > 0) {
    requirements.push("For web UI/browser changes, the main agent must run a human-like browser-use pass through the changed flow and capture screenshot/interaction evidence. If no browser-use session is exposed, load the Browser skill, discover the Node REPL js tool if needed, bootstrap the iab runtime, and open a new browser-use tab/session before fallback. Use computer-use only for desktop/native/local-app validation, OS/browser shell behavior, or documented failed browser-use bootstrap/open attempt. Escalate to a QA subagent only after main-agent evidence when independent or matrix QA is justified.");
  }

  if (rules.has("possible-n-plus-one-query") || rules.has("parallel-n-plus-one-query") || rules.has("sequential-query-in-loop")) {
    requirements.push("For N+1 signals, use a test/probe that fails or exposes repeated query count at scale, then prove the batched path stays bounded.");
  }

  if (rules.has("unbounded-list-query")) {
    requirements.push("For unbounded list-query signals, prove pagination/limit behavior through the real repository/query path or document the invariant that bounds result size.");
  }

  if (rules.has("read-then-write-without-transaction") || rules.has("external-side-effect-inside-transaction")) {
    requirements.push("For concurrency/data-consistency signals, run a deterministic transaction/idempotency/race-oriented test or state the untested concurrency risk explicitly.");
  }

  if (rules.has("raw-sql-injection-risk") || rules.has("interpolated-raw-sql-risk")) {
    requirements.push("For raw SQL/security signals, prove parameter binding or allowlisted identifiers through the real query builder path; do not rely on string inspection alone.");
  }

  if (rules.has("no-test-file-changed")) {
    requirements.push("If no test file changed, identify the existing test/probe that covers the changed behavior or add focused regression coverage before completion.");
  }

  if (rules.has("mock-only-test-path")) {
    requirements.push("For mock-heavy tests, add or identify a path that imports and executes the real production unit/boundary instead of only asserting mock calls.");
  }

  if (rules.has("happy-path-only-test-change") || rules.has("missing-error-path-test")) {
    requirements.push("For new or changed tests, cover at least one meaningful failure, empty, invalid, permission, or edge path when the production change can fail.");
  }

  if (rules.has("backend-boundary-without-e2e-or-integration")) {
    requirements.push("For backend boundary changes, run e2e/integration coverage through the real route/tool/handler or state why focused lower-level tests are sufficient.");
  }

  if (rules.has("cross-repo-contract-without-consumer-check")) {
    requirements.push("For cross-repo contract changes, run consumer compatibility tests or a producer/consumer smoke across the touched repositories.");
  }

  if (packageFiles.length > 0) {
    requirements.push("For dependency/tooling changes, verify install/build/runtime compatibility for the touched package or workspace scope, including lockfile state.");
  }

  return [...new Set(requirements)];
}

function scanTests(repo) {
  const changedTests = repo.entries.map((entry) => entry.path).filter(isTest);
  const changedCode = repo.entries.map((entry) => entry.path).filter((file) => isCode(file) && !isTest(file));
  const findings = [];
  const backendBoundaryChanged = changedCode.some((file) => {
    if (/\.(controller|route|routes|resolver|handler|tool-executor|use-case|service|repository)\./.test(file)) return true;
    if (/(^|\/)(controllers?|routes?|handlers?|resolvers?|services?|use-cases?|repositories?)\//.test(file)) return true;
    return false;
  });
  const integrationOrE2eChanged = changedTests.some((file) => /(^|\/)(e2e|integration|tests\/e2e|tests\/integration)\//.test(file)
    || /\.(e2e|integration|int)\./.test(file)
    || /\.feature$/.test(file));

  for (const entry of repo.entries.filter((value) => value.status === "D" && isTest(value.path))) {
    findings.push({
      rule: "test-file-deleted",
      severity: "medium",
      repo: repo.name,
      file: entry.path,
      line: "-",
      text: "A test file was deleted.",
      suggestion: "Confirm the behavior remains covered elsewhere or explain why the test was obsolete.",
    });
  }

  if (changedCode.length > 0 && changedTests.length === 0) {
    findings.push({
      rule: "no-test-file-changed",
      severity: "medium",
      repo: repo.name,
      file: "(diff)",
      line: "-",
      text: `${changedCode.length} code files changed and no test files changed.`,
      suggestion: "Confirm existing tests cover the changed behavior or add focused regression coverage.",
    });
  }

  const changedCodeTexts = changedCode.map((file) => existsSync(join(repo.root, file)) ? readFile(repo.root, file) : "").join("\n");
  const changedTestTexts = changedTests.map((file) => existsSync(join(repo.root, file)) ? readFile(repo.root, file) : "").join("\n");
  const patchSemanticsChanged = /(branding|patch|apply[A-Za-z0-9_]*Patch|buildChangedValue|deepMerge|mergeDeep|draft|persisted)/i.test(changedCode.join("\n") + "\n" + changedCodeTexts);
  const testsMentionPatchHappyPath = /(patch|merge|changed|header|sidebar|branding|draft|persisted)/i.test(changedTestTexts);
  const testsMentionRemovalReset = /(reset|remove|remov|clear|delete|unset|null|undefined|gradient\s+to\s+solid|solid|limpa|limpar|remoção|remocao)/i.test(changedTestTexts);
  if (patchSemanticsChanged && changedTests.length > 0 && testsMentionPatchHappyPath && !testsMentionRemovalReset) {
    findings.push({
      rule: "patch-reset-coverage-gap",
      severity: "medium",
      repo: repo.name,
      file: "(tests)",
      line: "-",
      text: "Patch/deep-merge behavior changed and tests mention positive patch/merge paths, but no obvious reset/removal/null/undefined coverage was detected.",
      suggestion: "Add regression coverage for clearing optional nested fields, resetting advanced tokens, and switching modes such as gradient to solid.",
    });
  }

  for (const file of changedTests) {
    if (!existsSync(join(repo.root, file))) continue;
    const text = readFile(repo.root, file);
    if (changedCode.length > 0) {
      const productionImports = new Set();
      for (const productionFile of changedCode) {
        if (!existsSync(join(repo.root, productionFile))) continue;
        const productionText = readFile(repo.root, productionFile);
        for (const moduleName of javascriptImportedModules(productionText)) productionImports.add(moduleName);
      }
      for (const mockedModule of javascriptMockModules(text)) {
        if (!productionImports.has(mockedModule)) {
          findings.push({
            rule: "stale-or-orphaned-test-mock",
            severity: "low",
            repo: repo.name,
            file,
            line: lineForFirstOccurrence(text, mockedModule),
            text: `Test mocks "${mockedModule}", but no changed production file imports that module.`,
            suggestion: "Remove stale mocks that mirror an old dependency, or make the regression intent explicit in the test name and assert behavior through the current production dependency.",
          });
        }
      }
    }

    if (!/expect\s*\(|assert\.|to(Equal|Be|Throw)|screen\.|locator\(|pytest\.raises|assert\s+|require\(|should|t\.Error|t\.Fatal|assert_eq!|assert!|XCTAssert|\.Should\(/.test(text)) {
      findings.push({
        rule: "weak-test-assertion-signal",
        severity: "low",
        repo: repo.name,
        file,
        line: "-",
        text: "No obvious assertion signal detected.",
        suggestion: "Ensure the test asserts behavior, not only execution.",
      });
    }

    const hasMockSignal = /\b(jest\.fn|vi\.fn|sinon\.|mock|stub|spyOn|MagicMock|patch\(|unittest\.mock|gomock|mockito|Moq\.|FakeItEasy|NSubstitute|double\(|allow\(|receive\(|jest\.mock|vi\.mock)\b/i.test(text);
    const hasLocalProductionImport = /from\s+["']\.{1,2}\/(?!.*(test|spec|mock|fixture))|require\(["']\.{1,2}\/(?!.*(test|spec|mock|fixture))|import\s+["']\.{1,2}\//.test(text)
      || /\b(new\s+[A-Z][A-Za-z0-9_]*|supertest|request\(|app\.inject|TestBed|render\(|mount\(|shallowMount\()/.test(text);
    const assertsOnlyMockCalls = /\.(toHaveBeenCalled|toHaveBeenCalledWith|calledWith|calledOnce|assert_called|assert_called_once|verify\(|Received\()/.test(text)
      && !/\b(toEqual|toBe|toThrow|toMatchObject|toContain|pytest\.raises|assert\s+\w+\s*(==|!=|>|<)|XCTAssertEqual|XCTAssertThrows|\.Should\(\)\.Be)/.test(text);
    if (hasMockSignal && (!hasLocalProductionImport || assertsOnlyMockCalls)) {
      findings.push({
        rule: "mock-only-test-path",
        severity: "medium",
        repo: repo.name,
        file,
        line: "-",
        text: "Test appears mock-heavy and lacks a clear real production import/boundary execution signal.",
        suggestion: "Add or identify a test/probe that exercises the real production unit or boundary; mocks should isolate external side effects, not replace the behavior under review.",
      });
    }

    const hasSuccessSignal = /\b(success|happy|valid|ok|created|returns?|should|200|201|approved|complete|works)\b/i.test(text);
    const hasFailureSignal = /\b(error|fail|invalid|empty|null|undefined|unauthorized|forbidden|denied|reject|throw|exception|timeout|conflict|duplicate|missing|not found|404|400|401|403|409|500)\b/i.test(text);
    if (hasSuccessSignal && !hasFailureSignal && changedCode.length > 0) {
      findings.push({
        rule: "happy-path-only-test-change",
        severity: "low",
        repo: repo.name,
        file,
        line: "-",
        text: "Changed tests show success/happy-path signals but no obvious failure, invalid, empty, permission, or edge-path coverage.",
        suggestion: "For behavior that can fail, add at least one focused negative or edge-path assertion before relying on the test as regression proof.",
      });
    }
  }

  if (backendBoundaryChanged && changedTests.length > 0 && !integrationOrE2eChanged) {
    findings.push({
      rule: "backend-boundary-without-e2e-or-integration",
      severity: "medium",
      repo: repo.name,
      file: "(diff)",
      line: "-",
      text: "Backend boundary/service changed and tests changed, but no obvious e2e/integration test file changed.",
      suggestion: "Confirm the changed route/tool/handler is exercised through an integration/e2e path or explain why lower-level tests are sufficient for this boundary.",
    });
  }

  return findings;
}

function scanCrossRepoContracts(repo, repositoryCount) {
  const findings = [];
  if (repositoryCount < 2) return findings;
  const files = repo.entries.map((entry) => entry.path);
  const contractFiles = files.filter(isContractLikeFile);
  const consumerCheckFiles = files.filter((file) => isTest(file) || /(compat|consumer|integration|e2e)/i.test(file));

  if (contractFiles.length > 0 && consumerCheckFiles.length === 0) {
    findings.push({
      rule: "cross-repo-contract-without-consumer-check",
      severity: "medium",
      repo: repo.name,
      file: "(diff)",
      line: "-",
      text: `${contractFiles.length} contract/schema/API/client file(s) changed in a multi-repository packet without an obvious consumer/contract check in this repo.`,
      suggestion: "Run or add producer/consumer compatibility checks across the touched repositories, or document why this repo is not a contract owner/consumer.",
    });
  }

  return findings;
}

function scanBackendCoverage(repo) {
  const findings = [];
  const files = repo.entries.map((entry) => entry.path);
  const backendBoundary = files.filter((file) => {
    if (!isCode(file) || isTest(file)) return false;
    if (/\.(controller|route|routes|resolver|handler|tool-executor|use-case|service|repository)\./.test(file)) return true;
    if (/(^|\/)(controllers?|routes?|handlers?|resolvers?|services?|use-cases?|repositories?)\//.test(file)) return true;
    if (/(^|\/)(apps\/api|apps\/server|packages\/api|packages\/server|api|server|backend|services)\//.test(file)
      && /(controller|route|resolver|handler|tool|use-case|service|repository)/i.test(file)) return true;
    return false;
  });
  const e2eChanged = files.some((file) => /(^|\/)(e2e|tests\/e2e)\//.test(file) || /\.e2e\.[cm]?[tj]s$/.test(file));
  const testChanged = files.some(isTest);

  if (backendBoundary.length > 0 && !e2eChanged) {
    findings.push({
      rule: "backend-e2e-coverage-gap",
      severity: testChanged ? "low" : "medium",
      repo: repo.name,
      file: "(diff)",
      line: "-",
      text: `${backendBoundary.length} backend boundary/service file(s) changed and no e2e test file changed`,
      suggestion: "Confirm focused unit/integration tests exercise the real production path. Add backend e2e or route/tool integration coverage when contract, auth, persistence, or user-visible behavior changed.",
    });
  }

  return findings;
}

function scanPackageImpact(repo) {
  const findings = [];
  const files = repo.entries.map((entry) => entry.path);
  const manifestChanged = files.some((file) => /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements.*\.txt|Gemfile|composer\.json|pom\.xml|build\.gradle|build\.gradle\.kts|Package\.swift)$/.test(file));
  const lockChanged = files.some((file) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|gradle\.lockfile|Package\.resolved)$/.test(file));
  if (manifestChanged && !lockChanged) {
    findings.push({
      rule: "package-manifest-without-lockfile",
      severity: "medium",
      repo: repo.name,
      file: "(manifest)",
      line: "-",
      text: "A package manifest changed without a lockfile/checksum change.",
      suggestion: "Verify whether lockfile/checksum update is required for reproducible installs.",
    });
  }
  if (lockChanged && !manifestChanged) {
    findings.push({
      rule: "lockfile-without-manifest",
      severity: "low",
      repo: repo.name,
      file: "(lockfile)",
      line: "-",
      text: "A lockfile/checksum changed without an obvious manifest change.",
      suggestion: "Confirm this is intentional and not dependency churn.",
    });
  }
  return findings;
}

function scanArtifactImpact(repo) {
  const findings = [];
  const artifactEntries = repo.entries.filter((entry) => isGeneratedOrLocalArtifact(entry.path));
  if (artifactEntries.length > 0) {
    findings.push({
      rule: "local-or-generated-artifacts-in-diff",
      severity: "medium",
      repo: repo.name,
      file: "(diff)",
      line: "-",
      text: `${artifactEntries.length} local/generated artifact file(s) are present in the diff, including ${artifactEntries.slice(0, 3).map((entry) => entry.path).join(", ")}`,
      suggestion: "Remove local/generated artifacts from the review diff or confirm they are intentionally versioned.",
    });
  }
  return findings;
}

function riskSummary(repo) {
  const files = repo.entries.map((entry) => entry.path);
  const risks = [];
  if (files.some((file) => /auth|permission|rbac|role|session|token|secret|credential|privacy|tenant|org/i.test(file))) risks.push("security-sensitive path names");
  if (files.some((file) => /migration|schema\.prisma|\.sql$|models?\.py|entities?|repository/i.test(file))) risks.push("database schema, data access, or migration");
  if (files.some((file) => /controller|route|api|resolver|handler|endpoint|view/i.test(file))) risks.push("API or route boundary");
  if (files.some((file) => /package\.json|Cargo\.toml|go\.mod|pyproject\.toml|Gemfile|lock|turbo\.json|workflow|\.github|Dockerfile/i.test(file))) risks.push("tooling, dependency, CI, or workflow impact");
  if (files.some((file) => /\.(tsx|jsx|vue|svelte|astro|css|scss)$/.test(file))) risks.push("frontend or visual behavior");
  return risks;
}

const args = parseArgs(process.argv.slice(2));
const startConfigPath = findConfigPath(startCwd, args.configPath);
const startConfig = mergeConfig(defaultConfig, readJsonConfig(startConfigPath));

function configForRoot(root) {
  const repoConfigPath = findConfigPath(root, args.configPath);
  const repoConfig = repoConfigPath && repoConfigPath !== startConfigPath ? readJsonConfig(repoConfigPath) : {};
  return mergeConfig(startConfig, repoConfig);
}

function shouldIgnoreByConfig(file, config) {
  return (config.ignorePaths || []).some((pattern) => pathPatternToRegex(pattern).test(file));
}

function applyConfigToFindings(findings, config) {
  return findings
    .filter((finding) => config.rules?.[finding.rule] !== false)
    .filter((finding) => !shouldIgnoreByConfig(finding.file, config))
    .map((finding) => {
      const severity = config.severities?.[finding.rule];
      return severity ? { ...finding, severity } : finding;
    });
}

function buildRepos() {
  const roots = args.roots.length > 0 ? args.roots.flatMap((root) => discoverGitRoots(root, args.discoverDepth)) : discoverGitRoots(startCwd, args.discoverDepth);
  const uniqueRoots = [...new Set(roots)].sort();

  return uniqueRoots.map((root) => {
    const repoConfig = configForRoot(root);
    const entries = changedFileEntries(root, args.base);
    const changedLines = changedLineMap(root, args.base, entries);
    return {
      root,
      name: basename(root),
      config: repoConfig,
      configPath: findConfigPath(root, args.configPath) || startConfigPath || "",
      entries: (args.includeClean ? entries : entries.filter(Boolean)).filter((entry) => !shouldIgnoreByConfig(entry.path, repoConfig)),
      changedLines,
    };
  }).filter((repo) => args.includeClean || repo.entries.length > 0);
}

const repos = buildRepos();

if (repos.length === 0) {
  if (args.json) {
    console.log(JSON.stringify({
      status: "no-changed-repositories",
      startDirectory: startCwd,
      configPath: startConfigPath || null,
      repositories: [],
    }, null, 2));
    process.exit(2);
  }
  console.log("# Agentic Code Review Packet");
  console.log("");
  console.log(`Start directory: ${startCwd}`);
  console.log("Collector status: no changed Git repositories detected");
  console.log("");
  console.log("Run from a Git repository, pass one or more `--root <path>` values, or use a parent directory that contains changed Git repositories.");
  process.exit(2);
}

const allFindings = [];
let totalFiles = 0;
let totalCodeFiles = 0;
let totalTestFiles = 0;
const repositoryPackets = [];

for (const repo of repos) {
  const files = repo.entries.map((entry) => entry.path);
  const findings = applyConfigToFindings(compressFindings([
    ...scanText(repo),
    ...scanNPlusOne(repo),
    ...scanDataConsistency(repo),
    ...scanRawSqlSecurity(repo),
    ...scanWebAndRuntimeSecurity(repo),
    ...scanUnboundedDataAccess(repo),
    ...scanFrameworkSpecific(repo),
    ...scanPublicContractIntegrity(repo),
    ...scanConfigValidationIntegrity(repo),
    ...scanBundleSplitRisks(repo),
    ...scanCouplingAndComplexity(repo),
    ...scanTests(repo),
    ...scanBackendCoverage(repo),
    ...scanCrossRepoContracts(repo, repos.length),
    ...scanPackageImpact(repo),
    ...scanArtifactImpact(repo),
  ]), repo.config);
  allFindings.push(...findings);
  totalFiles += files.length;
  totalCodeFiles += files.filter((file) => isCode(file) && !isTest(file)).length;
  totalTestFiles += files.filter(isTest).length;
  const risks = riskSummary(repo);
  const severities = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] || 0) + 1;
    return acc;
  }, {});
  const questions = reviewQuestionsForRepo(repo, findings);
  const runtimeRequirements = runtimeVerificationRequirementsForRepo(repo, findings, repos.length);
  const normalized = normalizedGateSummary(findings, runtimeRequirements, questions, isTest);
  const externalTools = externalToolbelt(repo, args.runExternalTools, args.allowToolDownloads, args.externalTools, repo.config.externalToolTimeoutMs || args.externalToolTimeoutMs);

  repositoryPackets.push({
    name: repo.name,
    path: repo.root,
    configPath: repo.configPath || null,
    changedFiles: files.length,
    codeFiles: files.filter((file) => isCode(file) && !isTest(file)).length,
    testFiles: files.filter(isTest).length,
    riskSignals: risks,
    files: repo.entries.map((entry) => ({
      status: entry.status === "D" ? "deleted" : entry.status === "A" ? "added" : entry.status === "M" ? "modified" : entry.status,
      path: entry.path,
      previousPath: entry.previousPath,
    })),
    normalizedGateSummary: normalized,
    findingsSummary: {
      total: findings.length,
      high: severities.high || 0,
      medium: severities.medium || 0,
      low: severities.low || 0,
    },
    findings,
    userInputCheckpoints: questions,
    runtimeVerificationRequirements: runtimeRequirements,
    externalToolbelt: {
      mode: args.runExternalTools ? "run-installed-tools" : "inventory-only",
      downloadsEnabled: args.allowToolDownloads,
      selectedTools: args.externalTools,
      tools: externalTools,
    },
  });
}

const globalSeverities = allFindings.reduce((acc, finding) => {
  acc[finding.severity] = (acc[finding.severity] || 0) + 1;
  return acc;
}, {});

const packet = {
  status: "ok",
  startDirectory: startCwd,
  configPath: startConfigPath || null,
  repositories: repositoryPackets,
  crossRepoSummary: {
    repositoriesWithChanges: repos.length,
    changedFiles: totalFiles,
    codeFiles: totalCodeFiles,
    testFiles: totalTestFiles,
    findings: allFindings.length,
    high: globalSeverities.high || 0,
    medium: globalSeverities.medium || 0,
    low: globalSeverities.low || 0,
  },
  reviewerInstructions: [
    "Treat scanner output as signal, not proof. Verify against the code before raising a finding.",
    "Review every repository section when this packet spans multiple repositories.",
    "Prioritize concrete correctness, regression, N+1, data consistency, validation, security, maintainability, and cross-repo contract issues.",
    "When the packet is noisy, prioritize semantic/behavioral findings over magic-string, duplicated-literal, large-file, or SRP context signals unless those are verified as logic-bearing or regression-prone.",
    "Do not report style-only or hypothetical issues without code evidence.",
    "Treat User Input Checkpoints as questions to resolve before turning context-dependent scope, refactor, or coverage concerns into blocking findings.",
    "Treat Runtime Verification Requirements as required closeout evidence. Static checks, command dumps, or copied probes do not prove executable behavior.",
  ],
};

if (args.json) {
  console.log(JSON.stringify(packet, null, 2));
  process.exit(0);
}

console.log("# Agentic Code Review Packet");
console.log("");
console.log(`Start directory: ${packet.startDirectory}`);
if (packet.configPath) console.log(`Config: ${packet.configPath}`);

for (const repoPacket of packet.repositories) {
  console.log("");
  console.log(`## Repository: ${repoPacket.name}`);
  console.log(`Path: ${repoPacket.path}`);
  if (repoPacket.configPath) console.log(`Config: ${repoPacket.configPath}`);
  console.log(`Changed files: ${repoPacket.changedFiles}`);
  console.log(`Code files: ${repoPacket.codeFiles}`);
  console.log(`Test files: ${repoPacket.testFiles}`);
  console.log("");

  console.log("### Risk Signals");
  if (repoPacket.riskSignals.length === 0) {
    console.log("- none detected from paths");
  } else {
    repoPacket.riskSignals.forEach((risk) => console.log(`- ${risk}`));
  }
  console.log("");

  console.log("### Changed Files");
  if (repoPacket.files.length === 0) {
    console.log("- no git changed files detected");
  } else {
    repoPacket.files.forEach((entry) => {
      const previous = entry.previousPath ? ` from ${entry.previousPath}` : "";
      console.log(`- [${entry.status}] ${entry.path}${previous}`);
    });
  }
  console.log("");

  console.log("### Normalized Gate Summary");
  console.log(`- blocking: ${repoPacket.normalizedGateSummary.blocking}`);
  console.log(`- review-signal: ${repoPacket.normalizedGateSummary["review-signal"]}`);
  console.log(`- runtime-required: ${repoPacket.normalizedGateSummary["runtime-required"]}`);
  console.log(`- user-input-checkpoint: ${repoPacket.normalizedGateSummary["user-input-checkpoint"]}`);
  console.log(`- informational: ${repoPacket.normalizedGateSummary.informational}`);
  console.log("");

  console.log("### Deterministic Scan Findings");
  console.log(`Total: ${repoPacket.findingsSummary.total} (high: ${repoPacket.findingsSummary.high}, medium: ${repoPacket.findingsSummary.medium}, low: ${repoPacket.findingsSummary.low})`);
  if (repoPacket.findings.length === 0) {
    console.log("- no deterministic findings");
  } else {
    repoPacket.findings.slice(0, 80).forEach((finding) => {
      console.log(`- [${finding.severity}] ${finding.rule} at ${finding.file}:${finding.line}`);
      console.log(`  Evidence: ${finding.text.replace(/\s+/g, " ")}`);
      console.log(`  Suggestion: ${finding.suggestion}`);
    });
    if (repoPacket.findings.length > 80) console.log(`- truncated ${repoPacket.findings.length - 80} additional findings`);
  }
  console.log("");

  console.log("### User Input Checkpoints");
  if (repoPacket.userInputCheckpoints.length === 0) {
    console.log("- none");
  } else {
    repoPacket.userInputCheckpoints.forEach((question) => console.log(`- ${question}`));
  }
  console.log("");

  console.log("### Runtime Verification Requirements");
  if (repoPacket.runtimeVerificationRequirements.length === 0) {
    console.log("- none");
  } else {
    repoPacket.runtimeVerificationRequirements.forEach((requirement) => console.log(`- ${requirement}`));
  }
  console.log("");

  console.log("### Optional External Toolbelt");
  console.log(`Mode: ${repoPacket.externalToolbelt.mode === "run-installed-tools" ? "run installed tools" : "inventory only; pass --run-external-tools to execute installed tools"}`);
  if (!repoPacket.externalToolbelt.downloadsEnabled) console.log("Downloads: disabled; pass --allow-tool-downloads to permit npx/uvx fallback tools");
  if (repoPacket.externalToolbelt.selectedTools.length > 0) console.log(`Selected tools: ${repoPacket.externalToolbelt.selectedTools.join(", ")}`);
  if (repoPacket.externalToolbelt.tools.length === 0) {
    console.log("- none applicable");
  } else {
    repoPacket.externalToolbelt.tools.forEach((tool) => {
      console.log(`- [${tool.status}] ${tool.name}: ${tool.purpose}`);
      if (tool.available) console.log(`  Command: ${tool.command} ${tool.args.join(" ")}`);
      if (tool.installHint) console.log(`  Install: ${tool.installHint}`);
      if (tool.ran && tool.output) console.log(`  Output: ${tool.output}`);
    });
  }
}

console.log("");
console.log("## Cross-Repo Summary");
console.log(`Repositories with changes: ${packet.crossRepoSummary.repositoriesWithChanges}`);
console.log(`Changed files: ${packet.crossRepoSummary.changedFiles}`);
console.log(`Code files: ${packet.crossRepoSummary.codeFiles}`);
console.log(`Test files: ${packet.crossRepoSummary.testFiles}`);
console.log(`Findings: ${packet.crossRepoSummary.findings} (high: ${packet.crossRepoSummary.high}, medium: ${packet.crossRepoSummary.medium}, low: ${packet.crossRepoSummary.low})`);
console.log("");

console.log("## Reviewer Instructions");
packet.reviewerInstructions.forEach((instruction) => console.log(`- ${instruction}`));
