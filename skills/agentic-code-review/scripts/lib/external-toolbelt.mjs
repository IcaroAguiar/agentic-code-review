import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

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
  const dastTarget = repo.config?.dastTargets?.[0] || "";
  const performanceTarget = repo.config?.performanceTargets?.[0] || "";
  const a11yTarget = repo.config?.a11yTargets?.[0] || "";
  const bundleStatsPath = repo.config?.bundleStatsPath || "";
  const firstCppFile = repo.entries.find((entry) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.path))?.path || "";
  const rubyUserGemBins = (() => {
    const home = process.env.HOME || "";
    if (!home) return [];
    try {
      return readdirSync(`${home}/.gem/ruby`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${home}/.gem/ruby/${entry.name}/bin`);
    } catch {
      return [];
    }
  })();
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
      name: "semgrep-autofix",
      purpose: "Semgrep autofix suggestion mode for selected rules",
      candidates: [
        {
          command: "pysemgrep",
          args: ["scan", "--config", "p/default", "--autofix", "--dryrun", "--quiet", repo.root],
          env: {
            OCAML_EXTRA_CA_CERTS: "/opt/homebrew/etc/ca-certificates/cert.pem",
            SEMGREP_ENABLE_VERSION_CHECK: "0",
            SEMGREP_LOG_FILE: "/tmp/codex-semgrep-autofix.log",
            SEMGREP_SEND_METRICS: "off",
          },
          downloads: false,
        },
        {
          command: "semgrep",
          args: ["scan", "--config", "p/default", "--autofix", "--dryrun", "--quiet", repo.root],
          env: {
            OCAML_EXTRA_CA_CERTS: "/opt/homebrew/etc/ca-certificates/cert.pem",
            SEMGREP_ENABLE_VERSION_CHECK: "0",
            SEMGREP_LOG_FILE: "/tmp/codex-semgrep-autofix.log",
            SEMGREP_SEND_METRICS: "off",
          },
          downloads: false,
        },
      ],
      installHint: "brew install semgrep or uv tool install semgrep",
      runWhen: () => selected.has("semgrep-autofix"),
    },
    {
      name: "trufflehog",
      purpose: "secret scanning with verified credential detection",
      candidates: [
        {
          command: "trufflehog",
          args: ["filesystem", "--no-update", "--fail", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install trufflehog",
      runWhen: () => true,
    },
    {
      name: "git-secrets",
      purpose: "git secret pattern scanning",
      candidates: [
        {
          command: "git-secrets",
          args: ["--scan", "-r", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install git-secrets",
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
      name: "graphql-inspector",
      purpose: "GraphQL schema compatibility and breaking-change checks",
      candidates: [
        {
          command: "graphql-inspector",
          args: ["diff", repo.config?.graphqlBaseSchema || "schema.graphql", repo.config?.graphqlHeadSchema || "schema.graphql"],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "@graphql-inspector/cli", "diff", repo.config?.graphqlBaseSchema || "schema.graphql", repo.config?.graphqlHeadSchema || "schema.graphql"],
          downloads: true,
        },
      ],
      installHint: "npm install -g @graphql-inspector/cli",
      runWhen: () => selected.has("graphql-inspector") && repo.entries.some((entry) => /\.(graphql|gql)$|(^|\/)(graphql|schema)\//i.test(entry.path)),
    },
    {
      name: "buf",
      purpose: "Protobuf/gRPC lint and breaking-change checks",
      candidates: [
        {
          command: "buf",
          args: ["lint"],
          downloads: false,
        },
      ],
      installHint: "brew install bufbuild/buf/buf",
      runWhen: () => repo.entries.some((entry) => /\.proto$|(^|\/)buf\.(yaml|gen\.yaml)$/.test(entry.path)),
    },
    {
      name: "jdeps",
      purpose: "Java dependency graph and module boundary inspection",
      candidates: [
        {
          command: "jdeps",
          args: ["--recursive", repo.root],
          downloads: false,
        },
      ],
      installHint: "Install a JDK and ensure jdeps is on PATH",
      runWhen: () => repo.entries.some((entry) => /\.(java|jar)$|(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts)$/.test(entry.path)),
    },
    {
      name: "clang-callgraph",
      purpose: "C/C++ call graph extraction through clang tooling",
      candidates: [
        {
          command: "clang++",
          args: firstCppFile ? ["-Xclang", "-analyze", "-Xclang", "-analyzer-checker=debug.ViewCallGraph", "-fsyntax-only", firstCppFile] : ["--version"],
          downloads: false,
        },
      ],
      installHint: "brew install llvm and ensure clang++ is on PATH",
      runWhen: () => selected.has("clang-callgraph") && Boolean(firstCppFile),
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
    {
      name: "grype",
      purpose: "container and filesystem dependency vulnerability scanning",
      candidates: [
        {
          command: "grype",
          args: [`dir:${repo.root}`, "--fail-on", "high"],
          env: {
            GRYPE_CHECK_FOR_APP_UPDATE: "false",
            GRYPE_DB_CACHE_DIR: "/tmp/agentic-code-review-grype-db",
          },
          downloads: false,
        },
      ],
      installHint: "brew install grype",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(Dockerfile|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|poetry\.lock|requirements.*\.txt|Gemfile\.lock|composer\.lock)$/.test(entry.path)),
    },
    {
      name: "bandit",
      purpose: "Python security scanning",
      candidates: [
        {
          command: "bandit",
          args: ["-q", "-r", repo.root],
          downloads: false,
        },
        {
          command: "uvx",
          args: ["bandit", "-q", "-r", repo.root],
          downloads: true,
        },
      ],
      installHint: "uv tool install bandit or pipx install bandit",
      runWhen: () => repo.entries.some((entry) => /\.py$/.test(entry.path)),
    },
    {
      name: "pip-audit",
      purpose: "Python dependency vulnerability scanning",
      candidates: [
        {
          command: "pip-audit",
          args: [repo.root, "--progress-spinner", "off"],
          env: {
            XDG_CACHE_HOME: "/tmp/agentic-code-review-cache",
          },
          downloads: false,
        },
        {
          command: "uvx",
          args: ["pip-audit", repo.root, "--progress-spinner", "off"],
          env: {
            XDG_CACHE_HOME: "/tmp/agentic-code-review-cache",
          },
          downloads: true,
        },
      ],
      installHint: "uv tool install pip-audit or pipx install pip-audit",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(requirements.*\.txt|pyproject\.toml|poetry\.lock|Pipfile\.lock)$/.test(entry.path)),
    },
    {
      name: "gosec",
      purpose: "Go security scanning",
      candidates: [
        {
          command: "gosec",
          args: ["./..."],
          env: {
            GOCACHE: "/tmp/agentic-code-review-go-cache",
            GOMODCACHE: "/tmp/agentic-code-review-go-mod-cache",
          },
          downloads: false,
        },
      ],
      installHint: "go install github.com/securego/gosec/v2/cmd/gosec@latest",
      runWhen: () => repo.entries.some((entry) => /\.go$/.test(entry.path)),
    },
    {
      name: "govulncheck",
      purpose: "Go vulnerability scanning",
      candidates: [
        {
          command: "govulncheck",
          args: ["./..."],
          env: {
            GOCACHE: "/tmp/agentic-code-review-go-cache",
            GOMODCACHE: "/tmp/agentic-code-review-go-mod-cache",
          },
          downloads: false,
        },
      ],
      installHint: "go install golang.org/x/vuln/cmd/govulncheck@latest",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(go\.mod|go\.sum)$|\.go$/.test(entry.path)),
    },
    {
      name: "brakeman",
      purpose: "Ruby on Rails security scanning",
      candidates: [
        {
          command: "brakeman",
          args: ["-q", "--force", repo.root],
          downloads: false,
        },
        ...rubyUserGemBins.map((bin) => ({
          command: `${bin}/brakeman`,
          args: ["-q", "--force", repo.root],
          downloads: false,
        })),
      ],
      installHint: "gem install brakeman",
      runWhen: () => repo.entries.some((entry) => /\.rb$|(^|\/)Gemfile/.test(entry.path)),
    },
    {
      name: "spotbugs",
      purpose: "Java bytecode bug and security smell scanning",
      candidates: [
        {
          command: "spotbugs",
          args: ["-textui", "-effort:max", "-low", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install spotbugs",
      runWhen: () => repo.entries.some((entry) => /\.(java|kt)$|(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts)$/.test(entry.path)),
    },
    {
      name: "findsecbugs",
      purpose: "FindSecBugs Java security rules for SpotBugs",
      candidates: [
        {
          command: "findsecbugs",
          args: [repo.root],
          downloads: false,
        },
      ],
      installHint: "Install FindSecBugs/SpotBugs plugin and expose findsecbugs or configure SpotBugs with the FindSecBugs plugin",
      runWhen: () => repo.entries.some((entry) => /\.(java|kt)$|(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts)$/.test(entry.path)),
    },
    {
      name: "cppcheck",
      purpose: "C/C++ static analysis for bugs, undefined behavior, and security smells",
      candidates: [
        {
          command: "cppcheck",
          args: ["--enable=warning,style,performance,portability", "--error-exitcode=1", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install cppcheck",
      runWhen: () => repo.entries.some((entry) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(entry.path)),
    },
    {
      name: "clang-tidy",
      purpose: "C/C++ clang-tidy diagnostics for correctness, maintainability, and concurrency-sensitive code",
      candidates: [
        {
          command: "clang-tidy",
          args: firstCppFile ? [firstCppFile, "--"] : ["--version"],
          downloads: false,
        },
      ],
      installHint: "brew install llvm and ensure clang-tidy is on PATH",
      runWhen: () => Boolean(firstCppFile),
    },
    {
      name: "phpstan",
      purpose: "PHP static analysis and type-safety review",
      candidates: [
        {
          command: "phpstan",
          args: ["analyse", "--no-progress", repo.root],
          downloads: false,
        },
        {
          command: "vendor/bin/phpstan",
          args: ["analyse", "--no-progress", repo.root],
          downloads: false,
        },
      ],
      installHint: "composer require --dev phpstan/phpstan",
      runWhen: () => repo.entries.some((entry) => /\.php$|(^|\/)composer\.(json|lock)$/.test(entry.path)),
    },
    {
      name: "psalm",
      purpose: "PHP static analysis and taint/security-aware review",
      candidates: [
        {
          command: "psalm",
          args: ["--no-progress", "--output-format=console"],
          downloads: false,
        },
        {
          command: "vendor/bin/psalm",
          args: ["--no-progress", "--output-format=console"],
          downloads: false,
        },
      ],
      installHint: "composer require --dev vimeo/psalm",
      runWhen: () => repo.entries.some((entry) => /\.php$|(^|\/)(composer\.json|psalm\.xml)$/.test(entry.path)),
    },
    {
      name: "bundler-audit",
      purpose: "Ruby dependency vulnerability scanning",
      candidates: [
        {
          command: "bundle-audit",
          args: ["check"],
          downloads: false,
        },
        ...rubyUserGemBins.map((bin) => ({
          command: `${bin}/bundle-audit`,
          args: ["check"],
          downloads: false,
        })),
      ],
      installHint: "gem install bundler-audit",
      runWhen: () => repo.entries.some((entry) => /(^|\/)Gemfile\.lock$/.test(entry.path)),
    },
    {
      name: "trivy",
      purpose: "container and IaC misconfiguration scanning",
      candidates: [
        {
          command: "trivy",
          args: ["config", "--quiet", "--skip-check-update", "--cache-dir", "/tmp/agentic-code-review-trivy-cache", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install trivy",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Chart\.yaml|k8s|kubernetes|terraform|\.tf$)/i.test(entry.path)),
    },
    {
      name: "checkov",
      purpose: "Infrastructure-as-code security and compliance scanning",
      candidates: [
        {
          command: "checkov",
          args: ["--quiet", "-d", repo.root],
          downloads: false,
        },
        {
          command: "uvx",
          args: ["checkov", "--quiet", "-d", repo.root],
          downloads: true,
        },
      ],
      installHint: "uv tool install checkov or pipx install checkov",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Chart\.yaml|k8s|kubernetes|terraform|\.tf$)/i.test(entry.path)),
    },
    {
      name: "regula",
      purpose: "Infrastructure-as-code policy scanning",
      candidates: [
        {
          command: "regula",
          args: ["run", repo.root],
          downloads: false,
        },
      ],
      installHint: "brew install regula",
      runWhen: () => repo.entries.some((entry) => /(^|\/)(terraform|\.tf$|k8s|kubernetes|cloudformation|template\.ya?ml$)/i.test(entry.path)),
    },
    {
      name: "eslint-jsx-a11y",
      purpose: "React/JSX accessibility linting when project ESLint config includes jsx-a11y rules",
      candidates: [
        {
          command: "eslint",
          args: [repo.root, "--max-warnings=0"],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "eslint", repo.root, "--max-warnings=0"],
          downloads: true,
        },
      ],
      installHint: "npm install -D eslint eslint-plugin-jsx-a11y",
      runWhen: () => repo.entries.some((entry) => /\.(tsx|jsx)$/.test(entry.path)) && (selected.has("eslint-jsx-a11y") || repo.entries.some((entry) => /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.|$))/.test(entry.path))),
    },
    {
      name: "axe",
      purpose: "Opt-in browser accessibility scan for configured rendered UI targets",
      candidates: [
        {
          command: "axe",
          args: [a11yTarget, "--exit"],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "@axe-core/cli", a11yTarget, "--exit"],
          downloads: true,
        },
      ],
      installHint: "npm install -g @axe-core/cli",
      runWhen: () => selected.has("axe") && Boolean(a11yTarget),
    },
    {
      name: "size-limit",
      purpose: "Opt-in frontend bundle-size budget check",
      candidates: [
        {
          command: "size-limit",
          args: [],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "size-limit"],
          downloads: true,
        },
      ],
      installHint: "npm install -D size-limit @size-limit/preset-app",
      runWhen: () => selected.has("size-limit") && repo.entries.some((entry) => /(^|\/)(package\.json|vite\.config|webpack\.config|next\.config)/.test(entry.path)),
    },
    {
      name: "webpack-bundle-analyzer",
      purpose: "Opt-in webpack stats bundle analysis",
      candidates: [
        {
          command: "webpack-bundle-analyzer",
          args: bundleStatsPath ? [bundleStatsPath, "--mode", "static", "--no-open", "--report", "/tmp/agentic-code-review-bundle-report.html"] : ["--version"],
          downloads: false,
        },
        {
          command: "npx",
          args: bundleStatsPath ? ["--yes", "webpack-bundle-analyzer", bundleStatsPath, "--mode", "static", "--no-open", "--report", "/tmp/agentic-code-review-bundle-report.html"] : ["--yes", "webpack-bundle-analyzer", "--version"],
          downloads: true,
        },
      ],
      installHint: "npm install -D webpack-bundle-analyzer and configure bundleStatsPath",
      runWhen: () => selected.has("webpack-bundle-analyzer") && Boolean(bundleStatsPath),
    },
    {
      name: "autocannon",
      purpose: "HTTP load smoke for configured performance targets",
      candidates: [
        {
          command: "autocannon",
          args: ["-d", "10", "-c", "10", performanceTarget],
          downloads: false,
        },
        {
          command: "npx",
          args: ["--yes", "autocannon", "-d", "10", "-c", "10", performanceTarget],
          downloads: true,
        },
      ],
      installHint: "npm install -g autocannon",
      runWhen: () => selected.has("autocannon") && Boolean(performanceTarget),
    },
    {
      name: "wrk",
      purpose: "HTTP load smoke for configured performance targets",
      candidates: [
        {
          command: "wrk",
          args: ["-t2", "-c10", "-d10s", performanceTarget],
          downloads: false,
        },
      ],
      installHint: "brew install wrk",
      runWhen: () => selected.has("wrk") && Boolean(performanceTarget),
    },
    {
      name: "zap-baseline",
      purpose: "OWASP ZAP baseline DAST scan for configured staging targets",
      candidates: [
        {
          command: "zap-baseline.py",
          args: ["-t", dastTarget, "-r", "/tmp/agentic-code-review-zap-report.html"],
          downloads: false,
        },
      ],
      installHint: "Install OWASP ZAP and expose zap-baseline.py",
      runWhen: () => selected.has("zap-baseline") && Boolean(dastTarget),
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
