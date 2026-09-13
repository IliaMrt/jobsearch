import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { collectRemotive } from "./remotive.js";
import { CollectStats } from "../rate-limit.js";
import type { AppConfig } from "../types.js";
import { loadConfig } from "../io.js";

describe("collectRemotive error handling", () => {
  it("records 429 and continues without throwing", async () => {
    const cfg = loadConfig("config.yaml");
    cfg.collect.remotive = { enabled: true, searches: ["nodejs"] };

    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response("rate limited", { status: 429 });
    });

    try {
      const stats = new CollectStats();
      const jobs = await collectRemotive(cfg as AppConfig, stats);
      assert.equal(jobs.length, 0);
      assert.equal(stats.events.length, 1);
      assert.equal(stats.events[0]?.source, "remotive");
      assert.match(stats.events[0]?.message ?? "", /429/);
      assert.equal(stats.incomplete, true);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("returns [] when disabled", async () => {
    const cfg = loadConfig("config.yaml");
    cfg.collect.remotive = { enabled: false };
    const stats = new CollectStats();
    const jobs = await collectRemotive(cfg as AppConfig, stats);
    assert.deepEqual(jobs, []);
    assert.equal(stats.events.length, 0);
  });
});
