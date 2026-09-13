import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { norm, jobBlob } from "./textnorm.js";

describe("norm", () => {
  it("collapses Node/Nest/TS spellings", () => {
    assert.equal(norm("Node.js and Nest.js"), "nodejs and nestjs");
    assert.equal(norm("Type Script / type-script"), "typescript / typescript");
    assert.equal(norm("full-stack Front End"), "fullstack frontend");
  });

  it("handles empty input", () => {
    assert.equal(norm(null), "");
    assert.equal(norm(undefined), "");
    assert.equal(norm(""), "");
  });
});

describe("jobBlob", () => {
  it("joins and normalizes fields", () => {
    const blob = jobBlob({
      title: "Backend Node.js",
      location: "Remote Germany",
      description: "We use Nest.js",
      job_type: "full-time",
    });
    assert.match(blob, /nodejs/);
    assert.match(blob, /nestjs/);
    assert.match(blob, /germany/);
  });
});
