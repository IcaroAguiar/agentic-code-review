# QA Evidence Contract

Use this contract whenever UI, browser, desktop, CLI interaction, authenticated smoke, or visual behavior changed.

## Flow Tested

- Flow:
- Surface:
- Environment:
- Build/deploy target:
- Credentials source: redacted path or instruction source only, never values.
- Credential lookup performed: repository instructions, workstream memory, restricted credential file, documented local creation, or user-provided access.
- Credential creation decision when no saved source exists: documented local/dev seed/setup used, asked user for missing detail, or not allowed for staging/prod.

## Initial State

- User/session state:
- Data/setup state:
- Feature flags/config:
- Known limitations before test:
- Auth setup state: target environment matched credential source, backend/API status, seed/setup assumption.

## Actions Performed

1. 
2. 
3. 

## Observed Result

- Expected behavior:
- Actual behavior:
- Auth result when applicable: success, blocked before credential lookup, saved credential failed, environment mismatch, backend/API unavailable, auth bug suspected, or missing seed/setup.
- Regression protected:
- Accessibility/focus/keyboard observation when applicable:
- Responsive/mobile observation when applicable:

## Evidence

- Screenshot/video path or uploaded asset:
- Browser-use notes for web flows, including whether an existing tab was reused or a new browser-use tab/session was opened. Computer-use notes only for desktop/native/local-app flows or documented failed browser-use bootstrap/open attempt:
- Complementary deterministic test/probe:

## Bugs Found

- No bug observed.

If a bug is observed, replace the line above with:

- Bug:
- Reproduction steps:
- Expected:
- Actual:
- Severity:
- Follow-up: fixed in this task, opened issue/PR, or explicitly deferred with reason.
