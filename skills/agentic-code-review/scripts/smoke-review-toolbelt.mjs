#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const collector = join(scriptDir, "collect-review-context.mjs");
const root = "/private/tmp/agentic-code-review-smoke";

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createRepo(name, files) {
  const repo = join(root, name);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  run("git", ["init"], repo);
  for (const [path, content] of Object.entries(files)) write(join(repo, path), content);
  return repo;
}

function commitAll(repo, message) {
  run("git", ["add", "."], repo);
  run("git", ["-c", "user.name=Codex Smoke", "-c", "user.email=codex-smoke@example.local", "commit", "-m", message], repo);
  return run("git", ["rev-parse", "HEAD"], repo).trim();
}

function collect(repo, extraArgs = []) {
  return run("node", [collector, ...extraArgs], repo);
}

function expectIncludes(name, output, expected) {
  if (!output.includes(expected)) {
    throw new Error(`${name}: expected output to include ${JSON.stringify(expected)}`);
  }
}

function expectNotIncludes(name, output, unexpected) {
  if (output.includes(unexpected)) {
    throw new Error(`${name}: expected output not to include ${JSON.stringify(unexpected)}`);
  }
}

const cases = [
  {
    name: "sql-risk",
    files: {
      "src/search.ts": `export async function searchUsers(prisma: any, term: string) {
  return prisma.$queryRawUnsafe(\`SELECT * FROM "User" WHERE name = '\${term}'\`);
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "raw-sql-injection-risk");
      expectIncludes(this.name, output, "interpolated-raw-sql-risk");
      expectIncludes(this.name, output, "For raw SQL/security signals");
    },
  },
  {
    name: "n-plus-one",
    files: {
      "app/users.go": `package app

func LoadUsers(db DB, ids []int) []string {
  for _, id := range ids {
    db.Query("SELECT name FROM users WHERE id = ?", id)
  }
  return []string{"active"}
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "possible-n-plus-one-query");
      expectIncludes(this.name, output, "For N+1 signals");
    },
  },
  {
    name: "unbounded-list-query",
    files: {
      "src/users.repository.ts": `export async function listUsers(prisma: any) {
  return prisma.user.findMany({
    where: { active: true },
  });
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "unbounded-list-query");
      expectIncludes(this.name, output, "pagination/limit");
    },
  },
  {
    name: "web-runtime-security",
    files: {
      "src/render.ts": `import { exec } from "node:child_process";
import { readFileSync } from "node:fs";

export function renderHtml(element: HTMLElement, html: string) {
  element.innerHTML = html;
}

export function runReport(input: string) {
  exec("node scripts/report.js " + input);
}

export function readUserFile(req: { query: { path: string } }) {
  return readFileSync(req.query.path, "utf8");
}

export function logToken(token: string) {
  console.warn("accessToken", token);
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "potential-xss-unsanitized-html");
      expectIncludes(this.name, output, "command-injection-risk");
      expectIncludes(this.name, output, "path-traversal-risk");
      expectIncludes(this.name, output, "sensitive-data-logging-risk");
    },
  },
  {
    name: "owasp-expanded-security",
    files: {
      ".agentic-reviewrc.json": `{
  "domainCatalogs": ["lgpd", "finance"]
}
`,
      "src/security.ts": `import crypto from "node:crypto";
import { fetch } from "undici";

export function weakHash(password: string) {
  return crypto.createHash("md5").update(password).digest("hex");
}

export function cors(res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.cookie("session", "abc");
}

export async function callback(req: any, res: any) {
  await fetch(req.query.url);
  res.redirect(req.query.returnTo);
}

export function upload(app: any) {
  app.post("/upload", upload.single("file"), handler);
}

export function webhook(req: any) {
  return stripeWebhookPayload(req.body);
}

export async function login(req: any) {
  return authenticate(req.body.password);
}

export async function retryJob(client: any) {
  for (let index = 0; index < 3; index += 1) {
    await client.send();
  }
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "weak-cryptographic-hash");
      expectIncludes(this.name, output, "permissive-cors-policy");
      expectIncludes(this.name, output, "cookie-missing-security-attributes");
      expectIncludes(this.name, output, "ssrf-risk-unvalidated-url-fetch");
      expectIncludes(this.name, output, "open-redirect-risk");
      expectIncludes(this.name, output, "file-upload-without-validation");
      expectIncludes(this.name, output, "webhook-without-signature-verification");
      expectIncludes(this.name, output, "auth-boundary-without-rate-limit-signal");
      expectIncludes(this.name, output, "retry-without-backoff-or-timeout");
      expectIncludes(this.name, output, "LGPD/privacy");
      expectIncludes(this.name, output, "Financeiro");
      expectIncludes(this.name, output, "For OWASP/security-boundary signals");
    },
  },
  {
    name: "artifact-checkpoint",
    files: {
      ".playwright-cli/session.json": `{"status":"local"}`,
    },
    assert(output) {
      expectIncludes(this.name, output, "local-or-generated-artifacts-in-diff");
      expectIncludes(this.name, output, "artefatos locais/gerados");
    },
  },
  {
    name: "control-block-not-function",
    files: {
      "src/control.ts": `if (ready) {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          console.log("done");
        }
      }
    }
  }
}
`,
    },
    assert(output) {
      expectNotIncludes(this.name, output, "long-function-touched");
      expectNotIncludes(this.name, output, "deep-nesting-touched");
    },
  },
  {
    name: "prod-test-literal-classification",
    files: {
      "src/status.ts": `export function approve(status: string) {
  if (status === "APPROVED") return "APPROVED";
  return "PENDING";
}
`,
      "src/status.test.ts": `test("approved", () => {
  expect(approve("APPROVED")).toBe("APPROVED");
});
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "duplicated-literal");
      expectIncludes(this.name, output, "prod files: 1; test files: 1");
      expectIncludes(this.name, output, "blocking:");
    },
  },
  {
    name: "local-literal-path",
    files: {
      "src/config.ts": `export const callbackUrl = "http://localhost:3000/callback";
export const cachePath = "/Users/example/project/cache";
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "local-literal-path-or-url");
      expectIncludes(this.name, output, "hardcoded local paths");
    },
  },
  {
    name: "mock-only-test",
    files: {
      "src/user.test.ts": `test("calls repository", () => {
  const repo = { save: jest.fn() };
  repo.save({ id: "user-1" });
  expect(repo.save).toHaveBeenCalledWith({ id: "user-1" });
});
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "mock-only-test-path");
      expectIncludes(this.name, output, "mock-heavy");
    },
  },
  {
    name: "stale-test-mock-and-narrating-comment",
    files: {
      "src/useLearningProgress.ts": `import { getCourseProgressSummary, listEnrollments } from "@/lib/apiEnrollments";

export async function useLearningProgress(productId: string) {
  // 2) Para os que tem matrícula, busca o resumo de progresso por produto
  const enrollments = await listEnrollments();
  return getCourseProgressSummary({ productId, enrollmentId: enrollments[0]?.id });
}
`,
      "src/useLearningProgress.test.ts": `import { expect, test, vi } from "vitest";
import { useLearningProgress } from "./useLearningProgress";

const getCourseProgressSummaryMock = vi.fn();
const fetchCourseByProductIdMock = vi.fn();

vi.mock("@/lib/apiEnrollments", () => ({
  listEnrollments: vi.fn(),
  getCourseProgressSummary: (...args) => getCourseProgressSummaryMock(...args),
}));

vi.mock("@/lib/apiProducts", () => ({
  fetchCourseByProductId: (...args) => fetchCourseByProductIdMock(...args),
}));

test("loads progress", async () => {
  await useLearningProgress("product-1");
  expect(fetchCourseByProductIdMock).not.toHaveBeenCalled();
});
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "stale-or-orphaned-test-mock");
      expectIncludes(this.name, output, "no changed production file imports");
      expectIncludes(this.name, output, "implementation-narrating-comment");
    },
  },
  {
    name: "happy-path-only",
    files: {
      "src/service.ts": `export function createUser(input: { email: string }) {
  return { ok: true, email: input.email };
}
`,
      "src/service.test.ts": `import { createUser } from "./service";

test("creates valid user successfully", () => {
  expect(createUser({ email: "a@b.test" }).ok).toBe(true);
});
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "happy-path-only-test-change");
      expectIncludes(this.name, output, "failure, invalid, empty");
    },
  },
  {
    name: "masked-error-state-console-warn-and-duplicated-helper",
    files: {
      "src/ProductsCarousel.tsx": `function productSlotKey(productId: string, index: number) {
  return productId + "-" + index;
}

export function ProductsCarousel() {
  return productSlotKey("product-1", 0);
}
`,
      "src/ProductsSection.tsx": `function productSlotKey(productId: string, index: number) {
  return productId + "-" + index;
}

async function fetchProductByIdOrNull(productId: string) {
  try {
    return await fetchProductById(productId);
  } catch (err) {
    console.warn("[products-section] falha ao buscar produto", err);
    return null;
  }
}

export function ProductsSection({ productQueries }: { productQueries: Array<{ isError: boolean }> }) {
  const isError = productQueries.some((query) => query.isError);
  return isError ? "Erro ao carregar produtos desta seção." : productSlotKey("product-1", 0);
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "error-state-masked-by-null-fallback");
      expectIncludes(this.name, output, "direct-console-warning");
      expectIncludes(this.name, output, "duplicated-helper-function");
      expectIncludes(this.name, output, "productSlotKey");
    },
  },
  {
    name: "branding-advanced-contract-risks",
    files: {
      "src/brandingPatch.ts": `export function buildChangedValue(draft: unknown, persisted: unknown) {
  if (draft === persisted) return undefined;
  return draft;
}

export function buildPatch(draft: { sidebar?: { itemRadius?: string } }, persisted: { sidebar?: { itemRadius?: string } }) {
  const changedValue = buildChangedValue(draft.sidebar?.itemRadius, persisted.sidebar?.itemRadius);
  const patch: { sidebar?: { itemRadius?: string } } = {};
  if (changedValue !== undefined) {
    patch.sidebar = { itemRadius: changedValue as string };
  }
  return patch;
}

export function applyObjectPatch(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...base, ...patch };
}
`,
      "src/brandingPatch.test.ts": `import { buildPatch } from "./brandingPatch";

test("salva patch de sidebar alterada", () => {
  expect(buildPatch({ sidebar: { itemRadius: "lg" } }, { sidebar: { itemRadius: "sm" } })).toEqual({
    sidebar: { itemRadius: "lg" },
  });
});
`,
      "src/PreviewArea.tsx": `export function PreviewArea({ activeTab, sections, onSectionsChange, appearance }) {
  return activeTab === "showcase" || activeTab === "settings" ? (
    <ShowcasePreview
      sections={sections}
      onSectionsChange={onSectionsChange}
      appearance={appearance}
    />
  ) : null;
}
`,
      "src/SidebarItemIcon.tsx": `const iconPath = "M4 4h16v16H4z";

export function SidebarItemIcon({ iconLibrary, iconStyle }) {
  const scale = iconLibrary === "phosphor" || iconLibrary === "heroicons" || iconLibrary === "tabler" || iconLibrary === "remix" ? 1.05 : 1;
  return (
    <svg style={{ transform: "scale(" + scale + ")" }}>
      <path d={iconPath} opacity={iconStyle === "duotone" ? 0.5 : 1} />
    </svg>
  );
}
`,
      "src/appearance.ts": `export const ICON_LIBRARIES = ["lucide", "phosphor", "tabler", "heroicons", "remix"] as const;

export function normalizeMemberAreaAppearance(input: any) {
  return {
    iconLibrary: input.iconLibrary ?? "lucide",
    iconStyle: input.iconStyle ?? "line",
    hoverEffect: input.hoverEffect ?? "soft",
    activeEffect: input.activeEffect ?? "solid",
    transitionPreset: input.transitionPreset ?? "fast",
    itemRadius: input.itemRadius ?? "md",
    height: input.height ?? "default",
    searchStyle: input.searchStyle ?? "pill",
    actionStyle: input.actionStyle ?? "ghost",
  };
}
`,
      "src/MemberSidebar.tsx": `export function MemberSidebar({ sidebar }) {
  const sidebarStyle = {
    "--member-sidebar-hover-bg": sidebar.itemHoverBackgroundColor,
    "--member-sidebar-active-bg": sidebar.itemActiveBackgroundColor,
    "--member-sidebar-border": sidebar.borderColor,
    "--member-sidebar-item-radius": sidebar.itemRadius,
  };
  return <aside style={sidebarStyle} />;
}
`,
      "src/sidebarBackground.ts": `export function resolveSidebarBackgroundStyle(sidebar) {
  if (sidebar.backgroundColor?.includes("gradient(")) {
    return { backgroundImage: sidebar.backgroundColor };
  }
  return { backgroundColor: sidebar.backgroundColor };
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "patch-undefined-no-change-ambiguity");
      expectIncludes(this.name, output, "deep-merge-without-removal-semantics");
      expectIncludes(this.name, output, "patch-reset-coverage-gap");
      expectIncludes(this.name, output, "preview-tab-passes-edit-callback");
      expectIncludes(this.name, output, "simulated-icon-library-contract");
      expectIncludes(this.name, output, "enum-field-without-membership-normalization");
      expectIncludes(this.name, output, "unsanitized-branding-css-token");
      expectIncludes(this.name, output, "background-color-carries-gradient");
    },
  },
  {
    name: "public-contract-root-risks",
    files: {
      "src/contracts/account.response.ts": `type AccountBranding = {
  privateToken?: string;
  backgroundColor?: string;
};

type PublicAccountBranding = {
  backgroundColor?: string;
};

export type AccountPublicResponse = {
  id: string;
  branding: AccountBranding;
};

function sanitizeAccountBranding(branding: AccountBranding): PublicAccountBranding {
  return { backgroundColor: branding.backgroundColor };
}

export function toPublicAccountResponse(state: { id: string; legacy: AccountBranding }) {
  const publicLegacy = sanitizeAccountBranding(state.legacy);
  return {
    id: state.id,
    branding: state.legacy,
    publicBranding: publicLegacy,
  };
}
`,
      "src/contracts/theme.dto.ts": `function IsString() {
  return function noop() {};
}

export class ThemeInputDto {
  @IsString()
  accentColor?: string;

  @IsString()
  sidebarRadius?: string;

  @IsString()
  iconStyle?: string;
}
`,
      "src/contracts/theme-defaults.ts": `export const DEFAULT_HEADER_APPEARANCE = {
  backgroundColor: "#fff",
  foregroundColor: "#111",
  gradientFrom: "#fff",
  gradientTo: "#eee",
  iconStyle: "line",
  hoverEffect: "soft",
  activeEffect: "solid",
  itemRadius: "md",
};

export const DEFAULT_SIDEBAR_APPEARANCE = {
  backgroundType: "solid",
  shape: "flat",
};

export const runtimeFields = {
  accentColor: true,
  backgroundGradient: true,
  borderRadius: true,
  iconStyle: true,
  transitionPreset: true,
  hoverEffect: true,
  activeEffect: true,
};
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "public-contract-bypasses-sanitizer");
      expectIncludes(this.name, output, "public-response-uses-internal-type");
      expectIncludes(this.name, output, "config-token-weak-string-validation");
      expectIncludes(this.name, output, "config-defaults-asymmetry-signal");
    },
  },
  {
    name: "bundle-code-splitting-signal",
    files: {
      "src/routes/dashboard.tsx": `import MonacoEditor from "monaco-editor";

export function DashboardRoute() {
  return <MonacoEditor />;
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "static-heavy-ui-import-without-lazy-boundary");
      expectIncludes(this.name, output, "route-level code-splitting");
      expectIncludes(this.name, output, "review-signal:");
    },
  },
  {
    name: "rest-api-design",
    files: {
      "src/orders.controller.ts": `function Get(path: string) {
  return function noop() {};
}

function Post(path: string) {
  return function noop() {};
}

export class OrdersController {
  @Get("/api/delete/order")
  deleteOrder() {
    return { ok: true };
  }

  @Get("/orders")
  listOrders() {
    return prisma.order.findMany({ where: { archived: false } });
  }

  @Post("/orders")
  createOrder() {
    return { id: "order-1" };
  }
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "rest-route-uses-verb-segment");
      expectIncludes(this.name, output, "rest-get-mutating-action-signal");
      expectIncludes(this.name, output, "rest-list-without-pagination-or-filter-signal");
      expectIncludes(this.name, output, "rest-mutation-without-status-signal");
      expectIncludes(this.name, output, "For REST/API design signals");
    },
  },
  {
    name: "ui-semantics-a11y",
    files: {
      "src/pages/DashboardPage.tsx": `export function DashboardPage() {
  return (
    <div>
      <div><img src="/logo.png" /></div>
      <div onClick={() => save()}>Salvar</div>
      <input value="" onChange={() => {}} />
      <a onClick={() => save()}>Executar</a>
      <button href="/settings">Configuracoes</button>
      ${Array.from({ length: 12 }, (_, index) => `<div>Item ${index}</div>`).join("\n      ")}
    </div>
  );
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "ui-image-missing-alt");
      expectIncludes(this.name, output, "ui-input-without-label-signal");
      expectIncludes(this.name, output, "ui-clickable-div-without-keyboard-semantics");
      expectIncludes(this.name, output, "ui-anchor-used-as-button");
      expectIncludes(this.name, output, "ui-button-used-as-link");
      expectIncludes(this.name, output, "ui-page-without-semantic-landmarks");
      expectIncludes(this.name, output, "For UI semantics/accessibility signals");
    },
  },
  {
    name: "architecture-boundaries",
    files: {
      "src/domain/order.ts": `import { PrismaClient } from "../infra/prisma";

export class OrderPolicy {
  constructor(private readonly prisma = new PrismaClient()) {}
}
`,
      "src/components/OrdersPage.tsx": `import { prisma } from "../infra/prisma";

export function OrdersPage() {
  const orders = prisma.order.findMany();
  return <div>{orders.length}</div>;
}
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "domain-layer-imports-outer-layer");
      expectIncludes(this.name, output, "presentation-imports-data-layer");
      expectIncludes(this.name, output, "ui-mixes-presentation-and-data-access");
      expectIncludes(this.name, output, "For architecture/layering signals");
    },
  },
  {
    name: "backend-boundary-without-integration",
    files: {
      "src/users.controller.ts": `export class UsersController {
  create(body: { name: string }) {
    return { id: "user-1", name: body.name };
  }
}
`,
      "src/users.controller.spec.ts": `import { UsersController } from "./users.controller";

test("creates user", () => {
  expect(new UsersController().create({ name: "Ana" }).id).toBe("user-1");
});
`,
    },
    assert(output) {
      expectIncludes(this.name, output, "backend-boundary-without-e2e-or-integration");
      expectIncludes(this.name, output, "integration/e2e path");
    },
  },
  {
    name: "features-folder-is-production",
    files: {
      "src/features/dashboard/components/Panel.tsx": `export function Panel() {
  return <div>Dashboard</div>;
}
`,
    },
    assert(output) {
      expectNotIncludes(this.name, output, "weak-test-assertion-signal");
      expectIncludes(this.name, output, "no-test-file-changed");
    },
  },
  {
    name: "python-any-builtin-safe",
    files: {
      "src/rules.py": `def has_keyword(values, keywords):
    return any(keyword in values for keyword in keywords)
`,
    },
    assert(output) {
      expectNotIncludes(this.name, output, "unsafe-typing");
    },
  },
  {
    name: "app-api-path-not-contract",
    files: {
      "apps/api/prisma/migrations/20260401000000_init/migration.sql": `ALTER TABLE "Import" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "Import_tenantId_idx" ON "Import"("tenantId");
`,
    },
    assert(output) {
      expectNotIncludes(this.name, output, "For cross-repo or contract/schema/API/client changes");
      expectNotIncludes(this.name, output, "occurrences of");
    },
  },
  {
    name: "append-only-changelog-no-refactor-gate",
    files: {
      "src/lib/data/changelog.ts": `${Array.from({ length: 520 }, (_, index) => `export const entry${index} = "Release ${index}";`).join("\n")}
`,
    },
    assert(output) {
      expectNotIncludes(this.name, output, "large-file-touched");
      expectNotIncludes(this.name, output, "multiple-responsibilities-in-large-file");
    },
  },
  {
    name: "minified-third-party-bundle-is-artifact",
    files: {
      "public/pdf.worker.min.mjs": `try{console.log("debug")}catch(e){};const names=["string","number","string","number","string","number","string","number"];describe.skip("vendor",()=>{});`,
    },
    assert(output) {
      expectIncludes(this.name, output, "local-or-generated-artifacts-in-diff");
      expectNotIncludes(this.name, output, "test-focus-artifact");
      expectNotIncludes(this.name, output, "occurrences of");
    },
  },
];

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

for (const testCase of cases) {
  const repo = createRepo(testCase.name, testCase.files);
  const output = collect(repo);
  testCase.assert(output);
  console.log(`PASS ${testCase.name}`);
}

const crossRepoRoot = join(root, "cross-repo");
const producer = createRepo("cross-repo/producer", {
  "src/contracts/user.dto.ts": `export type UserDto = { id: string; status: "ACTIVE" };`,
});
const consumer = createRepo("cross-repo/consumer", {
  "src/client.ts": `export function renderUser(user: { id: string }) { return user.id; }`,
});
const crossRepoOutput = run("node", [collector, "--root", producer, "--root", consumer], crossRepoRoot);
expectIncludes("cross-repo-contract", crossRepoOutput, "cross-repo-contract-without-consumer-check");
expectIncludes("cross-repo-contract", crossRepoOutput, "consumer compatibility");
console.log("PASS cross-repo-contract");

const historicalRepo = createRepo("historical-head-range", {
  "src/service.ts": `export function status() {
  return "SAFE";
}
`,
});
const historicalBase = commitAll(historicalRepo, "base");
write(join(historicalRepo, "src/service.ts"), `export function status(input: string) {
  if (input === "APPROVED") return "APPROVED";
  return "PENDING";
}
`);
const historicalHead = commitAll(historicalRepo, "head with literal");
write(join(historicalRepo, "src/service.ts"), `export function status() {
  return "WORKTREE_ONLY";
}
`);
const historicalOutput = collect(historicalRepo, ["--base", historicalBase, "--head", historicalHead]);
expectIncludes("historical-head-range", historicalOutput, "APPROVED");
expectNotIncludes("historical-head-range", historicalOutput, "WORKTREE_ONLY");
console.log("PASS historical-head-range");

const selectedToolOutput = collect(historicalRepo, ["--external-tool", "jscpd"]);
expectIncludes("external-tool-selection", selectedToolOutput, "Selected tools: jscpd");
expectIncludes("external-tool-selection", selectedToolOutput, "jscpd");
expectNotIncludes("external-tool-selection", selectedToolOutput, "madge");
console.log("PASS external-tool-selection");

const selectedAdvancedToolOutput = collect(historicalRepo, ["--external-tool", "semgrep-autofix"]);
expectIncludes("advanced-tool-selection", selectedAdvancedToolOutput, "Selected tools: semgrep-autofix");
expectIncludes("advanced-tool-selection", selectedAdvancedToolOutput, "semgrep-autofix");
expectNotIncludes("advanced-tool-selection", selectedAdvancedToolOutput, "autocannon");
console.log("PASS advanced-tool-selection");

const adaptiveToolRepo = createRepo("adaptive-language-tools", {
  "pom.xml": `<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>x</artifactId><version>1</version></project>`,
  "src/main/java/App.java": `class App {}`,
  "native/main.cpp": `int main() { return 0; }`,
  "composer.json": `{"require": {}}`,
  "src/index.php": `<?php echo "ok";`,
  "src/App.tsx": `export function App() { return <img src="/logo.png" />; }`,
  "eslint.config.js": `export default [];`,
});
const adaptiveToolOutput = collect(adaptiveToolRepo);
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "spotbugs");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "findsecbugs");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "cppcheck");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "clang-tidy");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "phpstan");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "psalm");
expectIncludes("adaptive-language-tools", adaptiveToolOutput, "eslint-jsx-a11y");
console.log("PASS adaptive-language-tools");

const jsonOutput = collect(historicalRepo, ["--base", historicalBase, "--head", historicalHead, "--json"]);
const jsonPacket = JSON.parse(jsonOutput);
if (jsonPacket.status !== "ok" || jsonPacket.crossRepoSummary.findings < 1 || !Array.isArray(jsonPacket.repositories)) {
  throw new Error("json-output: expected structured ok packet with findings and repositories");
}
console.log("PASS json-output");

const configuredRepo = createRepo("configured-rules", {
  ".agentic-reviewrc.json": `{
  "rules": { "magic-string": false },
  "customQuestions": ["Custom checkpoint?"],
  "ignorePaths": ["ignored/**"]
}
`,
  "src/status.ts": `export function approve(status: string) {
  if (status === "APPROVED") return "APPROVED";
  return "PENDING";
}
`,
  "ignored/debug.ts": `console.warn("should be ignored");`,
});
const configuredOutput = collect(configuredRepo);
expectNotIncludes("configured-rules", configuredOutput, "] magic-string at");
expectNotIncludes("configured-rules", configuredOutput, "ignored/debug.ts");
expectIncludes("configured-rules", configuredOutput, "Custom checkpoint?");
console.log("PASS configured-rules");

const calibrationOutput = run("node", [join(scriptDir, "calibrate-review-history.mjs"), "--repo", historicalRepo, "--case", `historical:${historicalBase}:${historicalHead}`, "--json"], historicalRepo);
const calibrationPacket = JSON.parse(calibrationOutput);
if (calibrationPacket.cases?.[0]?.status !== "ok") {
  throw new Error("calibration-cli: expected ok calibration case");
}
console.log("PASS calibration-cli");

const skillText = readFileSync(join(scriptDir, "..", "SKILL.md"), "utf8");
const qaEvidenceText = readFileSync(join(scriptDir, "..", "templates", "qa-evidence.md"), "utf8");
expectIncludes("deterministic-is-not-gate", skillText, "The deterministic collector is tool support for the reviewer. It is not the gate by itself.");
expectIncludes("deterministic-is-not-gate", skillText, "The deterministic agentic-code-review packet is clean, but the full agentic-code-review gate is incomplete");
expectIncludes("independent-review", skillText, "one independent reviewer, subagent, or fresh-context review pass");
expectIncludes("definition-of-done-checklist", skillText, "## Definition Of Done Checklist");
expectIncludes("definition-of-done-checklist", skillText, "Diff is minimal, scoped, and reviewable.");
expectIncludes("definition-of-done-checklist", skillText, "The exact touched production code path was exercised");
expectIncludes("definition-of-done-checklist", skillText, "Validation summary is behavior-oriented; raw command dumps are not used as reviewer-facing proof.");
expectIncludes("definition-of-done-checklist", skillText, "One independent reviewer, subagent, or fresh-context review pass completed the agentic review");
expectIncludes("definition-of-done-checklist", skillText, "Skipped checks include exact reason and residual risk.");
expectIncludes("reviewer-noisy-packet-triage", skillText, "When deterministic output is noisy, prioritize semantic and behavioral issues over style/context signals.");
expectIncludes("reviewer-noisy-packet-triage", skillText, "otherwise keep them in checkpoints or `Pontos de atenção adicionais`.");
expectIncludes("json-config-calibration", skillText, "--json");
expectIncludes("json-config-calibration", skillText, ".agentic-reviewrc.json");
expectIncludes("json-config-calibration", skillText, "agentic-code-review calibrate");
expectIncludes("owasp-expanded-docs", skillText, "OWASP");
expectIncludes("owasp-expanded-docs", skillText, "domainCatalogs");
expectIncludes("owasp-expanded-docs", skillText, "zap-baseline");
expectIncludes("web-api-architecture-docs", skillText, "REST/API design risks");
expectIncludes("web-api-architecture-docs", skillText, "UI semantics/accessibility risks");
expectIncludes("web-api-architecture-docs", skillText, "architecture/layering signals");
expectIncludes("web-api-architecture-docs", skillText, "spotbugs");
expectIncludes("web-api-architecture-docs", skillText, "appType");
expectIncludes("browser-use-first-for-web-qa", skillText, "Web UI/browser changes, with the main agent using browser-use first");
expectIncludes("authenticated-smoke-credentials", skillText, "do not accept \"login failed\" or \"stopped at login\" as sufficient evidence");
expectIncludes("authenticated-smoke-credentials", skillText, "For `staging` or `prod`, it must not create credentials");
expectIncludes("authenticated-smoke-credentials", qaEvidenceText, "Credential lookup performed");
expectIncludes("authenticated-smoke-credentials", qaEvidenceText, "Credential creation decision when no saved source exists");
expectNotIncludes("no-local-user-paths", skillText, "/Users/");
console.log("PASS public-skill-contract");

console.log(`PASS ${cases.length + 9}/${cases.length + 9} agentic-code-review smoke cases`);
