import { describe, expect, it } from "vitest";

import { buildClickhouseDeleteSql } from "../reset.js";

describe("buildClickhouseDeleteSql", () => {
  it("scopes the predicate to the given seed-prefixed project ids", () => {
    const { sql, params } = buildClickhouseDeleteSql("traces", [
      "seed-prj-checkout",
      "seed-prj-search",
    ]);
    expect(sql).toContain("ALTER TABLE traces DELETE");
    expect(sql).toContain("project_id IN ({p0:String}, {p1:String})");
    // No spurious trace_id predicate — deterministic seed trace IDs are pure
    // 32-hex strings, not "seed-" prefixed; relying on project_id is correct.
    expect(sql).not.toContain("startsWith(trace_id");
    expect(params.p0).toBe("seed-prj-checkout");
    expect(params.p1).toBe("seed-prj-search");
  });

  it("works for the spans table too", () => {
    const { sql } = buildClickhouseDeleteSql("spans", ["seed-prj-x"]);
    expect(sql.startsWith("ALTER TABLE spans DELETE")).toBe(true);
  });

  it("refuses to issue an empty DELETE", () => {
    expect(() => buildClickhouseDeleteSql("traces", [])).toThrow();
  });
});
