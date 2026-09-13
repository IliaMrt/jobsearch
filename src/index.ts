#!/usr/bin/env node
/**
 * CLI: collect → filter/score → optional AI review (OpenRouter).
 *
 * Usage:
 *   npm start
 *   npm start -- --skip-collect
 *   npm start -- --merge --sources arbeitnow,jobsuche,remotive,jobicy
 *   npm start -- --ai
 *   npm start -- --ai-only
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./io.js";
import { runCollect } from "./collect.js";
import { runFilter } from "./filter.js";
import { runAiReview } from "./ai-review.js";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "config.yaml" },
      "skip-collect": { type: "boolean", default: false },
      merge: { type: "boolean", default: false },
      sources: { type: "string", default: "" },
      ai: { type: "boolean", default: false },
      "ai-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`JobSearch TS — DE remote Node/TypeScript backend pipeline

Options:
  --config <path>   Config file (default: config.yaml)
  --skip-collect    Reuse output/raw_jobs.jsonl; only filter (+ optional --ai)
  --merge           Union this collect with existing raw_jobs.jsonl (by id)
  --sources <list>  Comma-separated: arbeitnow,jobsuche,remotive,jobicy
  --ai              After filter: OpenRouter AI review (needs OPENROUTER_API_KEY)
  --ai-only         Only AI review on existing filtered_jobs.jsonl
  -h, --help        Show this help
`);
    return 0;
  }

  const configPath = values.config!;

  if (values["ai-only"]) {
    await runAiReview(configPath);
    return 0;
  }

  if (!values["skip-collect"]) {
    let only: Set<string> | null = null;
    const src = values.sources?.trim() ?? "";
    if (src) {
      only = new Set(
        src
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    await runCollect(configPath, {
      merge: values.merge ? true : null,
      onlySources: only,
    });
  }

  runFilter(configPath);

  if (values.ai) {
    await runAiReview(configPath);
  }

  const cfg = loadConfig(configPath);
  const statsPath = join(
    cfg.output.dir,
    cfg.output.collect_stats ?? "collect_stats.json",
  );
  if (existsSync(statsPath) && !values["skip-collect"]) {
    const stats = JSON.parse(readFileSync(statsPath, "utf8")) as {
      incomplete?: boolean;
      rate_limit_events?: unknown[];
    };
    if (stats.incomplete || (stats.rate_limit_events?.length ?? 0) > 0) {
      console.error(
        `exit=2 (incomplete collect, see ${statsPath} and report.md)`,
      );
      return 2;
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
