import { join } from "node:path";
import type { AppConfig, Job } from "./types.js";
import { loadConfig, readJsonl, writeJson, writeJsonl } from "./io.js";
import { CollectStats } from "./rate-limit.js";
import { collectArbeitnow } from "./sources/arbeitnow.js";
import { collectJobsuche } from "./sources/jobsuche.js";
import { collectRemotive } from "./sources/remotive.js";
import { collectJobicy } from "./sources/jobicy.js";

type SourceFn = (cfg: AppConfig, stats: CollectStats) => Promise<Job[]>;

const SOURCES: [string, SourceFn][] = [
  ["arbeitnow", collectArbeitnow],
  ["jobsuche", collectJobsuche],
  ["remotive", collectRemotive],
  ["jobicy", collectJobicy],
];

function dedupe(jobs: Job[]): Job[] {
  const byId = new Map<string, Job>();
  for (const job of jobs) {
    const prev = byId.get(job.id);
    if (!prev) {
      byId.set(job.id, job);
      continue;
    }
    if ((job.description?.length ?? 0) > (prev.description?.length ?? 0)) {
      byId.set(job.id, job);
    }
  }
  return [...byId.values()];
}

export interface CollectOptions {
  merge?: boolean | null;
  onlySources?: Set<string> | null;
}

export async function runCollect(
  configPath: string,
  opts: CollectOptions = {},
): Promise<string> {
  const cfg = loadConfig(configPath);
  const doMerge =
    opts.merge == null
      ? Boolean(cfg.collect.merge_with_existing)
      : opts.merge;

  const stats = new CollectStats();
  const chunks: Job[][] = [];

  for (const [name, fn] of SOURCES) {
    if (opts.onlySources && !opts.onlySources.has(name)) {
      console.log(`=== source: ${name} SKIPPED (--sources) ===`);
      continue;
    }
    try {
      console.log(`=== source: ${name} ===`);
      chunks.push(await fn(cfg, stats));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.addEvent(name, "-", 1, `source failed: ${msg}`);
      console.log(`!! source ${name} failed: ${msg}`);
    }
  }

  const fresh = chunks.flat();
  const outDir = cfg.output.dir;
  const rawPath = join(outDir, cfg.output.raw);

  let jobs: Job[];
  if (doMerge) {
    const existing = readJsonl<Job>(rawPath);
    jobs = dedupe([...existing, ...fresh]);
    stats.notes.push(
      `merge: kept_existing=${existing.length} fresh=${fresh.length} merged=${jobs.length}`,
    );
    console.log(
      `[merge] existing=${existing.length} fresh=${fresh.length} merged=${jobs.length}`,
    );
  } else {
    jobs = dedupe(fresh);
  }

  const bySrc: Record<string, number> = {};
  for (const j of jobs) {
    const s = j.source || "?";
    bySrc[s] = (bySrc[s] ?? 0) + 1;
  }
  stats.notes.push(`by_source=${JSON.stringify(bySrc)}`);

  writeJsonl(rawPath, jobs);
  const statsPath = join(outDir, cfg.output.collect_stats ?? "collect_stats.json");
  writeJson(statsPath, stats.toJSON());

  console.log(`by_source: ${JSON.stringify(bySrc)}`);
  if (stats.incomplete || stats.events.length) {
    console.log(
      `WARNING: collect incomplete / rate-limited (${stats.events.length} events) -> ${statsPath}`,
    );
  }
  console.log(`collected=${jobs.length} -> ${rawPath}`);
  return rawPath;
}
