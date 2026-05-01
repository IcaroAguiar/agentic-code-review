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
  let fullRepository = false;
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
    } else if (arg === "--full-repo" || arg === "--all-files") {
      fullRepository = true;
    } else if (arg === "--scope" && argv[index + 1] === "full") {
      fullRepository = true;
      index += 1;
    } else if (arg.startsWith("--scope=") && arg.split("=").slice(1).join("=") === "full") {
      fullRepository = true;
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

  return { roots, discoverDepth, includeClean, base, head, json, configPath, runExternalTools, allowToolDownloads, fullRepository, externalToolTimeoutMs, externalTools: externalTools.filter(Boolean) };
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
  appType: "",
  ignorePaths: [],
  customQuestions: [],
  customDomainQuestions: {},
  domainCatalogs: [],
  dastTargets: [],
  performanceTargets: [],
  a11yTargets: [],
  e2eCoverageReportPaths: [],
  contractTestReportPaths: [],
  criticalFlowKeywords: ["auth", "login", "checkout", "cart", "payment", "tenant", "permission"],
  e2eCoverageMin: undefined,
  contractPassRateMin: undefined,
  externalToolTimeoutMs: undefined,
  coverageLinesMin: undefined,
  reviewFeedbackPath: "",
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
  const appType = override.appType || base.appType || "";
  const adaptiveThresholds = thresholdsForAppType(appType);
  return {
    ...base,
    ...override,
    rules: { ...(base.rules || {}), ...(override.rules || {}) },
    severities: { ...(base.severities || {}), ...(override.severities || {}) },
    appType,
    thresholds: { ...(base.thresholds || {}), ...adaptiveThresholds, ...(override.thresholds || {}) },
    ignorePaths: [...(base.ignorePaths || []), ...(override.ignorePaths || [])],
    customQuestions: [...(base.customQuestions || []), ...(override.customQuestions || [])],
    customDomainQuestions: { ...(base.customDomainQuestions || {}), ...(override.customDomainQuestions || {}) },
    domainCatalogs: [...(base.domainCatalogs || []), ...(override.domainCatalogs || [])],
    dastTargets: [...(base.dastTargets || []), ...(override.dastTargets || [])],
    performanceTargets: [...(base.performanceTargets || []), ...(override.performanceTargets || [])],
    a11yTargets: [...(base.a11yTargets || []), ...(override.a11yTargets || [])],
    e2eCoverageReportPaths: [...(base.e2eCoverageReportPaths || []), ...(override.e2eCoverageReportPaths || [])],
    contractTestReportPaths: [...(base.contractTestReportPaths || []), ...(override.contractTestReportPaths || [])],
    criticalFlowKeywords: override.criticalFlowKeywords || base.criticalFlowKeywords || [],
  };
}

function thresholdsForAppType(appType) {
  if (appType === "microservice" || appType === "public-api") {
    return {
      largeFileLines: 420,
      veryLargeFileLines: 850,
      longFunctionLines: 65,
      veryLongFunctionLines: 120,
      highImportCount: 22,
      wideConstructorParams: 7,
    };
  }
  if (appType === "monolith") {
    return {
      largeFileLines: 650,
      veryLargeFileLines: 1200,
      largeRefactorLines: 950,
      longFunctionLines: 95,
      veryLongFunctionLines: 160,
      highImportCount: 32,
      wideConstructorParams: 10,
    };
  }
  return {};
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
  if (args.fullRepository) return trackedFileEntries(root);

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

function trackedFileEntries(root) {
  const tracked = args.head
    ? run("git", ["ls-tree", "-r", "--name-only", args.head], root)
    : run("git", ["ls-files"], root);
  return splitLines(tracked.ok ? tracked.stdout : "").map((path) => ({ path, status: "T" }));
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
  if (args.fullRepository) {
    return new Map(entries.map((entry) => [entry.path, null]));
  }

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
  return /(^|\/)(\.playwright-cli|playwright-report|test-results|coverage|dist|build|__pycache__)\//.test(file)
    || /(^|\/)\.vscode\//.test(file)
    || /(^|\/)[^/]+\.egg-info\//.test(file)
    || /\.(pyc|pyo)$/i.test(file)
    || /(^|\/)docs\/ai\/screenshots\//.test(file)
    || /(^|\/)routeTree\.gen\.[cm]?[jt]sx?$/.test(file)
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
  return /(^|\/)(__tests__|tests?|e2e|specs?)\//.test(file)
    || /\.(spec|test|e2e)\.[cm]?[tj]sx?$/.test(file)
    || /^test_.*\.py$/.test(basename(file))
    || /_test\.(py|go|exs)$/.test(basename(file))
    || /(Test|Tests|Spec|Specs)\.(java|kt|kts|cs|scala|php|swift)$/.test(basename(file))
    || /_(spec|test)\.rb$/.test(file)
    || /_spec\.rb$/.test(file)
    || /\.feature$/.test(file);
}

function isTestConfig(file) {
  return /(^|\/)(playwright|vitest|jest|cypress|karma|wdio|test|testing)[\w.-]*\.config\.[cm]?[jt]s$/i.test(file)
    || /(^|\/)(playwright|vitest|jest|cypress|wdio)\.config\./i.test(file);
}

function addFinding(findings, rule, severity, repo, file, line, text, suggestion) {
  const finding = {
    rule,
    severity,
    repo,
    file,
    line,
    text: String(text || "").trim().slice(0, 260),
    suggestion,
    domain: classifyDomain(file, text),
    importance: classifyImportance(rule, severity, file, text),
  };
  const suggestedPatch = suggestedPatchForFinding(finding);
  if (suggestedPatch) finding.suggestedPatch = suggestedPatch;
  findings.push(finding);
}

function suggestedPatchForFinding(finding) {
  if (finding.rule === "nestjs-nested-dto-without-type-transform") {
    return {
      mode: "dry-run",
      confidence: "medium",
      source: "agentic-code-review",
      patch: `--- a/${finding.file}\n+++ b/${finding.file}\n@@\n-import { ValidateNested } from "class-validator";\n+import { ValidateNested } from "class-validator";\n+import { Type } from "class-transformer";\n@@\n   @ValidateNested()\n+  @Type(() => NestedDto)\n   field!: NestedDto;\n`,
      notes: "Replace NestedDto/field with the concrete DTO and property. This is a safe suggestion only when the field type is a DTO class and ValidationPipe transform behavior is enabled or expected.",
    };
  }
  if (finding.rule === "nestjs-mutating-route-without-auth-signal") {
    return {
      mode: "dry-run",
      confidence: "low",
      source: "agentic-code-review",
      patch: `--- a/${finding.file}\n+++ b/${finding.file}\n@@\n+@UseGuards(AuthGuard)\n @Post(...)\n`,
      notes: "Choose the project-specific guard or explicit public-route decorator. Do not apply blindly to intentionally public routes.",
    };
  }
  if (finding.rule === "external-call-without-timeout-or-resilience") {
    return {
      mode: "dry-run",
      confidence: "low",
      source: "agentic-code-review",
      patch: `--- a/${finding.file}\n+++ b/${finding.file}\n@@\n-  return await client.call(input);\n+  return await circuitBreaker.execute(() => client.call(input, { timeoutMs: DEFAULT_TIMEOUT_MS }));\n`,
      notes: "Adapt to the local HTTP/client library. The reviewer must verify timeout, retry/backoff, breaker state, fallback, and idempotency semantics.",
    };
  }
  if (finding.rule === "ui-hardcoded-text-without-i18n") {
    return {
      mode: "dry-run",
      confidence: "medium",
      source: "agentic-code-review",
      patch: `--- a/${finding.file}\n+++ b/${finding.file}\n@@\n-  return <span>Texto visivel</span>;\n+  return <FormattedMessage id=\"screen.label\" defaultMessage=\"Texto visivel\" />;\n`,
      notes: "Use the project's i18n library and message id conventions. Include plural/date/currency formatting when the string carries dynamic values.",
    };
  }
  return null;
}

function classifyDomain(file, text = "") {
  const value = `${file}\n${text}`;
  if (/\b(auth|login|session|cookie|csrf|jwt|oauth|sso|mfa|password|credential|permission|rbac|role|policy|guard)\b/i.test(value)) return "auth";
  if (/\b(payment|billing|invoice|creditCard|card|pix|bank|ledger|transaction|finance|amount|price|refund)\b/i.test(value)) return "financial";
  if (/\b(patient|health|medical|diagnosis|clinic|hipaa|lab|prescription)\b/i.test(value)) return "health";
  if (/\b(cpf|cnpj|lgpd|privacy|consent|personalData|pii|email|phone|address|birth)\b/i.test(value)) return "privacy";
  if (/\b(upload|file|storage|bucket|s3|blob|attachment|media)\b/i.test(value)) return "file-storage";
  if (/\b(webhook|callback|redirect|url|http|fetch|axios|request)\b/i.test(value)) return "integration";
  if (/\b(tenant|organization|orgUnit|workspace|account)\b/i.test(value)) return "multi-tenant";
  return "general";
}

function classifyImportance(rule, severity, file, text = "") {
  if (severity === "high") return "high";
  if (/auth|financial|privacy|multi-tenant/.test(classifyDomain(file, text))) return severity === "medium" ? "high" : "medium";
  if (/injection|xss|csrf|ssrf|redirect|crypto|cookie|upload|webhook|secret|rate-limit/i.test(rule)) return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function shouldScanLine(repo, file, line) {
  const changedLines = repo.changedLines?.get(file);
  if (changedLines === null) return true;
  if (!changedLines) return false;
  return changedLines.has(line);
}

function shouldTrackDuplicatedLiteral(file, lineText, value) {
  if (/^\s*(?:import|export)\b/.test(lineText) && /\bfrom\s*["'`]|require\s*\(|import\s*\(/.test(lineText)) return false;
  if (/\b(className|className=|cn\s*\(|cva\s*\(|class\s*=|variant|variants)\b/.test(lineText)) {
    if (/^(?:[a-z]+:)*-?[a-z0-9]+(?:-[a-z0-9/[\].:%#]+)+$/i.test(value)) return false;
    if (/^(button|outline|ghost|default|primary|secondary|sm|md|lg|xl|xs|solid|muted|destructive)$/.test(value)) return false;
  }
  if (/^(react|react-dom|sonner|lucide-react|@?[a-z0-9_.-]+\/[a-z0-9_./-]+)$/i.test(value)) return false;
  if (/^\.\.?\//.test(value)) return false;
  if (/^[a-z0-9_.-]+\/[a-z0-9_./-]+$/i.test(value) && !/\b(status|state|role|permission|action|type|event|code|scope|provider)\b/i.test(lineText)) return false;
  if (isTest(file) && /^(user|tenant|org|project|submission|review|file|doc)-?\d+$/i.test(value)) return false;
  return true;
}

function isStaticRuleDefinitionWindow(window) {
  return (/\baddFinding\s*\(|\bsuggestion\s*:|Suggested patch|const patterns\s*=\s*\[/.test(window)
    && /\b(rule|severity|finding|scan|risk|suggestion|regex|pattern)\b/i.test(window))
    || (/"[\w-]+"/.test(window) && /\b(findings|repo\.name|window|severity|suggestion|rule)\b/.test(window))
    || (/\bfunction\s+\w*(?:Pattern|Target|Controlled|Validator|Rule|Window)\b|\bconst\s+\w*Pattern\b/.test(window) && /\/.*\\b/.test(window));
}

function nearbyStaticRuleDefinition(lines, index, forward = 8) {
  return isStaticRuleDefinitionWindow(lines.slice(Math.max(0, index - 8), Math.min(index + forward, lines.length)).join("\n"));
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

      const unsafeBroadType = /as\s+any|unknown\s+as\s+|typing\.Any\b|interface\s*{}\s*$|map\[string\]interface\s*{}/.test(lineText)
        || (/\.[cm]?[jt]sx?$/.test(file) && /(:\s*any\b|<any>|Array<any>|Promise<any>|Record<[^>]*any|any\[\])/.test(lineText));
      if (unsafeBroadType) {
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
        if (!shouldTrackDuplicatedLiteral(file, lineText, value)) continue;
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
    /\b(await\s+)?[\w.$]+\.(findMany|findFirst|findUnique|findOne|find|findAll|count|aggregate|groupBy|where|select|insert|save|all|one|first|query)\s*\(/,
    /\b(session|db|repo|repository|client|prisma|knex|sequelize|mongoose|typeorm|entityManager|em|ActiveRecord|Repo)\b.*\.(query|execute|find|findAll|findOne|where|select|get|all|one|first|save|create|update|delete)\s*\(/i,
    /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i,
    /\b(objects\.(filter|get|create)|Repo\.(all|get|insert|update|delete)|DB::table|Model::where)\b/,
  ];
  return patterns.some((pattern) => pattern.test(line));
}

function hasVariableCardinalityIteration(line, window) {
  return /\b(for|foreach|while|each)\b|\.(forEach|map|flatMap|collect)\s*\(/.test(line)
    || /\bPromise\.all\s*\(\s*[\w.]+\.map\s*\(/.test(window)
    || /\b(asyncio\.gather|Task\.WhenAll|errgroup\.Group|join_all)\s*\([^)]*(?:map|for|select)\b/i.test(window);
}

function hasUserControlledRedirectTarget(line, window) {
  if (!/\bredirect\s*\(|res\.redirect|router\.push|navigate\s*\(|window\.location|location\.href/.test(line)) return false;
  if (/to\s*:\s*["'`]\/[^"'`]*["'`]/.test(window) && !/\b(returnTo|redirectTo|callback|next|url|href|query|params|body|request|req\.)\s*[,}:]/i.test(window)) return false;
  return /\b(req\.|request\.|query\.|params\.|body\.|returnTo|redirectTo|callback|nextUrl|next)\b/i.test(window)
    || /\b(?:url|href)\b/i.test(line) && /\b(req\.|request\.|query\.|params\.|body\.|returnTo|redirectTo|callback|nextUrl|next)\b/i.test(window)
    || /\bredirect\s*\(\s*[^"'`{]/.test(line)
    || /\b(?:window\.location|location\.href)\s*=\s*[^"'`]/.test(line);
}

function hasUserControlledFetchTarget(line, window) {
  if (!/\b(fetch|axios|request|http\.get|http\.request|urllib|requests\.get|Net::HTTP|Faraday)\s*\(/.test(line)) return false;
  const callTarget = line.match(/\b(?:fetch|axios|request|http\.get|http\.request|urllib|requests\.get|Net::HTTP|Faraday)\s*\(\s*([^,\n)]+)/)?.[1] || "";
  if (/\b(this\.baseUrl|baseUrl|BASE_URL|process\.env|config\.|settings\.|env\.)\b/.test(callTarget) && !/\b(req\.|request\.|params\.|query\.|body\.|input\.|callback|webhook)\b/.test(callTarget)) return false;
  if (/\b(req\.|request\.|params\.|query\.|body\.|input\.|callback|webhook)\b/i.test(callTarget)) return true;
  if (/\b(url|uri|href|target|endpoint)\b/i.test(callTarget) && /\b(req\.|request\.|params\.|query\.|body\.|input\.|callback|webhook)\b/i.test(window)) return true;
  return false;
}

function readQueryPatternForLine(line) {
  const patterns = [
    /\b(await\s+)?[\w.$]+\.(findMany|findFirst|findUnique|findOne|find|findAll|count|aggregate|groupBy|where|select|get|all|one|first|query)\s*\(/,
    /\b(session|db|repo|repository|client|prisma|knex|sequelize|mongoose|typeorm|entityManager|em|ActiveRecord|Repo)\b.*\.(query|execute|find|findAll|findOne|where|select|get|all|one|first)\s*\(/i,
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
  const loopPattern = /\b(for|foreach|while|each)\b|\.(forEach|map|flatMap|collect)\s*\(/;
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
      if (isStaticRuleDefinitionWindow(window) || nearbyStaticRuleDefinition(lines, index, windowLineCount)) return;
      const hasQueryInWindow = window.split(/\r?\n/).some(queryPatternForLine);
      const signature = `${file}:${line}:${window.replace(/\s+/g, " ").slice(0, 180)}`;
      if (seen.has(signature)) return;

      if (loopPattern.test(lineText) && hasQueryInWindow && hasVariableCardinalityIteration(lineText, window)) {
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

      if (/\b(Promise\.all|asyncio\.gather|Task\.WhenAll|errgroup\.Group|join_all)\b/.test(window) && hasQueryInWindow && hasVariableCardinalityIteration(lineText, window)) {
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
      if (isStaticRuleDefinitionWindow(window) || nearbyStaticRuleDefinition(lines, index, 16)) return;

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
            isTest(file) ? "low" : "medium",
            repo.name,
            file,
            line,
            window,
            isTest(file)
              ? "Test setup read/write sequences can be acceptable. Verify they are isolated, deterministic, and do not hide a production race."
              : "Check whether the read/write pair needs a transaction, unique constraint, upsert, lock, or optimistic concurrency guard."
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
  const uploadFindingsByFile = new Set();
  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    const text = readFile(repo.root, file);
    const fileLevelUploadValidation = /\b(fileFilter|mime|mimetype|contentType|extension|size|limits?\s*:|maxFileSize|maxSize|sanitize|safeOriginalName|assertSafePath|basename|virus|scan|allowlist|storage)\b/i.test(text);
    const lines = text.split(/\r?\n/);

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(index, Math.min(index + 8, lines.length)).join("\n");
      if (!windowTouchesChangedLine(repo, file, line, window.split(/\r?\n/).length)) return;
      if (isStaticRuleDefinitionWindow(window) || nearbyStaticRuleDefinition(lines, index, 8)) return;

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

      if (/\b(MD5|SHA1|sha1|md5|createHash\s*\(\s*["'`](md5|sha1)|hashlib\.(md5|sha1)|MessageDigest\.getInstance\s*\(\s*["'`](MD5|SHA-?1))/i.test(lineText)
        && !/\b(non[-_ ]security|checksum|etag|cache|dedupe|fingerprint|legacy compatibility)\b/i.test(window)) {
        addFinding(
          findings,
          "weak-cryptographic-hash",
          "high",
          repo.name,
          file,
          line,
          window,
          "Do not use MD5/SHA-1 for security-sensitive hashing. Use a modern password KDF or SHA-256+ only for non-password integrity with explicit non-security rationale."
        );
      }

      if (/\b(createCipher\s*\(|DES|3DES|RC4|ECB|AES-?ECB|NoPadding)\b|Cipher\.getInstance\s*\(\s*["'`][^"'`]*(DES|RC4|ECB|NoPadding)/i.test(lineText)) {
        addFinding(
          findings,
          "insecure-crypto-algorithm-or-mode",
          "high",
          repo.name,
          file,
          line,
          window,
          "Use authenticated encryption such as AES-GCM/ChaCha20-Poly1305 and avoid deprecated algorithms, ECB mode, and legacy createCipher APIs."
        );
      }

      if (/\b(password|passwd)\b/i.test(window)
        && /\b(hash|digest|createHash|bcrypt|scrypt|argon2|pbkdf2)\b/i.test(window)
        && !/\b(salt|argon2|bcrypt|scrypt|pbkdf2)\b/i.test(window)) {
        addFinding(
          findings,
          "password-hash-without-salt-or-kdf",
          "high",
          repo.name,
          file,
          line,
          window,
          "Password storage should use a salted adaptive KDF such as Argon2id, bcrypt, scrypt, or PBKDF2 with explicit parameters."
        );
      }

      if (/["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^"'`]+["'`]/i.test(lineText)) {
        addFinding(
          findings,
          "insecure-http-url",
          "medium",
          repo.name,
          file,
          line,
          lineText,
          "Use HTTPS for external communication, or document why this endpoint is strictly internal/test-only and protected."
        );
      }

      if (/(Access-Control-Allow-Origin|cors\s*\(|origin\s*:)\s*["'`*]/i.test(lineText)
        || /origin\s*:\s*(true|\*)/i.test(window)) {
        addFinding(
          findings,
          "permissive-cors-policy",
          "high",
          repo.name,
          file,
          line,
          window,
          "Avoid wildcard/reflected CORS. Use an allowlist per environment and ensure credentials are not enabled for broad origins."
        );
      }

      if (/(setCookie|cookie\s*\(|res\.cookie|Set-Cookie|cookies\.set)/.test(lineText)
        && !/\b(SameSite|sameSite|secure\s*:\s*true|httpOnly\s*:\s*true|HttpOnly|Secure)\b/.test(window)) {
        addFinding(
          findings,
          "cookie-missing-security-attributes",
          "high",
          repo.name,
          file,
          line,
          window,
          "Session/auth cookies should set HttpOnly, Secure, and SameSite with an explicit policy unless this is a documented non-browser cookie."
        );
      }

      if (hasUserControlledRedirectTarget(lineText, window)
        && !/\b(allowlist|whitelist|safeRedirect|validateRedirect|sameOrigin|new URL\(|URLPattern)\b/i.test(window)) {
        addFinding(
          findings,
          "open-redirect-risk",
          "high",
          repo.name,
          file,
          line,
          window,
          "Validate redirects with a same-origin or explicit allowlist helper before using user-controlled URLs."
        );
      }

      if (hasUserControlledFetchTarget(lineText, window)
        && !/\b(allowlist|whitelist|validateUrl|safeUrl|blockPrivate|isPrivateIp|URLPattern|sameOrigin)\b/i.test(window)) {
        addFinding(
          findings,
          "ssrf-risk-unvalidated-url-fetch",
          "high",
          repo.name,
          file,
          line,
          window,
          "Validate outbound URLs with scheme/host allowlists and private-network blocking before fetching user-controlled locations."
        );
      }

      if (!uploadFindingsByFile.has(file)
        && /\b(multer|busboy|formidable|multipart|upload|fileUpload|UploadedFile|IFormFile|MultipartFile|Express\.Multer\.File)\b/i.test(window)
        && !fileLevelUploadValidation) {
        uploadFindingsByFile.add(file);
        addFinding(
          findings,
          "file-upload-without-validation",
          "high",
          repo.name,
          file,
          line,
          window,
          "Uploads need size limits, MIME/extension allowlists, filename sanitization, safe storage, and malware scanning when appropriate."
        );
      }

      if (/\b(webhook|stripe|github|slack|callback)\b/i.test(window)
        && /\b(post|handler|controller|route|receive|payload|body)\b/i.test(window)
        && !/\b(signature|verify|hmac|timingSafeEqual|constructEvent|webhookSecret)\b/i.test(window)) {
        addFinding(
          findings,
          "webhook-without-signature-verification",
          "high",
          repo.name,
          file,
          line,
          window,
          "Webhook endpoints should verify provider signatures/HMAC before trusting payload content."
        );
      }

      if (/\b(login|password|otp|mfa|resetPassword|forgotPassword|token|session)\b/i.test(window)
        && /\b(Post|post|router\.|controller|handler|route|mutation)\b/i.test(window)
        && !/\b(rateLimit|throttle|slowDown|brute|lockout|captcha|attempt)\b/i.test(window)) {
        addFinding(
          findings,
          "auth-boundary-without-rate-limit-signal",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Authentication-sensitive endpoints should have rate limiting, throttling, lockout, or brute-force controls at the route or gateway boundary."
        );
      }

      if (!isTestConfig(file)
        && /\b(retry|retries|while\s*\(|for\s*\(|setInterval|poll)\b/i.test(window)
        && /\b(fetch|axios|request|http|queue|job|publish|send|client\.)\b/i.test(window)
        && !/\b(backoff|jitter|exponential|timeout|circuitBreaker|retryAfter|maxAttempts)\b/i.test(window)) {
        addFinding(
          findings,
          "retry-without-backoff-or-timeout",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Retries/polling around network or queue calls should include bounded attempts, timeout, backoff, and jitter to avoid thundering-herd failures."
        );
      }

      if (/\b(global|static|singleton|cache|Map|Set|dict|list|array|var\s+|let\s+)\b/i.test(window)
        && /\b(push|set\s*\(|delete\s*\(|clear\s*\(|append|extend|\+\+|--|\+=|-=)\b/.test(window)
        && /\b(async|await|Promise\.all|goroutine|go\s+func|thread|Thread|Task|parallel|concurrent|worker)\b/i.test(text)
        && !/\b(mutex|lock|synchronized|atomic|semaphore|queue|channel|Concurrent|RWMutex|sync\.|threading\.Lock)\b/i.test(window)) {
        addFinding(
          findings,
          "shared-state-without-lock-signal",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Changed code mutates shared state in a concurrent/async context without an obvious lock, queue, atomic primitive, or single-writer boundary."
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

function scanObservabilityAndResilience(repo) {
  const findings = [];
  const serviceLikePath = /(^|\/)(services?|clients?|gateways?|adapters?|integrations?|jobs?|workers?|controllers?|routes?|handlers?|repositories?)\//i;
  const allSourceText = existingFiles(repo.root, repo.entries)
    .filter((value) => isCode(value) && !isTest(value))
    .map((file) => readFile(repo.root, file))
    .join("\n");
  const hasCorrelationBoundary = /\b(x-correlation-id|correlationId|requestId|AsyncLocalStorage|cls-hooked|nestjs-cls|ContinuationLocalStorage|MDC|HandlerInterceptor|OncePerRequestFilter|TraceId|traceId)\b/i.test(allSourceText);
  const hasOtelOrMetricsBoundary = /\b(OpenTelemetry|otel|trace|span|meter|metrics|prometheus|histogram|counter|duration|latency|MeterRegistry|ObservationRegistry)\b/i.test(allSourceText);

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const appType = repo.config.appType || "";
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 5), Math.min(lines.length, index + 10)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 5), window.split(/\r?\n/).length)) return;

      if (/\b(logger\.(error|warn)|console\.(error|warn))\s*\(/.test(lineText)
        && /\b(error|exception|failed|unauthorized|forbidden|denied|auth|permission|request)\b/i.test(window)
        && !/\b(requestId|correlationId|traceId|spanId|tenantId|userId|redact|sanitize|safeLog|metadata|context)\b/i.test(window)) {
        addFinding(
          findings,
          "unstructured-error-log-without-correlation",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Operational error logs should be structured and include safe correlation identifiers such as requestId/traceId/tenantId, with sensitive fields redacted."
        );
      }

      if (/\b(catch\s*\(|except\s+|rescue\s+)/.test(lineText)
        && /\b(auth|login|permission|forbidden|unauthorized|access denied|denied|token|session)\b/i.test(window)
        && !/\b(audit|securityLog|logger|metrics|counter|trace|span|record[A-Z]?Event)\b/i.test(window)) {
        addFinding(
          findings,
          "security-event-without-observability-signal",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Auth/permission failures should produce safe audit/log/metric signals so operations can detect abuse and regressions."
        );
      }

      if (/\b(fetch|axios|request|http\.request|http\.get|grpc|GraphQLClient|PrismaClient|new\s+[A-Z][A-Za-z0-9_]*Client)\b/.test(window)
        && serviceLikePath.test(file)
        && !/\b(timeout|AbortController|signal|deadline|cancelToken|retry|backoff|circuitBreaker|breaker|bulkhead)\b/i.test(window)
        && !emitted.has("external-call-without-timeout-or-resilience")) {
        emitted.add("external-call-without-timeout-or-resilience");
        addFinding(
          findings,
          "external-call-without-timeout-or-resilience",
          appType === "microservice" || appType === "public-api" ? "medium" : "low",
          repo.name,
          file,
          line,
          window,
          "External service calls should define timeout/deadline behavior and, when critical, retry/backoff/circuit-breaker policy."
        );
      }

      if (/\b(fetch|axios|request|http\.request|http\.get|grpc|GraphQLClient|new\s+[A-Z][A-Za-z0-9_]*(Client|Gateway|Sdk))\b/.test(window)
        && serviceLikePath.test(file)
        && !/\b(circuitBreaker|breaker|opossum|cockatiel|resilience4j|CircuitBreakerFactory|fallback|halfOpen|OPEN|HALF_OPEN|CLOSED)\b/i.test(window)
        && !emitted.has("external-call-without-circuit-breaker")) {
        emitted.add("external-call-without-circuit-breaker");
        addFinding(
          findings,
          "external-call-without-circuit-breaker",
          appType === "microservice" || appType === "public-api" ? "medium" : "low",
          repo.name,
          file,
          line,
          window,
          "Critical external calls should have circuit-breaker or fallback policy when repeated failures can cascade. Verify CLOSED/OPEN/HALF_OPEN behavior, recovery timeout, and safe fallback where appropriate."
        );
      }

      if ((appType === "microservice" || appType === "public-api")
        && /\b(controllers?|handlers?|routes?|jobs?|workers?|consumer|message|request)\b/i.test(file + "\n" + window)
        && !hasOtelOrMetricsBoundary
        && !emitted.has("critical-boundary-without-instrumentation-signal")) {
        emitted.add("critical-boundary-without-instrumentation-signal");
        addFinding(
          findings,
          "critical-boundary-without-instrumentation-signal",
          "low",
          repo.name,
          file,
          line,
          "No OpenTelemetry/metrics signal detected in changed critical boundary.",
          "For public APIs and microservices, consider trace/span and metrics coverage for latency, error rate, and saturation on critical boundaries."
        );
      }

      if ((appType === "microservice" || appType === "public-api" || /(^|\/)(controllers?|routes?|middleware|interceptors?|filters?|main)\//i.test(file))
        && /\b(req|request|context|controller|handler|middleware|interceptor|route)\b/i.test(file + "\n" + window)
        && !hasCorrelationBoundary
        && !emitted.has("missing-correlation-id-boundary")) {
        emitted.add("missing-correlation-id-boundary");
        addFinding(
          findings,
          "missing-correlation-id-boundary",
          "medium",
          repo.name,
          file,
          line,
          "No request correlation boundary detected across changed service/API files.",
          "Add middleware/interceptor/filter support that creates or propagates x-correlation-id, stores it in AsyncLocalStorage/CLS/request context, and includes it in structured logs and outbound headers."
        );
      }
    });
  }

  return findings;
}

function resolveLocalImport(fromFile, specifier, files) {
  if (!specifier || !specifier.startsWith(".")) return "";
  const baseParts = fromFile.split("/");
  baseParts.pop();
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  const base = baseParts.join("/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}.java`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => files.has(candidate)) || "";
}

function buildLocalDependencyGraph(repo) {
  const graph = new Map();
  const files = new Set(existingFiles(repo.root, repo.entries).filter((value) => isCode(value)));
  for (const file of files) {
    const text = readFile(repo.root, file);
    const deps = new Set();
    const importPatterns = [
      /\bimport(?:\s+type)?[\s\S]{0,180}?\bfrom\s*["'`]([^"'`]+)["'`]/g,
      /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      /\bfrom\s+([.][\w./-]+)\s+import\b/g,
    ];
    for (const pattern of importPatterns) {
      for (const match of text.matchAll(pattern)) {
        const resolved = resolveLocalImport(file, match[1], files);
        if (resolved) deps.add(resolved);
      }
    }
    graph.set(file, deps);
  }
  return graph;
}

function detectGraphCycles(graph, limit = 8) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(file) {
    if (cycles.length >= limit) return;
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      if (start >= 0) cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dep of graph.get(file) || []) visit(dep);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of graph.keys()) visit(file);
  return cycles;
}

function scanRepositoryGraphAndFlows(repo) {
  const findings = [];
  const graph = buildLocalDependencyGraph(repo);
  const cycles = detectGraphCycles(graph);
  for (const cycle of cycles) {
    const file = cycle[0];
    if (changedLineCount(repo, file) === 0) continue;
    addFinding(
      findings,
      "dependency-cycle-detected",
      "medium",
      repo.name,
      file,
      "-",
      cycle.join(" -> "),
      "Break circular dependencies through a narrower port/interface, extracted shared helper, or clearer layer boundary before the cycle hardens."
    );
  }

  for (const [file, deps] of graph.entries()) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const depTexts = [...deps].map((dep) => [dep, readFile(repo.root, dep)]);
    const isBoundary = /(controller|resolver|route|handler|page|component)\.[cm]?[jt]sx?$|(^|\/)(controllers?|resolvers?|routes?|handlers?|pages?|components?)\//i.test(file);
    const sensitiveBoundary = isBoundary && /\b(password|token|secret|credential|cpf|cnpj|pii|personalData|permission|role|tenantId|session|cookie)\b/i.test(text);
    const hasPersistenceDep = depTexts.some(([dep, depText]) => /(repository|prisma|typeorm|sequelize|mongoose|database|persistence|dao)\b/i.test(dep + "\n" + depText));
    if (sensitiveBoundary && hasPersistenceDep) {
      addFinding(
        findings,
        "sensitive-data-crosses-layer-without-boundary",
        "medium",
        repo.name,
        file,
        "-",
        "Sensitive/auth/privacy vocabulary in boundary file depends on persistence/data layer through local import graph.",
        "Route sensitive data through explicit application services, DTOs, policies, and redaction/authorization boundaries instead of leaking it across presentation/transport and persistence layers."
      );
    }

    if (isBoundary && depTexts.some(([, depText]) => /\b(for|forEach|map)\s*\(|for\s*\([^)]*of[^)]*\)/.test(depText) && /\b(findMany|findUnique|findOne|findAll|query|select|SELECT)\s*\(/i.test(depText))) {
      addFinding(
        findings,
        "n-plus-one-through-route-call-chain-signal",
        "medium",
        repo.name,
        file,
        "-",
        "Boundary file imports code whose local dependency text combines iteration and query calls.",
        "Use the call/dependency graph to inspect the route/resolver path for N+1 behavior; batch, join, prefetch, or DataLoader the access before approving scale-sensitive paths."
      );
    }
  }

  return findings;
}

function scanAsyncEventsAndServerless(repo) {
  const findings = [];
  const eventFilePattern = /(queue|consumer|worker|job|processor|subscriber|listener|event|handler|lambda|function|serverless)\b/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => (isCode(value) || isStructuredConfig(value)) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    if (!eventFilePattern.test(file + "\n" + text)) continue;
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 6), Math.min(lines.length, index + 14)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 6), window.split(/\r?\n/).length)) return;

      if (/\b(process[A-Z]?\w*|handle[A-Z]?\w*|consume[A-Z]?\w*|subscribe|onMessage|MessagePattern|EventPattern|Queue|Worker|Consumer|lambda|handler)\b/i.test(window)
        && /\b(queue|topic|event|message|job|sqs|sns|kafka|rabbit|bull|pubsub|lambda)\b/i.test(window)
        && !/\b(idempot|dedup|messageId|eventId|jobId|idempotencyKey|once|unique|processed|lock|outbox|inbox)\b/i.test(window)
        && !emitted.has("event-consumer-without-idempotency-signal")) {
        emitted.add("event-consumer-without-idempotency-signal");
        addFinding(
          findings,
          "event-consumer-without-idempotency-signal",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Async consumers should show idempotency/deduplication or processed-message state because retries and duplicate delivery are normal in queues/events."
        );
      }

      if (/\b(retry|attempt|backoff|concurrency|parallel|worker|queue|rateLimit)\b/i.test(window)
        && !/\b(maxAttempts|maxRetries|exponential|jitter|delay|backoff|timeout|concurrency\s*[:=]\s*\d+|limiter|Semaphore|p-limit)\b/i.test(window)
        && !emitted.has("event-worker-without-backoff-or-concurrency-limit")) {
        emitted.add("event-worker-without-backoff-or-concurrency-limit");
        addFinding(
          findings,
          "event-worker-without-backoff-or-concurrency-limit",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Workers and event processors should bound retries, backoff, timeout, and concurrency to avoid duplicate writes or thundering-herd failures."
        );
      }
    });

    if (/(serverless\.ya?ml|template\.ya?ml|function|lambda|vercel\.json|netlify\.toml)$/i.test(file)
      && /\b(handler|runtime|functions?|lambda|memory|timeout|duration)\b/i.test(text)
      && !/\b(timeout|timeoutSeconds|maxDuration|memorySize|memory|reservedConcurrency|concurrency)\b/i.test(text)) {
      addFinding(
        findings,
        "serverless-function-without-runtime-limits",
        "medium",
        repo.name,
        file,
        "-",
        "Serverless/function config has runtime/function signals but no obvious timeout, memory, max duration, or concurrency controls.",
        "Set explicit timeout/memory/concurrency limits and test the failure mode so production cannot hang, exhaust quota, or retry unsafe work indefinitely."
      );
    }
  }

  return findings;
}

function scanFrameworkSpecific(repo) {
  const findings = [];
  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const decoratorCount = (text.match(/@(Get|Post|Put|Patch|Delete|MessagePattern|EventPattern)\b/g) || []).length;
    const isTypeScript = /\.[cm]?tsx?$/.test(file);
    const isNestController = isTypeScript && /\.controller\.[cm]?ts$/.test(file) && /@Controller\b/.test(text);
    const isNestProvider = isTypeScript && /\.(service|use-case|handler|processor|resolver|guard|interceptor|strategy)\.[cm]?ts$/.test(file) && /@(Injectable|Resolver|Processor|Catch|Controller)\b/.test(text);
    const isNestDto = isTypeScript && /\.dto\.[cm]?ts$/.test(file);

    if (/\.controller\.[cm]?[tj]s$/.test(file) && lines.length > 240) {
      findings.push({
        rule: "large-controller",
        severity: "low",
        repo: repo.name,
        file,
        line: "-",
        text: `${lines.length} lines, ${decoratorCount} route decorators`,
        suggestion: "Move orchestration/business logic into use cases/services and keep controllers thin.",
      });
    }

    if (/\.dto\.[cm]?[tj]s$/.test(file) && !/@(Is|Validate|Array|Type|Transform|Expose|ApiProperty)/.test(text)) {
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

    if (isNestController && /\b(PrismaService|Repository|DataSource|EntityManager|Model<|\.findMany\s*\(|\.findUnique\s*\(|\.save\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.\$transaction\s*\(|createQueryBuilder\s*\()\b/.test(text)) {
      addFinding(
        findings,
        "nestjs-controller-direct-data-access",
        "low",
        repo.name,
        file,
        lineForFirstOccurrence(text, "PrismaService") !== "-" ? lineForFirstOccurrence(text, "PrismaService") : lineForFirstOccurrence(text, "Repository"),
        "NestJS controller appears to depend on persistence/query behavior directly.",
        "Keep controllers thin. Route through an application service/use case/port so validation, authorization, transaction, and orchestration policies stay outside the HTTP adapter."
      );
    }

    if (isNestController) {
      const classGuardSignal = /@(UseGuards|ApiBearerAuth|Public|AllowAnonymous|SkipAuth|Roles|Permissions|Require[A-Za-z0-9_]*|Auth[A-Za-z0-9_]*)\b|\b(AuthGuard|JwtAuthGuard|PermissionsGuard|RolesGuard|CurrentUser|RequestUser)\b/i.test(text);
      lines.forEach((lineText, index) => {
        if (!/@(Post|Put|Patch|Delete)\s*\(/.test(lineText)) return;
        const line = index + 1;
        if (!shouldScanLine(repo, file, line)) return;
        const window = lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 12)).join("\n");
        if (classGuardSignal || /@(UseGuards|ApiBearerAuth|Public|AllowAnonymous|SkipAuth|Roles|Permissions|Require[A-Za-z0-9_]*|Auth[A-Za-z0-9_]*)\b|\b(AuthGuard|JwtAuthGuard|PermissionsGuard|RolesGuard|CurrentUser|RequestUser)\b/i.test(window)) return;
        addFinding(
          findings,
          "nestjs-mutating-route-without-auth-signal",
          "low",
          repo.name,
          file,
          line,
          window,
          "Mutating NestJS routes should make auth/public intent visible through guards, decorators, request-user extraction, or a documented public-route convention."
        );
      });
    }

    if (isNestDto && /@ValidateNested\b/.test(text) && !/@Type\s*\(\s*\(\s*\)\s*=>/.test(text)) {
      addFinding(
        findings,
        "nestjs-nested-dto-without-type-transform",
        "medium",
        repo.name,
        file,
        lineForFirstOccurrence(text, "@ValidateNested"),
        "Nested DTO validation is present without an obvious class-transformer @Type mapping.",
        "Pair nested DTO validation with @Type(() => NestedDto) so validation runs against the expected class shape instead of silently accepting plain objects."
      );
    }

    if (isNestProvider && /\bnew\s+[A-Z][A-Za-z0-9_]*(Service|Repository|Client|Adapter|Gateway|UseCase)\s*\(/.test(text) && !/\bnew\s+(Map|Set|Date|URL|Error|AbortController|Promise)\b/.test(text)) {
      addFinding(
        findings,
        "nestjs-provider-bypasses-di",
        "medium",
        repo.name,
        file,
        lineForFirstOccurrence(text, "new "),
        "NestJS provider appears to instantiate another service/repository/client directly.",
        "Prefer constructor injection or an explicit factory/provider token so lifecycle, mocks, scopes, interceptors, and test boundaries remain controlled by Nest DI."
      );
    }

    if (/\.py$/.test(file) && /\bdef\s+\w+\s*\([^)]*request[^)]*\)/.test(text) && /(views?|routes?|api)\//i.test(file)) {
      const protectedSignal = /\b(login_required|permission_required|IsAuthenticated|authentication_classes|permission_classes|Depends\s*\(|current_user|jwt_required|auth_required)\b/i.test(text);
      if (!protectedSignal && /\b(POST|PUT|PATCH|DELETE|create|update|delete|admin|private|account)\b/i.test(text)) {
        addFinding(
          findings,
          "python-route-without-auth-signal",
          "medium",
          repo.name,
          file,
          "-",
          "Django/Flask/FastAPI route-like file has mutating/private signals without an obvious auth decorator/dependency.",
          "Add or verify route-level authentication/permission dependencies such as login_required, permission_classes, Depends(current_user), or project-equivalent guards."
        );
      }
    }

    if (/\.java$/.test(file) && /\b@RestController\b/.test(text) && /\bnew\s+[A-Z][A-Za-z0-9_]*Repository|\.findAll\s*\(|\.save\s*\(/.test(text)) {
      addFinding(
        findings,
        "spring-controller-accesses-repository-directly",
        "medium",
        repo.name,
        file,
        lineForFirstOccurrence(text, "Repository"),
        "Spring controller appears to access persistence/repository behavior directly.",
        "Keep Spring controllers thin and route through application/service boundaries with validation, transaction, and authorization policy in the proper layer."
      );
    }

    if (/\.rb$/.test(file) && /(controllers?|jobs?|services?)\//i.test(file) && /\brescue\s+(Exception|StandardError)\b/.test(text) && !/\braise|logger|notify|Sentry|Honeybadger|Rollbar|context|ensure\b/i.test(text)) {
      addFinding(
        findings,
        "rails-broad-exception-without-observability",
        "medium",
        repo.name,
        file,
        lineForFirstOccurrence(text, "rescue"),
        "Ruby/Rails code rescues a broad exception without obvious rethrow/log/monitoring context.",
        "Rescue specific errors, preserve context, log/notify safely, and avoid swallowing operational failures."
      );
    }
  }
  return findings;
}

function scanRestApiDesign(repo) {
  const findings = [];
  const routeFilePattern = /(controller|route|routes|router|handler|api)\.[cm]?[jt]sx?$|(^|\/)(controllers?|routes?|api|handlers?)\//i;
  const methodPattern = /\b(app|router|server)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]|@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`]*)["'`]\s*\)/g;
  const verbSegment = /\b(get|create|add|update|edit|delete|remove|fetch|list|search|approve|reject|send|process|calculate|generate|sync|export|import)\b/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value) && routeFilePattern.test(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);

    for (const match of text.matchAll(methodPattern)) {
      const method = (match[2] || match[4] || "").toLowerCase();
      const path = match[3] || match[5] || "";
      const line = lineForFirstOccurrence(text, match[0]);
      if (!windowTouchesChangedLine(repo, file, line === "-" ? 1 : line, 4)) continue;
      const fullPath = path || "/";
      const segments = fullPath.split("/").filter(Boolean);
      const lastSegment = segments.at(-1) || "";
      const window = lines.slice(Math.max(0, Number(line) - 2 || 0), Math.min(lines.length, (Number(line) || 1) + 10)).join("\n");

      if (segments.some((segment) => verbSegment.test(segment.replace(/[:{}]/g, "")))) {
        addFinding(
          findings,
          "rest-route-uses-verb-segment",
          "low",
          repo.name,
          file,
          line,
          `${method.toUpperCase()} ${fullPath}`,
          "Prefer resource nouns in REST paths. Put the action semantics in the HTTP method or model it as a sub-resource when needed."
        );
      }

      if (method === "get" && /\b(create|update|delete|remove|approve|reject|send|process|sync)\b/i.test(fullPath)) {
        addFinding(
          findings,
          "rest-get-mutating-action-signal",
          "medium",
          repo.name,
          file,
          line,
          `${method.toUpperCase()} ${fullPath}`,
          "GET routes should be safe/idempotent. Use POST/PATCH/DELETE for mutations and add CSRF/auth/rate-limit checks when browser-exposed."
        );
      }

      if ((method === "post" || method === "put" || method === "patch") && !/\b(status|code|201|202|204|HttpCode|Created|NoContent|accepted|created)\b/i.test(window)) {
        addFinding(
          findings,
          "rest-mutation-without-status-signal",
          "low",
          repo.name,
          file,
          line,
          `${method.toUpperCase()} ${fullPath}`,
          "Mutation endpoints should make success status semantics explicit: 201 for create, 202 for async, 204 for no-content updates/deletes, or documented alternatives."
        );
      }

      if ((method === "get" && (lastSegment === "" || !/[:{]/.test(lastSegment))) && /\b(findMany|findAll|list|paginate|where|query)\b/i.test(window) && !/\b(limit|take|page|cursor|offset|perPage|pageSize|filter|sort|orderBy)\b/i.test(window)) {
        addFinding(
          findings,
          "rest-list-without-pagination-or-filter-signal",
          "medium",
          repo.name,
          file,
          line,
          `${method.toUpperCase()} ${fullPath}`,
          "Collection endpoints should expose explicit pagination and filtering/sorting contracts or document bounded result size."
        );
      }

      if (/^\/?(api\/)?(v\d+)\b/i.test(fullPath) === false && /(public|external|client|api)/i.test(file + "\n" + text.slice(0, 800))) {
        addFinding(
          findings,
          "public-rest-route-without-version-signal",
          "low",
          repo.name,
          file,
          line,
          `${method.toUpperCase()} ${fullPath}`,
          "Public APIs should have a versioning strategy, either in the path/header/media type or documented at the router boundary."
        );
      }
    }
  }

  return findings;
}

function scanGraphqlGrpcRealtimeDesign(repo) {
  const findings = [];
  const apiFilePattern = /\.(graphql|proto)$|(^|\/)(graphql|resolvers?|subscriptions?|grpc|proto|websocket|websockets|socket|sockets|channels?|hubs?)\//i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => (isCode(value) || /\.(graphql|proto)$/i.test(value)) && !isTest(value) && apiFilePattern.test(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 10)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 3), window.split(/\r?\n/).length)) return;

      if ((/\b(type\s+Query|query\s+|Query:|@Query|resolver|ResolveField)\b/i.test(window) || /(graphql|resolver)/i.test(file))
        && /\b(findMany|findAll|list|where|repository|prisma|typeorm|sequelize|mongoose)\b/i.test(window)
        && !/\b(DataLoader|batch|loader|include|select|join|paginate|limit|first|after|cursor|connection)\b/i.test(window)
        && !emitted.has("graphql-resolver-n-plus-one-or-unbounded-risk")) {
        emitted.add("graphql-resolver-n-plus-one-or-unbounded-risk");
        addFinding(
          findings,
          "graphql-resolver-n-plus-one-or-unbounded-risk",
          "medium",
          repo.name,
          file,
          line,
          window,
          "GraphQL resolvers need batching/DataLoader and explicit pagination/connection limits; otherwise nested fields can create N+1 queries or unbounded reads."
        );
      }

      if (/\b(mutation|Mutation|@Mutation)\b/i.test(window)
        && !/\b(auth|authorize|permission|role|guard|policy|tenant|rateLimit|throttle|csrf|idempotency)\b/i.test(window)
        && !emitted.has("graphql-mutation-without-boundary-controls")) {
        emitted.add("graphql-mutation-without-boundary-controls");
        addFinding(
          findings,
          "graphql-mutation-without-boundary-controls",
          "medium",
          repo.name,
          file,
          line,
          window,
          "GraphQL mutations should show auth/tenant checks, validation, idempotency/rate-limit controls, or delegate to a protected application boundary."
        );
      }

      if (/\b(subscription|Subscription|@Subscription|pubsub|publish|subscribe)\b/i.test(window)
        && !/\b(auth|authorize|tenant|filter|withFilter|scope|permission|unsubscribe|backpressure|rateLimit)\b/i.test(window)
        && !emitted.has("graphql-subscription-without-scope-or-backpressure")) {
        emitted.add("graphql-subscription-without-scope-or-backpressure");
        addFinding(
          findings,
          "graphql-subscription-without-scope-or-backpressure",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Subscriptions and realtime streams need scoped filtering, auth, unsubscribe/backpressure behavior, and rate limits."
        );
      }

      if (/\b(introspection|graphiql|playground|ApolloServer|GraphQLModule)\b/i.test(window)
        && !/\b(production|prod|NODE_ENV|disabled|false|guard|auth)\b/i.test(window)
        && !emitted.has("graphql-introspection-enabled-without-prod-guard")) {
        emitted.add("graphql-introspection-enabled-without-prod-guard");
        addFinding(
          findings,
          "graphql-introspection-enabled-without-prod-guard",
          "low",
          repo.name,
          file,
          line,
          window,
          "GraphQL introspection/playground should be disabled or explicitly guarded in production environments."
        );
      }

      if (/\b(service\s+\w+|rpc\s+\w+|message\s+\w+)\b/.test(window)
        && /\.proto$/i.test(file)
        && !/\b(v\d+|reserved|deprecated|optional|oneof|package\s+[\w.]*v\d+)/i.test(window)
        && !emitted.has("grpc-proto-without-compatibility-signal")) {
        emitted.add("grpc-proto-without-compatibility-signal");
        addFinding(
          findings,
          "grpc-proto-without-compatibility-signal",
          "low",
          repo.name,
          file,
          line,
          window,
          "gRPC/protobuf contracts should preserve backward compatibility through versioned packages, reserved fields, optional evolution, and deprecation policy."
        );
      }

      if (/\b(socket\.on|io\.on|WebSocket|ws\.on|send|emit|broadcast|subscribe)\b/i.test(window)
        && !/\b(auth|authorize|token|tenant|room|channel|validate|schema|rateLimit|throttle|backpressure|heartbeat|close)\b/i.test(window)
        && !emitted.has("websocket-handler-without-auth-or-backpressure")) {
        emitted.add("websocket-handler-without-auth-or-backpressure");
        addFinding(
          findings,
          "websocket-handler-without-auth-or-backpressure",
          "medium",
          repo.name,
          file,
          line,
          window,
          "WebSocket/realtime handlers should validate message shape, authorize channel/tenant scope, and define rate-limit/backpressure/heartbeat behavior."
        );
      }
    });
  }

  return findings;
}

function scanApiContractCoherence(repo) {
  const findings = [];
  const files = existingFiles(repo.root, repo.entries);
  const changedOrFullFiles = files.filter((file) => changedLineCount(repo, file) > 0);
  const hasOpenApi = files.some((file) => /(openapi|swagger).*\.(json|ya?ml)$|(^|\/)(openapi|swagger)\//i.test(file));
  const hasGraphqlSchema = files.some((file) => /\.(graphql|gql)$/i.test(file));
  const hasProto = files.some((file) => /\.proto$/i.test(file));
  const hasBufConfig = files.some((file) => /(^|\/)buf\.(yaml|yml|json)$|(^|\/)buf\.lock$/i.test(file));
  const contractTouched = changedOrFullFiles.some((file) => isContractLikeFile(file) || /(openapi|swagger|graphql|gql|proto)/i.test(file));

  for (const file of changedOrFullFiles.filter((value) => isCode(value) && !isTest(value))) {
    const text = readFile(repo.root, file);
    const isRest = /(controller|route|routes|router|handler|api)\.[cm]?[jt]sx?$|(^|\/)(controllers?|routes?|api|handlers?)\//i.test(file)
      && /(@(Get|Post|Put|Patch|Delete)\s*\(|\b(app|router|server)\.(get|post|put|patch|delete)\s*\()/.test(text);
    const isGraphql = /(resolver|graphql|schema)\.[cm]?[jt]s$|(^|\/)(graphql|resolvers?)\//i.test(file)
      && /@(Query|Mutation|Subscription)\b|\b(ResolveField|resolver|typeDefs|gql)\b/i.test(text);

    if (isRest && !hasOpenApi && !/ApiOperation|ApiResponse|ApiBody|ApiParam|ApiQuery|OpenAPI|swagger/i.test(text)) {
      addFinding(
        findings,
        "api-controller-without-openapi-contract-signal",
        "low",
        repo.name,
        file,
        "-",
        "REST/controller implementation changed but no OpenAPI/swagger contract or inline contract decorators were found.",
        "For public or cross-repo APIs, keep controller input/output/status behavior aligned with OpenAPI or an equivalent consumer contract."
      );
    }

    if (isGraphql && !hasGraphqlSchema && !/\b(depthLimit|complexity|costAnalysis|validationRules|DataLoader|@Directive)\b/i.test(text)) {
      addFinding(
        findings,
        "graphql-resolver-without-schema-or-complexity-signal",
        "low",
        repo.name,
        file,
        "-",
        "GraphQL resolver changed without a visible SDL/schema file or query depth/complexity policy.",
        "Review the resolver against the GraphQL schema, auth policy, depth/complexity limits, and pagination/connection contract."
      );
    }
  }

  if (hasProto && !hasBufConfig && contractTouched) {
    const protoFile = changedOrFullFiles.find((file) => /\.proto$/i.test(file)) || files.find((file) => /\.proto$/i.test(file)) || "-";
    addFinding(
      findings,
      "protobuf-contract-without-breaking-check-signal",
      "low",
      repo.name,
      protoFile,
      "-",
      "Protobuf/gRPC contract is present but no buf config/lockfile was found for lint or breaking-change checks.",
      "Use buf or an equivalent compatibility check to protect field numbers, reserved fields, package versioning, and consumer compatibility."
    );
  }

  return findings;
}

function scanCoverageAndDocumentation(repo) {
  const findings = [];
  const files = existingFiles(repo.root, repo.entries);
  const changedOrFullFiles = files.filter((file) => changedLineCount(repo, file) > 0);
  const codeChanged = changedOrFullFiles.some((file) => isCode(file) && !isTest(file));
  const apiChanged = changedOrFullFiles.some((file) => /(controller|route|routes|router|handler|api|resolver|graphql|proto)\b/i.test(file));
  const manifestChanged = changedOrFullFiles.some((file) => /(package\.json|pyproject\.toml|go\.mod|Gemfile|Cargo\.toml|requirements|Dockerfile|compose|\.env\.example)/i.test(file));
  const readmePath = files.find((file) => /(^|\/)README(\.[\w-]+)?$/i.test(file)) || "";
  const contributingPath = files.find((file) => /(^|\/)CONTRIBUTING(\.[\w-]+)?$/i.test(file)) || "";

  const coverageCandidates = [
    "coverage/coverage-summary.json",
    "coverage/coverage-final.json",
  ];
  for (const coverageFile of coverageCandidates) {
    if (!existsSync(join(repo.root, coverageFile))) continue;
    try {
      const report = JSON.parse(readFileSync(join(repo.root, coverageFile), "utf8"));
      const pct = report.total?.lines?.pct ?? report.total?.statements?.pct;
      const min = Number(repo.config.coverageLinesMin || (repo.config.appType === "public-api" || repo.config.appType === "microservice" ? 85 : 80));
      if (typeof pct === "number" && pct < min && codeChanged) {
        addFinding(
          findings,
          "coverage-report-below-threshold",
          "low",
          repo.name,
          coverageFile,
          "-",
          `Coverage lines/statements ${pct}% below configured minimum ${min}%.`,
          "Inspect uncovered changed or critical files and add focused tests around auth, persistence, contracts, events, and failure paths before relying on broad coverage."
        );
      }
    } catch {
      addFinding(
        findings,
        "coverage-report-unreadable",
        "low",
        repo.name,
        coverageFile,
        "-",
        "Coverage report exists but could not be parsed as JSON.",
        "Regenerate coverage or point the review to a readable report before using coverage as evidence."
      );
    }
    break;
  }

  for (const reportPath of repo.config.e2eCoverageReportPaths || []) {
    const fullPath = join(repo.root, reportPath);
    if (!existsSync(fullPath)) continue;
    try {
      const report = JSON.parse(readFileSync(fullPath, "utf8"));
      const pct = report.total?.lines?.pct ?? report.total?.statements?.pct ?? report.coverage?.lines ?? report.summary?.lines?.pct;
      const min = Number(repo.config.e2eCoverageMin || repo.config.coverageLinesMin || 80);
      const reportText = JSON.stringify(report).slice(0, 12000);
      const criticalKeywords = repo.config.criticalFlowKeywords || [];
      const criticalMentioned = criticalKeywords.filter((keyword) => new RegExp(`\\b${keyword}\\b`, "i").test(reportText));
      if (typeof pct === "number" && pct < min && (criticalMentioned.length > 0 || apiChanged || args.fullRepository)) {
        addFinding(
          findings,
          "e2e-critical-flow-coverage-below-threshold",
          "medium",
          repo.name,
          reportPath,
          "-",
          `E2E/integration coverage ${pct}% below configured minimum ${min}%${criticalMentioned.length ? ` for critical flow terms: ${criticalMentioned.join(", ")}` : ""}.`,
          "Use Cypress/Playwright coverage artifacts to prove critical user flows exercise the changed code. Add or adjust E2E/integration tests for auth, checkout/cart, tenant/permission, or project-specific critical flows."
        );
      }
    } catch {
      addFinding(
        findings,
        "e2e-coverage-report-unreadable",
        "low",
        repo.name,
        reportPath,
        "-",
        "Configured E2E coverage report could not be parsed as JSON.",
        "Regenerate the Cypress/Playwright/Istanbul coverage artifact or update e2eCoverageReportPaths."
      );
    }
  }

  for (const reportPath of repo.config.contractTestReportPaths || []) {
    const fullPath = join(repo.root, reportPath);
    if (!existsSync(fullPath)) continue;
    const text = readFile(repo.root, reportPath) || readFileSync(fullPath, "utf8");
    let failed = 0;
    let total = 0;
    try {
      const report = JSON.parse(text);
      failed = Number(report.stats?.failures ?? report.numFailedTests ?? report.failures ?? report.summary?.failed ?? 0);
      total = Number(report.stats?.tests ?? report.numTotalTests ?? report.total ?? report.summary?.total ?? 0);
    } catch {
      failed = (text.match(/\b(failed|failure|error)\b/gi) || []).length;
      total = (text.match(/\b(testcase|scenario|contract|assertion)\b/gi) || []).length;
    }
    const passRate = total > 0 ? ((total - failed) / total) * 100 : failed === 0 ? 100 : 0;
    const min = Number(repo.config.contractPassRateMin || 100);
    if (failed > 0 || passRate < min) {
      addFinding(
        findings,
        "contract-test-report-failure-signal",
        "medium",
        repo.name,
        reportPath,
        "-",
        `Contract report pass rate ${passRate.toFixed(1)}% with ${failed} failure signal(s).`,
        "Resolve OpenAPI/GraphQL/UI contract report failures or document the compatibility decision before marking the API/UI contract ready."
      );
    }
  }

  if ((apiChanged || manifestChanged || args.fullRepository) && readmePath) {
    const readme = readFile(repo.root, readmePath);
    const missing = [];
    if (apiChanged && !/\b(endpoint|route|API|OpenAPI|GraphQL|gRPC|version|v\d+|pagination|rate limit|idempotency)\b/i.test(readme)) missing.push("API endpoints/versioning");
    if (manifestChanged && !/\b(env|environment|configuration|DATABASE_URL|API_KEY|secret|setup|usage|example)\b/i.test(readme)) missing.push("environment/setup examples");
    if (missing.length > 0) {
      addFinding(
        findings,
        "readme-missing-api-env-usage-signal",
        "low",
        repo.name,
        readmePath,
        "-",
        `README may be missing: ${missing.join(", ")}.`,
        "Document public endpoints/contracts, versioning, required environment variables, and minimal usage examples when the repository exposes API/runtime surfaces."
      );
    }
  }

  if ((apiChanged || codeChanged || args.fullRepository) && contributingPath) {
    const contributing = readFile(repo.root, contributingPath);
    if (!/\b(test|lint|format|typecheck|coverage|review|small PR|pull request|200|400)\b/i.test(contributing)) {
      addFinding(
        findings,
        "contributing-missing-review-test-policy",
        "low",
        repo.name,
        contributingPath,
        "-",
        "CONTRIBUTING exists but no obvious test/review/small-PR policy was detected.",
        "Document expected review evidence, focused tests, formatting/linting, and small single-responsibility PR guidance."
      );
    }
  }

  return findings;
}

function scanUiSemanticsAndA11y(repo) {
  const findings = [];
  const uiFilePattern = /\.(tsx|jsx|vue|svelte|astro|html)$/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => uiFilePattern.test(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      if (!shouldScanLine(repo, file, line)) return;
      const window = lines.slice(index, Math.min(index + 5, lines.length)).join("\n");

      if (/<img\b/i.test(lineText) && !/\b(alt=|role=["']presentation|aria-hidden=["']true)/i.test(window)) {
        addFinding(findings, "ui-image-missing-alt", "medium", repo.name, file, line, window, "Images need alt text or explicit decorative semantics with role=presentation/aria-hidden.");
      }

      if (/<input\b/i.test(lineText) && !/\b(id=|aria-label=|aria-labelledby=|title=)/i.test(window) && !/<label\b/i.test(lines.slice(Math.max(0, index - 3), index + 4).join("\n"))) {
        addFinding(findings, "ui-input-without-label-signal", "medium", repo.name, file, line, window, "Inputs should have a programmatic label via label+id, aria-label, or aria-labelledby.");
      }

      if (/<div\b[^>]*(onClick|@click|v-on:click)\b/i.test(lineText) && !/\b(role=["']button|tabIndex=|tabindex=|onKeyDown|onKeyUp|@keydown)/i.test(window)) {
        addFinding(findings, "ui-clickable-div-without-keyboard-semantics", "medium", repo.name, file, line, window, "Use a real button for actions, or provide role, focusability, and keyboard handlers when a custom element is required.");
      }

      if (/<a\b/i.test(lineText) && /\b(onClick|@click)\b/i.test(lineText) && !/\bhref=/.test(lineText)) {
        addFinding(findings, "ui-anchor-used-as-button", "medium", repo.name, file, line, lineText, "Use <button> for actions and <a href> for navigation.");
      }

      if (/<button\b/i.test(lineText) && /\b(to=|href=|routerLink=)/i.test(lineText)) {
        addFinding(findings, "ui-button-used-as-link", "low", repo.name, file, line, lineText, "Use links for navigation and buttons for actions unless the design system wraps semantics correctly.");
      }
    });

    const semanticTags = (text.match(/<(header|nav|main|section|article|aside|footer)\b/gi) || []).length;
    const divTags = (text.match(/<div\b/gi) || []).length;
    if (divTags >= 12 && semanticTags === 0 && /(page|layout|screen|route|view|dashboard|shell)/i.test(file)) {
      addFinding(
        findings,
        "ui-page-without-semantic-landmarks",
        "low",
        repo.name,
        file,
        "-",
        `${divTags} div elements and no semantic landmarks detected`,
        "Page/layout components should prefer semantic landmarks such as header, nav, main, section, article, aside, or footer where appropriate."
      );
    }
  }

  return findings;
}

function scanAdvancedA11y(repo) {
  const findings = [];
  const uiFilePattern = /\.(tsx|jsx|vue|svelte|astro|html|css|scss)$/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => uiFilePattern.test(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 4), Math.min(lines.length, index + 8)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 4), window.split(/\r?\n/).length)) return;

      if (/\b(tabIndex|tabindex)=["'{]?[1-9]/.test(lineText)) {
        addFinding(
          findings,
          "positive-tabindex-a11y-risk",
          "medium",
          repo.name,
          file,
          line,
          lineText,
          "Avoid positive tabindex. Preserve natural focus order or manage focus with accessible, documented keyboard behavior."
        );
      }

      if (/\brole=["'](button|link|navigation|main|img|checkbox|dialog)["']/.test(lineText)
        && /<(button|a|nav|main|img|input|dialog)\b/i.test(lineText)) {
        addFinding(
          findings,
          "redundant-or-conflicting-aria-role",
          "low",
          repo.name,
          file,
          line,
          lineText,
          "Avoid ARIA roles that duplicate or conflict with native semantics. Prefer semantic HTML first and ARIA only when it changes the accessibility tree correctly."
        );
      }

      if (/\baria-(label|labelledby|describedby)=["']\s*["']/.test(lineText)
        || /\baria-hidden=["']true["']/.test(lineText) && /\b(onClick|href|tabIndex|role=)/.test(window)) {
        addFinding(
          findings,
          "aria-misuse-a11y-risk",
          "medium",
          repo.name,
          file,
          line,
          window,
          "ARIA attributes should not hide focusable/interactive content or provide empty labels. Validate with role queries and axe."
        );
      }

      if (/\b(outline\s*:\s*none|focus:outline-none|focus-visible:outline-none)\b/i.test(lineText)
        && !/\b(focus-visible|ring-|box-shadow|outline-offset|:focus-visible)\b/i.test(window.replace(lineText, ""))) {
        addFinding(
          findings,
          "focus-visible-style-missing",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Keyboard focus must remain visible. If outline is removed, add a replacement focus-visible/ring/box-shadow style."
        );
      }
    });

    if (/(layout|shell|app|root|navigation|nav)/i.test(file)
      && /<nav\b/i.test(text)
      && /<main\b/i.test(text)
      && !/\b(skip[- ]?link|href=["']#(?:main|content)|Pular para|Skip to)\b/i.test(text)) {
      addFinding(
        findings,
        "missing-skip-link-for-repeated-navigation",
        "low",
        repo.name,
        file,
        "-",
        "Layout has navigation and main landmarks but no skip-link signal.",
        "Add a keyboard-visible skip link to let users bypass repeated navigation."
      );
    }
  }

  return findings;
}

function hexToRgb(hex) {
  const normalized = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(normalized)) return null;
  const full = normalized.length === 3 ? normalized.split("").map((char) => char + char).join("") : normalized;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }) {
  const convert = (value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
}

function contrastRatio(foreground, background) {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return null;
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function scanI18nAndAdvancedUi(repo) {
  const findings = [];
  const uiFilePattern = /\.(tsx|jsx|vue|svelte|astro|html)$/i;
  const i18nFileSignal = existingFiles(repo.root, repo.entries).some((file) => /(^|\/)(locales?|i18n|translations?|messages?)\//i.test(file) || /\.(po|mo|xlf|xliff)$/i.test(file));
  const i18nLibrarySignal = existingFiles(repo.root, repo.entries)
    .filter((file) => /package\.json$/.test(file) || isCode(file))
    .some((file) => /\b(react-intl|FormattedMessage|useIntl|intl\.formatMessage|next-intl|i18next|react-i18next|vue-i18n|svelte-i18n)\b/i.test(readFile(repo.root, file)));

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => uiFilePattern.test(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 6)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 3), window.split(/\r?\n/).length)) return;

      const visibleTextMatch = lineText.match(/>\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ,.!?:;'"()/%-]{3,})\s*</)
        || lineText.match(/\b(?:label|title|placeholder|aria-label|alt)=["']([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ,.!?:;'"()/%-]{3,})["']/);
      if (visibleTextMatch
        && !/\b(FormattedMessage|formatMessage|t\s*\(|i18n\.|intl\.|Trans\b|messageId|defaultMessage)\b/.test(window)
        && !/^\s*(className|style|data-|id=)/.test(lineText)
        && !emitted.has("ui-hardcoded-text-without-i18n")) {
        emitted.add("ui-hardcoded-text-without-i18n");
        addFinding(
          findings,
          "ui-hardcoded-text-without-i18n",
          i18nFileSignal || i18nLibrarySignal ? "medium" : "low",
          repo.name,
          file,
          line,
          visibleTextMatch[1],
          "User-visible UI strings should be extracted to the project i18n/message system, with plural/date/currency formatting handled by the i18n library when dynamic values are involved."
        );
      }

      const colors = [...window.matchAll(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)].map((match) => match[0]);
      if (colors.length >= 2 && !emitted.has("possible-low-contrast-color-pair")) {
        const ratio = contrastRatio(colors[0], colors[1]);
        if (ratio !== null && ratio < 4.5) {
          emitted.add("possible-low-contrast-color-pair");
          addFinding(
            findings,
            "possible-low-contrast-color-pair",
            "medium",
            repo.name,
            file,
            line,
            `${colors[0]} on ${colors[1]} contrast ratio ${ratio.toFixed(2)}:1`,
            "WCAG normal text needs at least 4.5:1 contrast. Validate rendered contrast with axe/core browser evidence and adjust foreground/background tokens."
          );
        }
      }
    });
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
  const strongValidatorPattern = /@(IsEnum|IsIn|Matches|IsHexColor|IsUrl|IsUUID|IsBoolean|IsNumber|IsInt|Min|Max|Length|MinLength|MaxLength|Validate|ValidateIf)|z\.enum|z\.nativeEnum|z\.literal|z\.union|yup\.(mixed|number|boolean)|Joi\.(valid|allow|number|boolean)|\.(regex|url|uuid|email|datetime|min|max|int|positive|nonnegative)\s*\(|oneOf|enum:|\ballowed[A-Za-z0-9_]*\b|\bnormalizeEnum\b|\bvalidate[A-Za-z0-9_]*Token\b/i;

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
        "low",
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

function scanUiPerformanceRisks(repo) {
  const findings = [];
  const uiFilePattern = /\.(tsx|jsx|vue|svelte|astro)$/i;
  const bundleBudgetPattern = /(webpack|vite|rollup|next|nuxt|rspack|rsbuild|package)\.(config\.)?[cm]?[jt]s$|package\.json$/i;

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => uiFilePattern.test(value) && !isTest(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    const lines = text.split(/\r?\n/);
    const emitted = new Set();

    lines.forEach((lineText, index) => {
      const line = index + 1;
      const window = lines.slice(Math.max(0, index - 5), Math.min(lines.length, index + 12)).join("\n");
      if (!windowTouchesChangedLine(repo, file, Math.max(1, line - 5), window.split(/\r?\n/).length)) return;

      if (/\b(onChange|onInput|watch\s*\(|useEffect\s*\(|useWatch|v-model|@input)\b/i.test(window)
        && /\b(fetch|axios|request|mutate|refetch|invalidateQueries|search|query)\b/i.test(window)
        && !/\b(debounce|throttle|useDeferredValue|startTransition|AbortController|cancel|staleTime|minLength|enabled\s*:)/i.test(window)
        && !emitted.has("ui-network-on-input-without-debounce")) {
        emitted.add("ui-network-on-input-without-debounce");
        addFinding(
          findings,
          "ui-network-on-input-without-debounce",
          "medium",
          repo.name,
          file,
          line,
          window,
          "Network work triggered by typing/input should have debounce/throttle, cancellation, min-length gating, or transition/deferred behavior."
        );
      }

      if (/\b(for\s*\(|while\s*\(|JSON\.parse|JSON\.stringify|localStorage\.|sessionStorage\.)/.test(window)
        && /\b(return\s*<|template|render\s*\(|computed\s*\(|useMemo\s*\()/i.test(text)
        && !/\b(useMemo|memo|computed|worker|requestIdleCallback|virtual|windowing|paginate|slice\s*\()/i.test(window)
        && !emitted.has("ui-render-blocking-work-signal")) {
        emitted.add("ui-render-blocking-work-signal");
        addFinding(
          findings,
          "ui-render-blocking-work-signal",
          "low",
          repo.name,
          file,
          line,
          window,
          "Check whether heavy loops, JSON work, or storage access runs during render. Move blocking work to memoized selectors, workers, pagination, or async boundaries when measurable."
        );
      }
    });
  }

  for (const file of existingFiles(repo.root, repo.entries).filter((value) => bundleBudgetPattern.test(value))) {
    if (changedLineCount(repo, file) === 0) continue;
    const text = readFile(repo.root, file);
    if (/\b(monaco-editor|pdfjs|xlsx|exceljs|three|mapbox-gl|echarts|chart\.js|firebase|aws-sdk|@tiptap|ckeditor|mermaid)\b/i.test(text)
      && !/\b(budget|bundle|size-limit|bundlesize|performanceBudget|manualChunks|splitChunks|dynamic\s+import|lazy\s*\()/i.test(text)) {
      addFinding(
        findings,
        "heavy-dependency-without-bundle-budget",
        "low",
        repo.name,
        file,
        "-",
        "Heavy frontend dependency appears in changed manifest/config without a bundle-budget signal.",
        "For startup-path dependencies, add a bundle-size check, manual chunk/lazy boundary, or measured rationale."
      );
    }
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

function scanArchitectureBoundaries(repo) {
  const findings = [];
  const files = existingFiles(repo.root, repo.entries).filter((value) => isCode(value) && !isTest(value));
  const changedCodeFiles = files.filter((file) => changedLineCount(repo, file) > 0);

  for (const file of changedCodeFiles) {
    const text = readFile(repo.root, file);
    const imports = [...javascriptImportedModules(text)];
    const layer = layerForFile(file);

    for (const imported of imports) {
      if (!imported.startsWith(".") && !imported.startsWith("@/") && !imported.startsWith("~/")) continue;
      if (layer === "domain" && /(infra|infrastructure|persistence|repository|controller|http|react|vue|component|express|nestjs|prisma|typeorm|sequelize)/i.test(imported)) {
        addFinding(
          findings,
          "domain-layer-imports-outer-layer",
          "medium",
          repo.name,
          file,
          lineForFirstOccurrence(text, imported),
          imported,
          "Domain code should not depend on presentation, infrastructure, ORM, or framework layers. Invert dependencies through interfaces/ports."
        );
      }
      if (layer === "presentation" && /(prisma|typeorm|sequelize|mongoose|sql|repository|persistence|infra)/i.test(imported)) {
        addFinding(
          findings,
          "presentation-imports-data-layer",
          "low",
          repo.name,
          file,
          lineForFirstOccurrence(text, imported),
          imported,
          "Presentation/controllers/components should call application/use-case boundaries, not data/persistence adapters directly."
        );
      }
    }

    if (/(service|use-case|usecase|handler|controller)\b/i.test(file)
      && /\b(new\s+[A-Z][A-Za-z0-9_]*Repository|PrismaClient|createConnection|mongoose\.connect|DataSource\()/i.test(text)
      && !/\b(interface|abstract class|Port|RepositoryPort|inject|constructor)\b/i.test(text.slice(0, 1600))) {
      addFinding(
        findings,
        "missing-port-interface-boundary",
        "low",
        repo.name,
        file,
        lineForFirstOccurrence(text, "Repository"),
        "Service/use-case code appears to instantiate concrete data access directly.",
        "Depend on interfaces/ports at application boundaries so infrastructure can vary and tests can exercise behavior without concrete persistence coupling."
      );
    }

    if (/\b(render|return\s*<|JSX|template)\b/i.test(text) && /\b(fetch|axios|prisma|repository|sql|save|update|delete)\b/i.test(text) && /(component|page|view|screen|route)\b/i.test(file)) {
      addFinding(
        findings,
        "ui-mixes-presentation-and-data-access",
        "low",
        repo.name,
        file,
        "-",
        "UI component appears to mix rendering with direct data access or mutation.",
        "Separate presentation from data fetching/mutation through hooks, loaders, actions, services, or application boundaries."
      );
    }
  }

  return findings;
}

function layerForFile(file) {
  if (/(^|\/)(domain|entities|value-objects|policies)\//i.test(file)) return "domain";
  if (/(^|\/)(presentation|controllers?|routes?|views?|components?|pages?|screens?)\//i.test(file)) return "presentation";
  if (/(^|\/)(infrastructure|infra|persistence|repositories?|adapters?)\//i.test(file)) return "infrastructure";
  if (/(^|\/)(application|use-cases?|services?|commands?|queries?)\//i.test(file)) return "application";
  return "unknown";
}

function reviewQuestionsForRepo(repo, findings) {
  const questions = [];
  const rules = new Set(findings.map((finding) => finding.rule));
  const files = repo.entries.map((entry) => entry.path);
  const magicStringCount = findings.filter((finding) => finding.rule === "magic-string").length;
  const domains = new Set(findings.map((finding) => finding.domain).filter(Boolean));

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

  if (rules.has("weak-cryptographic-hash") || rules.has("insecure-crypto-algorithm-or-mode") || rules.has("password-hash-without-salt-or-kdf")) {
    questions.push("A mudança manipula dados sensíveis que exigem criptografia moderna, rotação de chaves, KMS/cofre ou migração de hashes legados?");
  }

  if (rules.has("ssrf-risk-unvalidated-url-fetch") || rules.has("open-redirect-risk") || rules.has("permissive-cors-policy") || rules.has("cookie-missing-security-attributes")) {
    questions.push("A superfície web/integracao exposta tem allowlist de origem/URL, proteção de cookies e testes negativos para entrada externa maliciosa?");
  }

  if (rules.has("file-upload-without-validation")) {
    questions.push("O fluxo de upload exige limites de tamanho, allowlist de tipo, sanitização de nome, armazenamento isolado ou varredura antimalware?");
  }

  if (rules.has("retry-without-backoff-or-timeout") || rules.has("shared-state-without-lock-signal") || rules.has("event-consumer-without-idempotency-signal") || rules.has("event-worker-without-backoff-or-concurrency-limit") || rules.has("serverless-function-without-runtime-limits")) {
    questions.push("Há expectativa de concorrência, carga, filas ou reprocessamento que exige teste de race/idempotência/backoff antes de aprovar?");
  }

  if (rules.has("rest-route-uses-verb-segment") || rules.has("rest-get-mutating-action-signal") || rules.has("rest-list-without-pagination-or-filter-signal") || rules.has("public-rest-route-without-version-signal") || rules.has("api-controller-without-openapi-contract-signal")) {
    questions.push("A API alterada segue o contrato público esperado para recursos REST, versionamento, paginação/filtros, status codes e compatibilidade OpenAPI/cliente?");
  }

  if (rules.has("graphql-resolver-n-plus-one-or-unbounded-risk") || rules.has("graphql-mutation-without-boundary-controls") || rules.has("graphql-subscription-without-scope-or-backpressure") || rules.has("graphql-resolver-without-schema-or-complexity-signal") || rules.has("grpc-proto-without-compatibility-signal") || rules.has("protobuf-contract-without-breaking-check-signal") || rules.has("websocket-handler-without-auth-or-backpressure")) {
    questions.push("A API não-REST alterada tem contrato/versionamento, limites de complexidade/paginação, auth/tenant scope, compatibilidade e teste de carga/realtime quando aplicável?");
  }

  if (rules.has("external-call-without-timeout-or-resilience") || rules.has("external-call-without-circuit-breaker") || rules.has("critical-boundary-without-instrumentation-signal") || rules.has("missing-correlation-id-boundary") || rules.has("unstructured-error-log-without-correlation") || rules.has("security-event-without-observability-signal")) {
    questions.push("O fluxo alterado precisa de observabilidade operacional nesta entrega: logs estruturados, correlation/trace IDs, métricas, auditoria ou circuit breaker?");
  }

  if (rules.has("domain-layer-imports-outer-layer") || rules.has("presentation-imports-data-layer") || rules.has("missing-port-interface-boundary") || rules.has("ui-mixes-presentation-and-data-access") || rules.has("dependency-cycle-detected") || rules.has("sensitive-data-crosses-layer-without-boundary") || rules.has("n-plus-one-through-route-call-chain-signal")) {
    questions.push("A separação entre apresentação, aplicação/domínio e dados faz parte do escopo desta entrega, ou há uma restrição explícita para aceitar acoplamento temporário?");
  }

  if (rules.has("coverage-report-below-threshold") || rules.has("coverage-report-unreadable") || rules.has("e2e-critical-flow-coverage-below-threshold") || rules.has("e2e-coverage-report-unreadable") || rules.has("contract-test-report-failure-signal") || rules.has("readme-missing-api-env-usage-signal") || rules.has("contributing-missing-review-test-policy")) {
    questions.push("A documentação e cobertura disponíveis são critérios bloqueantes nesta entrega, ou devem gerar follow-up explícito com dono e escopo?");
  }

  if (rules.has("ui-page-without-semantic-landmarks") || rules.has("ui-image-missing-alt") || rules.has("ui-input-without-label-signal") || rules.has("ui-clickable-div-without-keyboard-semantics") || rules.has("ui-anchor-used-as-button") || rules.has("ui-button-used-as-link")) {
    questions.push("A tela/componente alterado precisa cumprir semântica HTML e acessibilidade como critério bloqueante nesta PR, incluindo landmarks, labels, navegação por teclado e distinção button/link?");
  }

  if (rules.has("positive-tabindex-a11y-risk") || rules.has("redundant-or-conflicting-aria-role") || rules.has("aria-misuse-a11y-risk") || rules.has("focus-visible-style-missing") || rules.has("missing-skip-link-for-repeated-navigation")) {
    questions.push("A mudança de UI exige conformidade WCAG/foco/ARIA nesta PR, ou a revisão deve registrar ajustes de acessibilidade avançada como follow-up explícito?");
  }

  if (rules.has("ui-hardcoded-text-without-i18n") || rules.has("possible-low-contrast-color-pair")) {
    questions.push("A mudança de UI precisa bloquear por i18n/WCAG nesta entrega, incluindo extração de strings, plural/data/moeda e contraste mínimo 4.5:1?");
  }

  if (rules.has("ui-network-on-input-without-debounce") || rules.has("ui-render-blocking-work-signal") || rules.has("heavy-dependency-without-bundle-budget")) {
    questions.push("Há orçamento de performance/bundle ou meta de resposta da UI que torne bloqueante debounce, lazy loading, render streaming, worker ou análise de bundle?");
  }

  const catalogQuestions = domainQuestions(repo.config.domainCatalogs || [], domains, files, repo.config.customDomainQuestions || {});
  return [...new Set([...questions, ...catalogQuestions, ...(repo.config.customQuestions || [])])];
}

function domainQuestions(catalogs, domains, files, customDomainQuestions = {}) {
  const requested = new Set(catalogs.map((catalog) => String(catalog).toLowerCase()));
  const text = files.join("\n");
  if (/\b(cpf|cnpj|lgpd|privacy|consent|personalData|pii)\b/i.test(text)) requested.add("lgpd");
  if (domains.has("financial")) requested.add("finance");
  if (domains.has("health")) requested.add("health");
  if (/\b(cart|checkout|payment|coupon|sku|inventory|order|shipment|refund)\b/i.test(text)) requested.add("ecommerce");
  if (/\b(student|course|lesson|enrollment|classroom|grade|lms|school)\b/i.test(text)) requested.add("education");
  if (/\b(profile|follower|feed|post|comment|like|block|report|moderation)\b/i.test(text)) requested.add("social");
  if (/\b(device|sensor|firmware|mqtt|telemetry|gateway|edge|iot)\b/i.test(text)) requested.add("iot");
  const questions = [];
  if (requested.has("lgpd") || requested.has("privacy")) {
    questions.push("LGPD/privacy: a mudança minimiza dados pessoais, preserva consentimento/base legal, redige logs e mantém retenção/anonimização compatíveis?");
  }
  if (requested.has("finance") || requested.has("financial")) {
    questions.push("Financeiro: a mudança protege integridade de valores/transações, trilha de auditoria, idempotência e reconciliação contra duplicidade?");
  }
  if (requested.has("health")) {
    questions.push("Saúde: a mudança limita exposição de dados clínicos, mantém consentimento/acesso mínimo e registra auditoria de acesso sensível?");
  }
  if (requested.has("ecommerce")) {
    questions.push("E-commerce/PCI: checkout, pagamentos, cupons, estoque e reembolso preservam idempotência, auditoria, antifraude e evitam exposição de dados de cartão?");
  }
  if (requested.has("education")) {
    questions.push("Educação: matrícula, progresso, certificados, notas e dados de menores respeitam autorização, privacidade, auditoria e consistência entre aluno/turma/curso?");
  }
  if (requested.has("social")) {
    questions.push("Social media/COPPA: perfis, feed, bloqueio, denúncia, moderação e conteúdo de menores mantêm controles de privacidade, abuso e visibilidade?");
  }
  if (requested.has("iot")) {
    questions.push("IoT: comandos de dispositivo, firmware, telemetria e credenciais usam autorização forte, replay protection, rate limits e observabilidade de falhas?");
  }
  for (const [domain, domainQuestions] of Object.entries(customDomainQuestions || {})) {
    if (!requested.has(String(domain).toLowerCase())) continue;
    if (Array.isArray(domainQuestions)) questions.push(...domainQuestions.map(String));
  }
  return questions;
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

  if (rules.has("rest-route-uses-verb-segment") || rules.has("rest-get-mutating-action-signal") || rules.has("rest-mutation-without-status-signal") || rules.has("rest-list-without-pagination-or-filter-signal") || rules.has("public-rest-route-without-version-signal") || rules.has("api-controller-without-openapi-contract-signal")) {
    requirements.push("For REST/API design signals, exercise the real route/controller/handler contract, including status code, method semantics, pagination/filter behavior, and OpenAPI/client compatibility when public.");
  }

  if (rules.has("nestjs-controller-direct-data-access") || rules.has("nestjs-mutating-route-without-auth-signal") || rules.has("nestjs-nested-dto-without-type-transform") || rules.has("nestjs-provider-bypasses-di")) {
    requirements.push("For NestJS framework signals, exercise the real controller/provider/DTO boundary through Nest testing module, HTTP/integration, or e2e coverage that proves DI, validation pipe behavior, guard/public-route intent, and persistence boundary behavior.");
  }

  if (rules.has("graphql-resolver-n-plus-one-or-unbounded-risk") || rules.has("graphql-mutation-without-boundary-controls") || rules.has("graphql-subscription-without-scope-or-backpressure") || rules.has("graphql-introspection-enabled-without-prod-guard") || rules.has("graphql-resolver-without-schema-or-complexity-signal")) {
    requirements.push("For GraphQL signals, exercise the real resolver/schema path and prove auth, pagination/complexity limits, DataLoader/batching, subscription scope/backpressure, and production introspection behavior when applicable.");
  }

  if (rules.has("grpc-proto-without-compatibility-signal") || rules.has("protobuf-contract-without-breaking-check-signal") || rules.has("websocket-handler-without-auth-or-backpressure")) {
    requirements.push("For gRPC/WebSocket/realtime signals, run producer/consumer or protocol-level smoke tests that prove compatibility, authorization, validation, and disconnect/backpressure behavior.");
  }

  if (repositoryCount > 1 || contractFiles.length > 0) {
    requirements.push("For cross-repo or contract/schema/API/client changes, run producer and consumer compatibility checks or contract tests across every touched repository.");
  }

  if (uiFiles.length > 0) {
    requirements.push("For web UI/browser changes, the main agent must run a human-like browser-use pass through the changed flow and capture screenshot/interaction evidence. If no browser-use session is exposed, load the Browser skill, discover the Node REPL js tool if needed, bootstrap the iab runtime, and open a new browser-use tab/session before fallback. Use computer-use only for desktop/native/local-app validation, OS/browser shell behavior, or documented failed browser-use bootstrap/open attempt. Escalate to a QA subagent only after main-agent evidence when independent or matrix QA is justified.");
  }

  if (rules.has("ui-page-without-semantic-landmarks") || rules.has("ui-image-missing-alt") || rules.has("ui-input-without-label-signal") || rules.has("ui-clickable-div-without-keyboard-semantics") || rules.has("ui-anchor-used-as-button") || rules.has("ui-button-used-as-link")) {
    requirements.push("For UI semantics/accessibility signals, validate the rendered component/page with browser-use plus a semantic/a11y check such as axe, eslint-plugin-jsx-a11y, Testing Library role queries, or equivalent framework-native assertions.");
  }

  if (rules.has("positive-tabindex-a11y-risk") || rules.has("redundant-or-conflicting-aria-role") || rules.has("aria-misuse-a11y-risk") || rules.has("focus-visible-style-missing") || rules.has("missing-skip-link-for-repeated-navigation") || rules.has("possible-low-contrast-color-pair")) {
    requirements.push("For advanced accessibility signals, prove keyboard focus order, visible focus, skip-link behavior, ARIA role correctness, and WCAG contrast/focus checks through rendered UI tooling such as axe-core or equivalent.");
  }

  if (rules.has("ui-hardcoded-text-without-i18n")) {
    requirements.push("For i18n signals, verify user-facing strings through the project message catalog or i18n runtime, including plural, date, currency, and lazy-loaded locale behavior when applicable.");
  }

  if (rules.has("ui-network-on-input-without-debounce") || rules.has("ui-render-blocking-work-signal") || rules.has("heavy-dependency-without-bundle-budget")) {
    requirements.push("For UI performance/bundle signals, measure or test the changed path with debounce/cancellation behavior, render responsiveness, lazy/code-split boundary, or bundle-size budget evidence.");
  }

  if (rules.has("domain-layer-imports-outer-layer") || rules.has("presentation-imports-data-layer") || rules.has("missing-port-interface-boundary") || rules.has("ui-mixes-presentation-and-data-access") || rules.has("dependency-cycle-detected") || rules.has("sensitive-data-crosses-layer-without-boundary")) {
    requirements.push("For architecture/layering signals, prove the refactored or accepted boundary through tests at the intended layer and ensure runtime behavior still flows through the public entrypoint rather than a copied implementation.");
  }

  if (rules.has("possible-n-plus-one-query") || rules.has("parallel-n-plus-one-query") || rules.has("sequential-query-in-loop") || rules.has("n-plus-one-through-route-call-chain-signal")) {
    requirements.push("For N+1 signals, use a test/probe that fails or exposes repeated query count at scale, then prove the batched path stays bounded.");
  }

  if (rules.has("event-consumer-without-idempotency-signal") || rules.has("event-worker-without-backoff-or-concurrency-limit") || rules.has("serverless-function-without-runtime-limits")) {
    requirements.push("For event/serverless signals, run consumer/function tests that prove idempotency or deduplication, retry/backoff/concurrency limits, and timeout/memory behavior on the real handler path.");
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

  if ([
    "weak-cryptographic-hash",
    "insecure-crypto-algorithm-or-mode",
    "password-hash-without-salt-or-kdf",
    "cookie-missing-security-attributes",
    "permissive-cors-policy",
    "open-redirect-risk",
    "ssrf-risk-unvalidated-url-fetch",
    "file-upload-without-validation",
    "webhook-without-signature-verification",
    "auth-boundary-without-rate-limit-signal",
  ].some((rule) => rules.has(rule))) {
    requirements.push("For OWASP/security-boundary signals, add or run negative-path tests that prove unsafe external input is rejected and sensitive defaults are enforced through the real boundary.");
  }

  if (rules.has("retry-without-backoff-or-timeout")) {
    requirements.push("For retry/backoff signals, prove bounded attempts, timeout, jitter/backoff behavior, or circuit-breaker handling with a focused failure-path test/probe.");
  }

  if (rules.has("external-call-without-timeout-or-resilience") || rules.has("external-call-without-circuit-breaker") || rules.has("critical-boundary-without-instrumentation-signal") || rules.has("missing-correlation-id-boundary") || rules.has("unstructured-error-log-without-correlation") || rules.has("security-event-without-observability-signal")) {
    requirements.push("For observability/resilience signals, run failure-path or boundary tests/probes that prove timeout/circuit-breaker behavior and safe structured logs/metrics/traces/audit events on critical errors.");
  }

  if (rules.has("coverage-report-below-threshold") || rules.has("coverage-report-unreadable") || rules.has("e2e-critical-flow-coverage-below-threshold") || rules.has("e2e-coverage-report-unreadable")) {
    requirements.push("For coverage-report signals, identify the uncovered critical files/branches and run or add focused tests for the changed or historically risky behavior.");
  }

  if (rules.has("contract-test-report-failure-signal")) {
    requirements.push("For contract report signals, resolve failing OpenAPI/GraphQL/UI contract checks or document the backward-compatibility decision and consumer impact.");
  }

  if (rules.has("shared-state-without-lock-signal")) {
    requirements.push("For shared-state concurrency signals, run a deterministic parallel/race-oriented test or document why the touched state has a single-writer invariant.");
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

function readFeedbackItems(root, config) {
  const path = config.reviewFeedbackPath ? join(root, config.reviewFeedbackPath) : "";
  if (!path || !existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.feedback)) return value.feedback;
  } catch {
    return [];
  }
  return [];
}

function calibrationInsightsForRepo(repo, findings) {
  const feedback = readFeedbackItems(repo.root, repo.config);
  const byRule = {};
  for (const item of feedback) {
    const rule = item.rule || "unknown";
    const outcome = String(item.outcome || item.type || "").toLowerCase();
    byRule[rule] = byRule[rule] || { total: 0, falsePositive: 0, falseNegative: 0, severityMismatch: 0 };
    byRule[rule].total += 1;
    if (/false[-_ ]?positive|fp/.test(outcome)) byRule[rule].falsePositive += 1;
    else if (/false[-_ ]?negative|fn/.test(outcome)) byRule[rule].falseNegative += 1;
    else if (/severity|priority|classif/.test(outcome)) byRule[rule].severityMismatch += 1;
  }
  const activeRules = new Set(findings.map((finding) => finding.rule));
  const suggestions = [];
  for (const [rule, stats] of Object.entries(byRule)) {
    if (stats.falsePositive >= 2 && activeRules.has(rule)) {
      suggestions.push(`Rule ${rule} has ${stats.falsePositive} false-positive feedback item(s). Consider lowering severity, adding ignorePaths/context guards, or moving to review-signal in this repository.`);
    }
    if (stats.falseNegative >= 2) {
      suggestions.push(`Rule ${rule} has ${stats.falseNegative} false-negative feedback item(s). Consider adding a deterministic fixture or project custom rule for the missed pattern.`);
    }
    if (stats.severityMismatch >= 2) {
      suggestions.push(`Rule ${rule} has repeated severity mismatch feedback. Consider a .agentic-reviewrc severities override or generic severity adjustment after calibration.`);
    }
  }
  return {
    feedbackItems: feedback.length,
    rules: byRule,
    suggestions,
  };
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
    process.stdout.write(`${JSON.stringify({
      status: "no-changed-repositories",
      startDirectory: startCwd,
      configPath: startConfigPath || null,
      repositories: [],
    }, null, 2)}\n`);
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
    ...scanObservabilityAndResilience(repo),
    ...scanRepositoryGraphAndFlows(repo),
    ...scanAsyncEventsAndServerless(repo),
    ...scanFrameworkSpecific(repo),
    ...scanRestApiDesign(repo),
    ...scanGraphqlGrpcRealtimeDesign(repo),
    ...scanApiContractCoherence(repo),
    ...scanUiSemanticsAndA11y(repo),
    ...scanAdvancedA11y(repo),
    ...scanI18nAndAdvancedUi(repo),
    ...scanPublicContractIntegrity(repo),
    ...scanConfigValidationIntegrity(repo),
    ...scanBundleSplitRisks(repo),
    ...scanUiPerformanceRisks(repo),
    ...scanCouplingAndComplexity(repo),
    ...scanArchitectureBoundaries(repo),
    ...scanTests(repo),
    ...scanCoverageAndDocumentation(repo),
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
  const calibrationInsights = calibrationInsightsForRepo(repo, findings);

  repositoryPackets.push({
    name: repo.name,
    path: repo.root,
    configPath: repo.configPath || null,
    changedFiles: files.length,
    codeFiles: files.filter((file) => isCode(file) && !isTest(file)).length,
    testFiles: files.filter(isTest).length,
    riskSignals: risks,
    files: repo.entries.map((entry) => ({
      status: entry.status === "D" ? "deleted" : entry.status === "A" ? "added" : entry.status === "M" ? "modified" : entry.status === "T" ? "tracked" : entry.status,
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
    domainSummary: summarizeDomains(findings),
    findings,
    calibrationInsights,
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

function summarizeDomains(findings) {
  return findings.reduce((acc, finding) => {
    const domain = finding.domain || "general";
    acc[domain] = acc[domain] || { total: 0, high: 0, medium: 0, low: 0 };
    acc[domain].total += 1;
    acc[domain][finding.importance || finding.severity || "low"] = (acc[domain][finding.importance || finding.severity || "low"] || 0) + 1;
    return acc;
  }, {});
}

const globalSeverities = allFindings.reduce((acc, finding) => {
  acc[finding.severity] = (acc[finding.severity] || 0) + 1;
  return acc;
}, {});

const packet = {
  status: "ok",
  startDirectory: startCwd,
  configPath: startConfigPath || null,
  collectorScope: args.fullRepository ? "full-repository" : "diff",
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
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exit(0);
}

console.log("# Agentic Code Review Packet");
console.log("");
console.log(`Start directory: ${packet.startDirectory}`);
console.log(`Collector scope: ${args.fullRepository ? "full repository" : "diff"}`);
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
  const domainEntries = Object.entries(repoPacket.domainSummary || {});
  if (domainEntries.length > 0) {
    console.log(`Domains: ${domainEntries.map(([domain, summary]) => `${domain}=${summary.total}`).join(", ")}`);
  }
  if (repoPacket.findings.length === 0) {
    console.log("- no deterministic findings");
  } else {
    repoPacket.findings.slice(0, 80).forEach((finding) => {
      console.log(`- [${finding.severity}] ${finding.rule} at ${finding.file}:${finding.line}`);
      console.log(`  Evidence: ${finding.text.replace(/\s+/g, " ")}`);
      console.log(`  Suggestion: ${finding.suggestion}`);
      if (finding.suggestedPatch) {
        console.log(`  Suggested patch (${finding.suggestedPatch.mode}, ${finding.suggestedPatch.confidence} confidence):`);
        console.log(finding.suggestedPatch.patch.split(/\r?\n/).map((line) => `    ${line}`).join("\n"));
        if (finding.suggestedPatch.notes) console.log(`  Patch notes: ${finding.suggestedPatch.notes}`);
      }
    });
    if (repoPacket.findings.length > 80) console.log(`- truncated ${repoPacket.findings.length - 80} additional findings`);
  }
  console.log("");

  console.log("### Calibration Insights");
  if (!repoPacket.calibrationInsights?.feedbackItems) {
    console.log("- no reviewer feedback file loaded");
  } else {
    console.log(`- feedback items: ${repoPacket.calibrationInsights.feedbackItems}`);
    if (repoPacket.calibrationInsights.suggestions.length === 0) {
      console.log("- no repeated calibration action suggested");
    } else {
      repoPacket.calibrationInsights.suggestions.forEach((suggestion) => console.log(`- ${suggestion}`));
    }
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
