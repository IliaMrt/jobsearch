import type { AppConfig, Job } from "../types.js";
import type { CollectStats } from "../rate-limit.js";
import { europeOrDeLocation, normalizeRow } from "./common.js";
import { norm } from "../textnorm.js";

export async function collectRemotive(
  cfg: AppConfig,
  stats: CollectStats,
): Promise<Job[]> {
  const rm = cfg.collect.remotive ?? {};
  if (rm.enabled === false) return [];

  const searches = rm.searches ?? ["nodejs", "typescript", "backend"];
  const out: Job[] = [];
  const seen = new Set<string>();

  for (const q of searches) {
    console.log(`[remotive] search=${JSON.stringify(q)}`);
    const url = new URL("https://remotive.com/api/remote-jobs");
    url.searchParams.set("category", "software-dev");
    url.searchParams.set("search", q);

    const r = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    if (r.status === 429) {
      stats.addEvent("remotive", q, 1, "HTTP 429");
      continue;
    }
    if (!r.ok) throw new Error(`remotive HTTP ${r.status}`);

    const payload = (await r.json()) as { jobs?: Record<string, unknown>[] };
    const jobs = payload.jobs ?? [];
    let kept = 0;

    for (const job of jobs) {
      const loc = String(job.candidate_required_location ?? "");
      const title = String(job.title ?? "");
      const desc = String(job.description ?? "");
      const blob = norm(`${title} ${loc} ${desc}`);

      if (!europeOrDeLocation(`${loc} ${title}`)) {
        if (!blob.includes("germany") && !blob.includes("deutschland")) continue;
      }
      if (!["node", "nodejs", "typescript", "nestjs"].some((k) => blob.includes(k))) {
        continue;
      }

      const jobUrl = String(job.url ?? "");
      if (!jobUrl || seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      out.push(
        normalizeRow(
          {
            title,
            company: job.company_name ?? "",
            location: loc || "Remote",
            description: desc,
            url: jobUrl,
            date_posted: job.publication_date ?? "",
            job_type: job.job_type ?? "",
            is_remote: true,
          },
          "remotive",
        ),
      );
      kept += 1;
    }
    console.log(`  -> api=${jobs.length} kept=${kept}`);
    stats.addRun({ source: "remotive", query: q, rows: kept });
  }
  return out;
}
