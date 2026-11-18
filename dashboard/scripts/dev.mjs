import { spawnSync, spawn } from "node:child_process";
const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
});
if (build.status) process.exit(build.status);
const config = "wrangler.jsonc";
const migration = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    config,
  ],
  { stdio: "inherit" },
);
if (migration.status) process.exit(migration.status);
const port = process.argv.includes("--port")
  ? process.argv[process.argv.indexOf("--port") + 1]
  : "4173";
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--ip",
    "0.0.0.0",
    "--port",
    port,
    "--config",
    config,
  ],
  { stdio: "inherit" },
);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code || 0));
