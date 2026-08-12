import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("contracts/fastapi/routes.json", "utf8"));
const workerSource = readFileSync("worker/index.ts", "utf8");
const wranglerSource = readFileSync("wrangler.jsonc", "utf8");

const owners = [
  { label: "root", match: (path) => path === "/", evidence: 'url.pathname === "/"' },
  { label: "health", match: (path) => path === "/health", evidence: 'url.pathname === "/health"' },
  { label: "auth", match: (path) => path.startsWith("/auth/"), evidence: 'url.pathname === "/auth/' },
  { label: "AGM", match: (path) => path.startsWith("/agm/"), evidence: 'url.pathname.startsWith("/agm/")' },
  { label: "workforce", match: (path) => ["/employees", "/sections", "/shifts", "/seasons", "/store-preferences", "/cobrands", "/daily-rosters", "/teamsheet-presets"].some((prefix) => path === prefix || path.startsWith(`${prefix}/`)), evidence: "routeWorkforce" },
  { label: "team sheets", match: (path) => path === "/team-sheets" || path.startsWith("/team-sheets/"), evidence: "routeTeamSheets" },
  { label: "gift tracker", match: (path) => path === "/gift-tracker", evidence: "routeGiftTracker" },
  { label: "payouts", match: (path) => path.startsWith("/payouts/"), evidence: "routePayouts" },
  { label: "PYOS", match: (path) => path.startsWith("/pyos/"), evidence: "routePyos" },
  { label: "imports", match: (path) => path.startsWith("/imports/"), evidence: "routeImports" },
  { label: "POS", match: (path) => path.startsWith("/pos/"), evidence: "routePOSTerminal" },
  { label: "ingredient catalog", match: (path) => path === "/ingredient-catalog" || path.startsWith("/ingredient-catalog/"), evidence: "routeIngredientCatalog" },
  { label: "inventory", match: (path) => path.startsWith("/inventory/"), evidence: "routeInventoryDomain" },
];

const operations = Array.isArray(contract.operations) ? contract.operations : [];
const uncovered = operations.filter(({ path }) => !owners.some((owner) => owner.match(path)));
const missingDispatch = owners.filter((owner) => !workerSource.includes(owner.evidence));
const requiredAssetRoutes = ["/pos/*", "/employees*", "/team-sheets*", "/gift-tracker*", "/payouts*", "/pyos*", "/imports*", "/agm/*", "/inventory/*", "/ingredient-catalog*"];
const missingAssetRoutes = requiredAssetRoutes.filter((route) => !wranglerSource.includes(`"${route}"`));

if (uncovered.length > 0 || missingDispatch.length > 0 || missingAssetRoutes.length > 0) {
  if (uncovered.length > 0) console.error("Uncovered FastAPI operations:\n" + uncovered.map(({ method, path }) => `  ${method} ${path}`).join("\n"));
  if (missingDispatch.length > 0) console.error("Missing Worker dispatch evidence:\n" + missingDispatch.map(({ label }) => `  ${label}`).join("\n"));
  if (missingAssetRoutes.length > 0) console.error("Missing run_worker_first routes:\n" + missingAssetRoutes.map((route) => `  ${route}`).join("\n"));
  process.exit(1);
}

console.log(`Worker ownership covers all ${operations.length} FastAPI operations across ${owners.length} route groups.`);
