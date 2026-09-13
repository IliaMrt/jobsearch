import type { AppConfig, Job } from "../types.js";
import { CollectStats, resolveRateLimit, sleepBackoff } from "../rate-limit.js";
import { sleep } from "../io.js";
import { norm } from "../textnorm.js";
import { normalizeRow } from "./common.js";

function locationText(item: Record<string, unknown>): string {
  const loc = item.location;
  if (Array.isArray(loc)) return loc.map(String).join(" ");
  return String(loc ?? "");
}

async function arbeitnowGet(
  params: Record<string, string | number>,
  rl: ReturnType<typeof resolveRateLimit>,
  stats: CollectStats,
  query: string,
): Promise<Response | null> {
  const maxRetries = rl.max_retries_on_429;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const url = new URL("https://www.arbeitnow.com/api/job-board-api");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (r.status === 429) {
      const retryAfter = r.headers.get("Retry-After");
      stats.addEvent(
        "arbeitnow",
        query,
        attempt,
        `HTTP 429 Retry-After=${retryAfter ?? "n/a"}`,
      );
      if (attempt > maxRetries) return null;
      if (retryAfter && /^\d+$/.test(retryAfter)) {
        const wait = Math.min(rl.backoff_max_sec, Number(retryAfter));
        console.log(`  .. arbeitnow 429, sleep Retry-After=${wait}s`);
        await sleep(wait * 1000);
      } else {
        const waited = await sleepBackoff(attempt, {
          baseSeconds: rl.backoff_base_sec,
          maxSeconds: rl.backoff_max_sec,
        });
        console.log(`  .. arbeitnow 429, backoff ${waited.toFixed(1)}s`);
      }
      continue;
    }
    if (!r.ok) throw new Error(`arbeitnow HTTP ${r.status}`);
    return r;
  }
  return null;
}

export async function collectArbeitnow(
  cfg: AppConfig,
  stats: CollectStats,
): Promise<Job[]> {
  if (!cfg.collect.arbeitnow) return [];

  const rl = resolveRateLimit(cfg.collect.rate_limit);
  const queries = cfg.collect.arbeitnow_queries ?? ["nodejs", "typescript"];
  const maxPages = cfg.collect.arbeitnow_max_pages ?? 2;
  const maxTotal = cfg.collect.arbeitnow_max_jobs ?? 150;
  const out: Job[] = [];
  const seen = new Set<string>();
  const pagePause = rl.pause_between_arbeitnow_pages_sec;

  for (let qi = 0; qi < queries.length; qi++) {
    if (out.length >= maxTotal) break;
    const q = queries[qi]!;
    if (qi > 0) await sleep(Math.min(2000, (rl.pause_between_queries_sec / 2) * 1000));

    let page = 1;
    console.log(`[arbeitnow] query=${JSON.stringify(q)}`);
    while (page <= maxPages) {
      if (out.length >= maxTotal) break;
      if (page > 1) await sleep(pagePause * 1000);

      const r = await arbeitnowGet(
        { search: q, page },
        rl,
        stats,
        `${q}#p${page}`,
      );
      if (!r) {
        stats.notes.push(`arbeitnow aborted on 429 for ${JSON.stringify(q)} page=${page}`);
        break;
      }

      const payload = (await r.json()) as {
        data?: Record<string, unknown>[];
        links?: { next?: string | null };
      };
      const data = payload.data ?? [];
      if (!data.length) break;

      for (const item of data) {
        if (out.length >= maxTotal) break;
        const loc = norm(locationText(item));
        const blob = norm(
          `${item.title ?? ""} ${item.description ?? ""} ${loc}`,
        );
        const ok =
          loc.includes("german") ||
          loc.includes("germany") ||
          loc.includes("deutschland") ||
          blob.includes("germany") ||
          blob.includes("deutschland") ||
          item.remote === true;
        if (!ok) continue;

        const row = normalizeRow(item, "arbeitnow");
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row);
      }

      if (!payload.links?.next) break;
      page += 1;
    }
    console.log(`  -> unique so far ${out.length}`);
    stats.addRun({ source: "arbeitnow", query: q, rows: out.length, page_last: page });
  }
  return out;
}
