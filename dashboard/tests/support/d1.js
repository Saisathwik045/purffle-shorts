import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
export class D1 {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    for (const file of readdirSync(new URL("../../drizzle/", import.meta.url))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      this.db.exec(
        readFileSync(new URL("../../drizzle/" + file, import.meta.url), "utf8"),
      );
  }
  prepare(sql) {
    const db = this.db;
    return {
      bind(...args) {
        return {
          async first() {
            return db.prepare(sql).get(...args) || null;
          },
          async all() {
            return { results: db.prepare(sql).all(...args) };
          },
          async run() {
            return db.prepare(sql).run(...args);
          },
          _run() {
            return db.prepare(sql).all(...args);
          },
        };
      },
    };
  }
  async batch(items) {
    this.db.exec("BEGIN");
    try {
      const out = items.map((x) => x._run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
