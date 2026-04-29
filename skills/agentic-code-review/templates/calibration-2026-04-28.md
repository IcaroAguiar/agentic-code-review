# Agentic Code Review Calibration Template

Purpose: record how the deterministic collector behaves against representative historical PRs, merge commits, or review windows. Calibration keeps the scanner useful without turning noisy style signals into automatic blockers.

## Suggested Method

Run the collector against historical windows where the final outcome is known:

```bash
node skills/agentic-code-review/scripts/collect-review-context.mjs --base <base-sha> --head <head-sha>
```

For each window, record:

- repository or anonymized domain;
- base/head range;
- changed file count;
- high/medium/low findings;
- normalized gate summary;
- findings that matched real review or production issues;
- false positives;
- false negatives;
- rule tuning decisions.

## Calibration Table

| Window | Files | Findings high/medium/low | Blocking | Review signals | Runtime requirements | Questions | Notes |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| example-pr-1 | 0 | 0/0/0 | 0 | 0 | 0 | 0 | replace with local calibration data |

## Tuning Notes

- Magic strings and duplicated literals are intentionally strict when they affect production logic, contracts, security-sensitive values, or domain vocabulary. Treat user-facing copy and fixtures with context.
- N+1, unbounded query, SQL injection, transaction, idempotency, and public-contract signals should be verified against the real code path before becoming final findings.
- Large-file, SRP, Object Calisthenics, and code-splitting signals are review context unless they create a concrete regression, maintenance risk, or scope decision.
- Runtime verification requirements are not static findings. They describe evidence that must be produced before closeout.

## Smoke Evidence

After scanner changes, run:

```bash
node skills/agentic-code-review/scripts/smoke-review-toolbelt.mjs
```

Record the pass count here before publishing a release.
