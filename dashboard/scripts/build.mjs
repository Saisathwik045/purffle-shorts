import { build } from "esbuild";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
await mkdir("dist/server", { recursive: true });
const html = await readFile("public/index.html", "utf8");
const css = await readFile("public/app.css", "utf8");
const js = await readFile("public/app.js", "utf8");
await build({
  entryPoints: ["worker/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/server/index.js",
  define: {
    __HTML__: JSON.stringify(html),
    __CSS__: JSON.stringify(css),
    __JS__: JSON.stringify(js),
  },
});
await mkdir("dist/.openai", { recursive: true });
await cp(".openai/hosting.json", "dist/.openai/hosting.json");
await cp("migrations", "dist/migrations", { recursive: true });
await cp("drizzle", "dist/drizzle", { recursive: true });
// The build manifest contains schema migrations for the hosted D1 database.
await writeFile(
  "dist/server/wrangler.json",
  JSON.stringify(
    {
      name: "purffle-cloud-dashboard",
      main: "index.js",
      compatibility_date: "2026-11-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "purffle-dashboard",
          database_id: "provisioned-by-sites",
          migrations_dir: "../migrations",
        },
      ],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "purffle-clips" }],
    },
    null,
    2,
  ),
);
console.log("Built private dashboard Worker and D1 migrations");
