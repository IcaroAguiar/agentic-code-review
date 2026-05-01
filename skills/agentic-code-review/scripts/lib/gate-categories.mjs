export function findingCategory(finding, isTestFile) {
  if (finding.severity === "high") return "blocking";
  if (finding.rule === "magic-string" || finding.rule === "magic-number") {
    return isTestFile(finding.file) ? "review-signal" : "blocking";
  }
  if (finding.rule === "duplicated-literal") {
    return "review-signal";
  }
  if ([
    "large-file-touched",
    "large-controller",
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
    "rest-route-uses-verb-segment",
    "rest-mutation-without-status-signal",
    "public-rest-route-without-version-signal",
    "ui-page-without-semantic-landmarks",
    "ui-button-used-as-link",
    "missing-port-interface-boundary",
    "presentation-imports-data-layer",
    "nestjs-controller-direct-data-access",
    "nestjs-mutating-route-without-auth-signal",
    "api-controller-without-openapi-contract-signal",
    "graphql-resolver-without-schema-or-complexity-signal",
    "protobuf-contract-without-breaking-check-signal",
    "readme-missing-api-env-usage-signal",
    "contributing-missing-review-test-policy",
    "coverage-report-below-threshold",
    "coverage-report-unreadable",
    "e2e-coverage-report-unreadable",
    "ui-hardcoded-text-without-i18n",
    "graphql-introspection-enabled-without-prod-guard",
    "grpc-proto-without-compatibility-signal",
    "critical-boundary-without-instrumentation-signal",
    "external-call-without-timeout-or-resilience",
    "external-call-without-circuit-breaker",
    "no-test-file-changed",
    "redundant-or-conflicting-aria-role",
    "missing-skip-link-for-repeated-navigation",
    "ui-render-blocking-work-signal",
    "ui-mixes-presentation-and-data-access",
    "heavy-dependency-without-bundle-budget",
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
