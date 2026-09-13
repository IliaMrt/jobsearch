import type { AppConfig, Job } from "../types.js";
import type { CollectStats } from "../rate-limit.js";
import { europeOrDeLocation, normalizeRow } from "./common.js";
import { norm } from "../textnorm.js";

export async function collectJobicy(
  cfg: AppConfig,
  stats: CollectStats,
): Promise<Job[]> {
  const ji = cfg.collect.jobicy ?? {};
  if (ji.enabled === false) return [];

  const tags = ji.tags ?? ["nodejs", "typescript", "backend"];
  const count = ji.count ?? 50;
  const out: Job[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    console.log(`[jobicy] tag=${JSON.stringify(tag)}`);
    const url = new URL("https://jobicy.com/api/v2/remote-jobs");
    url.searchParams.set("count", String(count));
    url.searchParams.set("tag", tag);

    const r = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    if (r.status === 429) {
      stats.addEvent("jobicy", tag, 1, "HTTP 429");
      continue;
    }
    if (!r.ok) throw new Error(`jobicy HTTP ${r.status}`);

    const payload = (await r.json()) as { jobs?: Record<string, unknown>[] };
    const jobs = payload.jobs ?? [];
    let kept = 0;

    for (const job of jobs) {
      const title = String(job.jobTitle ?? "");
      const geo = String(job.jobGeo ?? "");
      const desc = String(job.jobDescription ?? "");
      const blob = norm(`${title} ${geo} ${desc}`);

      if (!europeOrDeLocation(`${geo} ${title}`)) {
        if (!blob.includes("germany") && !blob.includes("deutschland")) continue;
      }
      if (!["node", "nodejs", "typescript", "nestjs"].some((k) => blob.includes(k))) {
        continue;
      }

      const jobUrl = String(job.url ?? "");
      if (!jobUrl || seen.has(jobUrl)) continue;
      seen.add(jobUrl);

      const jobType = job.jobType;
      out.push(
        normalizeRow(
          {
            title,
            company: job.companyName ?? "",
            location: geo || "Remote",
            description: desc,
            url: jobUrl,
            date_posted: job.pubDate ?? "",
            job_type: Array.isArray(jobType)
              ? jobType.map(String).join(",")
              : String(jobType ?? ""),
            is_remote: true,
          },
          "jobicy",
        ),
      );
      kept += 1;
    }
    console.log(`  -> api=${jobs.length} kept=${kept}`);
    stats.addRun({ source: "jobicy", query: tag, rows: kept });
  }
  return out;
}
