export function findingCategory(finding, isTestFile) {
  if (finding.severity === "high") return "blocking";
  if (finding.rule === "magic-string" || finding.rule === "magic-number") {
    return isTestFile(finding.file) ? "review-signal" : "blocking";
  }
  if (finding.rule === "duplicated-literal") {
    return finding.text.includes("prod files: 0") ? "review-signal" : "blocking";
  }
  if ([
    "large-file-touched",
    "single-responsibility-refactor-gate",
    "multiple-responsibilities-in-large-file",
    "long-function-touched",
    "deep-nesting-touched",
    "else-branch-added",
    "high-import-coupling",
    "wide-constructor-dependency-surface",
    "weak-test-assertion-signal",
    "local-or-generated-artifacts-in-diff",
    "happy-path-only-test-change",
    "local-literal-path-or-url",
    "backend-e2e-coverage-gap",
    "backend-boundary-without-e2e-or-integration",
    "static-heavy-ui-import-without-lazy-boundary",
  ].includes(finding.rule)) {
    return "review-signal";
  }
  if (finding.severity === "medium") return "blocking";
  return "informational";
}

export function normalizedGateSummary(findings, runtimeRequirements, questions, isTestFile) {
  const summary = {
    blocking: 0,
    "review-signal": 0,
    "runtime-required": runtimeRequirements.length,
    "user-input-checkpoint": questions.length,
    informational: 0,
  };
  for (const finding of findings) {
    const category = findingCategory(finding, isTestFile);
    summary[category] = (summary[category] || 0) + 1;
  }
  return summary;
}
