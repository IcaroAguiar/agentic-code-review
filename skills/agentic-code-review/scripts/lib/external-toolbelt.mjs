import { execFileSync } from "node:child_process";

function run(command, args, cwd, timeoutMs = 60_000, env = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024 * 12,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      }).trim(),
    };
  } catch (error) {
    const timedOut = error.code === "ETIMEDOUT" || error.signal === "SIGTERM";
    return {
      ok: false,
      stdout: error.stdout?.toString?.().trim() || "",
      stderr: timedOut ? `Timed out after ${timeoutMs}ms` : error.stderr?.toString?.().trim() || error.message,
      timedOut,
    };
  }
}

function hasCommand(command, cwd) {
  return run("sh", ["-lc", `command -v ${command}`], cwd).ok;
}

function firstAvailableCandidate(tool, cwd) {
  for (const candidate of tool.candidates) {
    if (hasCommand(candidate.command, cwd)) return candidate;
  }
  return null;
}

function downloadableCandidate(tool, cwd) {
  return tool.candidates.find((candidate) => candidate.downloads && hasCommand(candidate.command, cwd)) || null;
}

export function externalToolbelt(repo, shouldRun, allowDownloads = false, selectedToolNames = [], timeoutMs = 60_000) {
  const selected = new Set(selectedToolNames);
  const tools = [
    {
      name: "gitleaks",
      purpose: "secret scanning",
      candidates: [
        {
          command: "gitleaks",
          args: ["detect", "--source", repo.root, "--redact", "--no-banner"],
          downloads: false,
        },
      ],
      installHint: "brew install gitleaks",
      runWhen: () => true,
    },
    {
      name: "semgrep",
      purpose: "security and code-smell pattern scanning",
      candidates: [
        {
          command: "pysemgrep",
          args: ["scan", "--config", "p/default", "--error", "--quiet", repo.root],
          env: {
            OCAML_EXTRA_CA_CERTS: "/opt/homebrew/etc/ca-certificates/cert.pem",
            SEMGREP_ENABLE_VERSION_CHECK: "0",
            SEMGREP_LOG_FILE: "/tmp/codex-semgrep.log",
            SEMGREP_SEND_METRICS: "off",
          },
          downloads: false,
        },
        {
          command: "semgrep",
          args: ["scan", "--config", "p/default", "--error", "--quiet", repo.root],
          env: {
            OCAML_EXTRA_CA_CERTS: "/opt/homebrew/etc/ca-certificates/cert.pem",
            SEMGREP_ENABLE_VERSION_CHECK: "0",
            SEMGREP_LOG_FILE: "/tmp/codex-semgrep.log",
            SEMGREP_SEND_METRICS: "off",
          },
          downloads: false,
        },
        {
          command: "uvx",
          args: ["semgrep", "scan", "--config", "auto", "--error", "--quiet", repo.root],
          downloads: true,
        },
      ],
      installHint: "brew install semgrep or uv tool install semgrep",
      runWhen: () => true,
    },
    {
      name: "jscpd",
      purpose: "copy-paste and structural duplication",
      candidates: [
        {
          command: "jscpd",
          args: ["--min-lines", "8", "--min-tokens", "80", "--reporters", "console", repo.root],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "jscpd", "--min-lines", "8", "--min-tokens", "80", "--reporters", "console", repo.root],
          downloads: true,
        },
      ],
      installHint: "npm install -g jscpd",
      runWhen: () => true,
    },
    {
      name: "lizard",
      purpose: "cyclomatic complexity and long functions",
      candidates: [
        {
          command: "lizard",
          args: [repo.root],
          downloads: false,
        },
        {
          command: "uvx",
          args: ["lizard", repo.root],
          downloads: true,
        },
      ],
      installHint: "brew install lizard or uv tool install lizard",
      runWhen: () => true,
    },
    {
      name: "dependency-cruiser",
      purpose: "JavaScript/TypeScript dependency boundaries and cycles",
      candidates: [
        {
          command: "depcruise",
          args: ["--output-type", "err", repo.root],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "dependency-cruiser", "--output-type", "err", repo.root],
          downloads: true,
        },
      ],
      installHint: "npm install -g dependency-cruiser",
      runWhen: () => repo.entries.some((entry) => /\.[cm]?[tj]sx?$/.test(entry.path)),
    },
    {
      name: "madge",
      purpose: "JavaScript/TypeScript circular dependencies",
      candidates: [
        {
          command: "madge",
          args: ["--circular", repo.root],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "madge", "--circular", repo.root],
          downloads: true,
        },
      ],
      installHint: "npm install -g madge",
      runWhen: () => repo.entries.some((entry) => /\.[cm]?[tj]sx?$/.test(entry.path)),
    },
    {
      name: "osv-scanner",
      purpose: "dependency vulnerability scanning",
      candidates: [
        {
          command: "osv-scanner",
          args: ["--skip-git", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install osv-scanner",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|requirements.*\.txt|Gemfile\.lock|composer\.lock)$/.test(entry.path)),
    },
  ];

  return tools.filter((tool) => (selected.size === 0 || selected.has(tool.name)) && tool.runWhen()).map((tool) => {
    const localCandidate = firstAvailableCandidate({ ...tool, candidates: tool.candidates.filter((candidate) => !candidate.downloads) }, repo.root);
    const fallbackCandidate = downloadableCandidate(tool, repo.root);
    const candidate = localCandidate || (allowDownloads ? fallbackCandidate : null);
    const available = Boolean(candidate || fallbackCandidate);
    const command = candidate?.command || fallbackCandidate?.command || tool.candidates[0]?.command || tool.name;
    const args = candidate?.args || fallbackCandidate?.args || tool.candidates[0]?.args || [];

    if (!shouldRun || !candidate) {
      let status = "missing";
      if (localCandidate) status = "available-not-run";
      else if (fallbackCandidate) status = allowDownloads ? "downloadable-not-run" : "downloadable-disabled";
      return {
        ...tool,
        command,
        args,
        available,
        ran: false,
        status,
        output: "",
      };
    }

    const result = run(candidate.command, candidate.args, repo.root, timeoutMs, candidate.env);
    return {
      ...tool,
      command: candidate.command,
      args: candidate.args,
      available,
      ran: true,
      status: result.ok ? "passed" : result.timedOut ? "timed-out" : "reported-findings-or-failed",
      output: (result.stdout || result.stderr || "").replace(/\s+/g, " ").slice(0, 600),
    };
  });
}
