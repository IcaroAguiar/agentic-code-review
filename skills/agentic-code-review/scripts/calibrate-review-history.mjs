#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const collector = join(scriptDir, "collect-review-context.mjs");

function usage() {
  console.log(`agentic-code-review calibrate

Usage:
  agentic-code-review calibrate --repo <path> --case <name>:<base>:<head> [--case ...] [--json] [--out <file>]
  agentic-code-review calibrate --repo <path> --cases-file <json> [--feedback-file <json>] [--json] [--out <file>]

cases-file shape:
  [
    { "name": "pr-101", "base": "abc123", "head": "def456", "expected": ["n-plus-one", "magic-string"] }
  ]
`);
}

function parseArgs(argv) {
  const cases = [];
  let repo = "";
  let casesFile = "";
  let feedbackFile = "";
  let json = false;
  let out = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--repo" || arg === "--root") {
      repo = resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--repo=") || arg.startsWith("--root=")) {
      repo = resolve(arg.split("=").slice(1).join("="));
    } else if (arg === "--case") {
      cases.push(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--case=")) {
      cases.push(arg.split("=").slice(1).join("="));
    } else if (arg === "--cases-file") {
      casesFile = resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--cases-file=")) {
      casesFile = resolve(arg.split("=").slice(1).join("="));
    } else if (arg === "--feedback-file") {
      feedbackFile = resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--feedback-file=")) {
      feedbackFile = resolve(arg.split("=").slice(1).join("="));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--out") {
      out = resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg.startsWith("--out=")) {
      out = resolve(arg.split("=").slice(1).join("="));
    }
  }

  return { repo, cases, casesFile, feedbackFile, json, out };
}

function run(command, args, cwd) {
  const stdoutPath = join("/tmp", `agentic-code-review-calibrate-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const stdoutFd = openSync(stdoutPath, "w");
  const cleanup = () => {
    try {
      unlinkSync(stdoutPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
  const close = () => {
    try {
      closeSync(stdoutFd);
    } catch (error) {
      if (error?.code !== "EBADF") throw error;
    }
  };
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 128,
      stdio: ["ignore", stdoutFd, "pipe"],
    });
    close();
    const stdout = readFileSync(stdoutPath, "utf8");
    cleanup();
    return {
      ok: result.status === 0,
      stdout,
      stderr: result.stderr?.toString?.() || result.error?.message || "",
    };
  } catch (error) {
    close();
    let stdout = "";
    try {
      stdout = readFileSync(stdoutPath, "utf8");
      cleanup();
    } catch (readError) {
      if (readError?.code !== "ENOENT") throw readError;
    }
    return {
      ok: false,
      stdout,
      stderr: error.stderr?.toString?.() || error.message,
    };
  }
}

function parseCase(value) {
  const [name, base, head] = String(value || "").split(":");
  if (!name || !base || !head) throw new Error(`Invalid --case ${value}. Expected name:base:head.`);
  return { name, base, head, expected: [] };
}

function loadCases(args) {
  const inlineCases = args.cases.map(parseCase);
  if (!args.casesFile) return inlineCases;
  const fileCases = JSON.parse(readFileSync(args.casesFile, "utf8"));
  if (!Array.isArray(fileCases)) throw new Error("--cases-file must contain a JSON array.");
  return [...inlineCases, ...fileCases];
}

function loadFeedback(path) {
  if (!path) return [];
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.feedback)) return value.feedback;
  throw new Error("--feedback-file must contain a JSON array or an object with a feedback array.");
}

function summarizeFeedback(feedback) {
  const summary = {
    items: feedback.length,
    falsePositive: 0,
    falseNegative: 0,
    severityMismatch: 0,
    rules: {},
  };
  for (const item of feedback) {
    const outcome = String(item.outcome || item.type || "").toLowerCase();
    const rule = item.rule || "unknown";
    summary.rules[rule] = summary.rules[rule] || { total: 0, falsePositive: 0, falseNegative: 0, severityMismatch: 0 };
    summary.rules[rule].total += 1;
    if (/false[-_ ]?positive|fp/.test(outcome)) {
      summary.falsePositive += 1;
      summary.rules[rule].falsePositive += 1;
    } else if (/false[-_ ]?negative|fn/.test(outcome)) {
      summary.falseNegative += 1;
      summary.rules[rule].falseNegative += 1;
    } else if (/severity|priority|classif/.test(outcome)) {
      summary.severityMismatch += 1;
      summary.rules[rule].severityMismatch += 1;
    }
  }
  return summary;
}

function summarizePacket(packet) {
  return {
    repositories: packet.crossRepoSummary?.repositoriesWithChanges || 0,
    findings: packet.crossRepoSummary?.findings || 0,
    high: packet.crossRepoSummary?.high || 0,
    medium: packet.crossRepoSummary?.medium || 0,
    low: packet.crossRepoSummary?.low || 0,
    rules: [...new Set((packet.repositories || []).flatMap((repo) => (repo.findings || []).map((finding) => finding.rule)))].sort(),
  };
}

function topRulesForPacket(packet, limit = 8) {
  const counts = {};
  for (const repo of packet.repositories || []) {
    for (const finding of repo.findings || []) {
      counts[finding.rule] = (counts[finding.rule] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([rule, count]) => ({ rule, count }));
}

function topDomainsForPacket(packet, limit = 6) {
  const counts = {};
  for (const repo of packet.repositories || []) {
    for (const [domain, summary] of Object.entries(repo.domainSummary || {})) {
      counts[domain] = (counts[domain] || 0) + (summary.total || 0);
    }
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([domain, count]) => ({ domain, count }));
}

function gateSummaryForPacket(packet) {
  return (packet.repositories || []).reduce((acc, repo) => {
    for (const [key, value] of Object.entries(repo.normalizedGateSummary || {})) {
      acc[key] = (acc[key] || 0) + value;
    }
    return acc;
  }, {});
}

function runtimeRequirementCount(packet) {
  return (packet.repositories || []).reduce((acc, repo) => acc + (repo.runtimeVerificationRequirements || []).length, 0);
}

function checkpointCount(packet) {
  return (packet.repositories || []).reduce((acc, repo) => acc + (repo.userInputCheckpoints || []).length, 0);
}

function suggestedPatchCount(packet) {
  return (packet.repositories || []).reduce((acc, repo) => acc + (repo.findings || []).filter((finding) => finding.suggestedPatch).length, 0);
}

function casePresentation(entry) {
  if (!entry.packet) return null;
  return {
    gate: gateSummaryForPacket(entry.packet),
    topRules: topRulesForPacket(entry.packet),
    topDomains: topDomainsForPacket(entry.packet),
    runtimeRequirements: runtimeRequirementCount(entry.packet),
    checkpoints: checkpointCount(entry.packet),
    suggestedPatches: suggestedPatchCount(entry.packet),
  };
}

function aggregateCases(cases) {
  const aggregate = {
    ok: 0,
    failed: 0,
    findings: 0,
    high: 0,
    medium: 0,
    low: 0,
    gates: {},
    rules: {},
    domains: {},
    runtimeRequirements: 0,
    checkpoints: 0,
    suggestedPatches: 0,
  };
  for (const entry of cases) {
    if (entry.status === "ok") aggregate.ok += 1;
    else aggregate.failed += 1;
    if (entry.summary) {
      aggregate.findings += entry.summary.findings || 0;
      aggregate.high += entry.summary.high || 0;
      aggregate.medium += entry.summary.medium || 0;
      aggregate.low += entry.summary.low || 0;
    }
    const presentation = entry.presentation || casePresentation(entry);
    if (!presentation) continue;
    for (const [key, value] of Object.entries(presentation.gate || {})) {
      aggregate.gates[key] = (aggregate.gates[key] || 0) + value;
    }
    for (const item of presentation.topRules || []) {
      aggregate.rules[item.rule] = (aggregate.rules[item.rule] || 0) + item.count;
    }
    for (const item of presentation.topDomains || []) {
      aggregate.domains[item.domain] = (aggregate.domains[item.domain] || 0) + item.count;
    }
    aggregate.runtimeRequirements += presentation.runtimeRequirements || 0;
    aggregate.checkpoints += presentation.checkpoints || 0;
    aggregate.suggestedPatches += presentation.suggestedPatches || 0;
  }
  return aggregate;
}

function topEntries(map, limit = 10) {
  return Object.entries(map || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([key, value]) => `${key} (${value})`);
}

function renderMarkdown(report) {
  const lines = ["# Agentic Code Review Calibration", ""];
  const aggregate = aggregateCases(report.cases);
  lines.push(`Repository: ${report.repository}`);
  lines.push(`Cases: ${report.cases.length}`);
  lines.push(`OK cases: ${aggregate.ok}`);
  lines.push(`Failed cases: ${aggregate.failed}`);
  lines.push(`Findings: ${aggregate.findings} (high: ${aggregate.high}, medium: ${aggregate.medium}, low: ${aggregate.low})`);
  lines.push(`Gate totals: blocking=${aggregate.gates.blocking || 0}, review-signal=${aggregate.gates["review-signal"] || 0}, runtime-required=${aggregate.gates["runtime-required"] || 0}, user-input-checkpoint=${aggregate.gates["user-input-checkpoint"] || 0}, informational=${aggregate.gates.informational || 0}`);
  lines.push(`Runtime requirements: ${aggregate.runtimeRequirements}`);
  lines.push(`User input checkpoints: ${aggregate.checkpoints}`);
  lines.push(`Suggested patches: ${aggregate.suggestedPatches}`);
  lines.push("");
  lines.push("## PR-Ready Summary");
  lines.push(`Top recurring rules: ${topEntries(aggregate.rules).join(", ") || "none"}`);
  lines.push(`Top domains: ${topEntries(aggregate.domains, 8).join(", ") || "none"}`);
  lines.push("");
  lines.push("Use this section in PRs as calibration evidence. It is intentionally concise: link or attach the JSON packet only when a reviewer needs the raw details.");
  lines.push("");
  for (const entry of report.cases) {
    lines.push(`## ${entry.name}`);
    lines.push(`Range: ${entry.base}...${entry.head}`);
    lines.push(`Status: ${entry.status}`);
    if (entry.error) lines.push(`Error: ${entry.error.replace(/\s+/g, " ").slice(0, 500)}`);
    if (entry.summary) {
      lines.push(`Findings: ${entry.summary.findings} (high: ${entry.summary.high}, medium: ${entry.summary.medium}, low: ${entry.summary.low})`);
      const presentation = entry.presentation || casePresentation(entry);
      if (presentation) {
        const gate = presentation.gate || {};
        lines.push(`Gate: blocking=${gate.blocking || 0}, review-signal=${gate["review-signal"] || 0}, runtime-required=${gate["runtime-required"] || 0}, checkpoints=${gate["user-input-checkpoint"] || 0}, informational=${gate.informational || 0}`);
        lines.push(`Top rules: ${presentation.topRules.map((item) => `${item.rule} (${item.count})`).join(", ") || "none"}`);
        lines.push(`Top domains: ${presentation.topDomains.map((item) => `${item.domain} (${item.count})`).join(", ") || "none"}`);
        lines.push(`Runtime requirements: ${presentation.runtimeRequirements}; user checkpoints: ${presentation.checkpoints}; suggested patches: ${presentation.suggestedPatches}`);
      } else {
        lines.push(`Rules: ${entry.summary.rules.length ? entry.summary.rules.join(", ") : "none"}`);
      }
    }
    if (entry.expected?.length) lines.push(`Expected comparison labels: ${entry.expected.join(", ")}`);
    lines.push("");
  }
  lines.push("## Auto-Improvement Queue");
  lines.push("- Rules that dominate the top-recurring list should be reviewed for false positives before adding more heuristics.");
  lines.push("- Repeated false positives should become `.agentic-reviewrc.json` tuning, stricter context guards, or review-signal classification.");
  lines.push("- Repeated false negatives should become fixture smoke cases before changing production heuristics.");
  lines.push("- Severity mismatches should be calibrated with reviewer feedback before changing global defaults.");
  lines.push("");
  lines.push("## Calibration Notes");
  lines.push("- Compare each packet against human review notes or known post-merge bugs.");
  lines.push("- Mark false positives, false negatives, and severity mismatches in the cases file.");
  lines.push("- Feed reviewer outcomes through `--feedback-file` using `templates/reviewer-feedback.example.json` to calibrate noisy rules and missed risks.");
  lines.push("- Tune `.agentic-reviewrc.json` thresholds/severities before changing generic rules.");
  if (report.feedbackSummary) {
    lines.push("");
    lines.push("## Reviewer Feedback Summary");
    lines.push(`Items: ${report.feedbackSummary.items}`);
    lines.push(`False positives: ${report.feedbackSummary.falsePositive}`);
    lines.push(`False negatives: ${report.feedbackSummary.falseNegative}`);
    lines.push(`Severity mismatches: ${report.feedbackSummary.severityMismatch}`);
    const noisyRules = Object.entries(report.feedbackSummary.rules)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10)
      .map(([rule, value]) => `${rule} (${value.total})`);
    lines.push(`Top rules: ${noisyRules.length ? noisyRules.join(", ") : "none"}`);
  }
  lines.push("");
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (!args.repo || !existsSync(args.repo)) {
  usage();
  process.exit(2);
}

const cases = loadCases(args);
const feedback = loadFeedback(args.feedbackFile);
if (cases.length === 0) {
  usage();
  process.exit(2);
}

const report = {
  repository: args.repo,
  generatedAt: new Date().toISOString(),
  feedbackSummary: feedback.length > 0 ? summarizeFeedback(feedback) : null,
  cases: cases.map((testCase) => {
    const result = run(process.execPath, [collector, "--root", args.repo, "--base", testCase.base, "--head", testCase.head, "--json"], args.repo);
    if (!result.ok) {
      return {
        ...testCase,
        status: "collector-failed",
        error: result.stderr || result.stdout,
      };
    }
    try {
      const packet = JSON.parse(result.stdout);
      return {
        ...testCase,
        status: "ok",
        summary: summarizePacket(packet),
        presentation: casePresentation({ packet }),
        packet,
      };
    } catch (error) {
      return {
        ...testCase,
        status: "invalid-json",
        error: error.message,
      };
    }
  }),
};

const output = args.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
if (args.out) writeFileSync(args.out, output);
else console.log(output);
