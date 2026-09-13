import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./filter.js";
import { loadConfig } from "./io.js";
import type { Job } from "./types.js";

const cfg = loadConfig("config.yaml");

function job(partial: Partial<Job>): Job {
  return {
    id: "test",
    source: "test",
    title: "Backend Developer Node.js",
    company: "Example GmbH",
    location: "Remote Germany",
    is_remote_flag: true,
    url: "https://example.com/jobs/1",
    description:
      "We are looking for a Backend Entwickler with Node.js and TypeScript. " +
      "100% remote within Germany. PostgreSQL, Docker. Festanstellung. m/w/d",
    date_posted: "",
    job_type: "",
    collected_at: new Date().toISOString(),
    ...partial,
  };
}

describe("evaluate", () => {
  it("keeps a clear remote Node/TS backend role", () => {
    const result = evaluate(job({}), cfg);
    assert.equal(result.rejected, false);
    assert.equal(result.work_track, "remote");
    assert.ok(result.score >= cfg.scoring.shortlist_min_score);
    assert.ok(result.matched_stack_groups.node || result.matched_stack_groups.typescript);
  });

  it("rejects frontend-only titles", () => {
    const result = evaluate(
      job({
        title: "Frontend Developer React",
        description: "React and CSS. Remote. TypeScript nice to have.",
      }),
      cfg,
    );
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.some((r) => r.includes("reject_title") || r.includes("no_node")));
  });

  it("rejects Lead/Staff titles hard", () => {
    const result = evaluate(
      job({ title: "Staff Backend Engineer Node.js" }),
      cfg,
    );
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes("reject_level:lead_staff_em"));
  });

  it("rejects empty company", () => {
    const result = evaluate(job({ company: "" }), cfg);
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes("reject:empty_company"));
  });
});
