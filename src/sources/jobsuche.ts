import type { AppConfig, Job } from "../types.js";
import { CollectStats, sleepBackoff } from "../rate-limit.js";
import { sleep } from "../io.js";
import { norm } from "../textnorm.js";
import { normalizeRow } from "./common.js";

const BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
const API_KEY = "jobboerse-jobsuche";

function headers(): HeadersInit {
  return {
    "X-API-Key": API_KEY,
    Accept: "application/json",
    "User-Agent": "JobSearchTS/1.0 (personal job search)",
  };
}

function locText(item: Record<string, unknown>): string {
  const locs = (item.stellenlokationen as Record<string, unknown>[] | undefined) ?? [];
  const parts: string[] = [];
  for (const loc of locs) {
    const addr = (loc.adresse as Record<string, unknown> | undefined) ?? {};
    parts.push(
      [addr.ort, addr.region, addr.land].filter(Boolean).map(String).join(", "),
    );
  }
  return parts.filter(Boolean).join("; ");
}

async function getWith429(
  url: string,
  params: Record<string, string | number> | null,
  rl: Record<string, unknown>,
  stats: CollectStats,
  label: string,
): Promise<Response | null> {
  const maxRetries = Number(rl.max_retries_on_429 ?? 3);
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const full = new URL(url);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        full.searchParams.set(k, String(v));
      }
    }
    const r = await fetch(full, {
      headers: headers(),
      signal: AbortSignal.timeout(45_000),
    });
    if (r.status === 429) {
      stats.addEvent("jobsuche", label, attempt, "HTTP 429");
      if (attempt > maxRetries) return null;
      await sleepBackoff(attempt, {
        baseSeconds: Number(rl.backoff_base_sec ?? 20),
        maxSeconds: Number(rl.backoff_max_sec ?? 180),
      });
      continue;
    }
    if (r.status >= 400) {
      const body = await r.text();
      stats.addEvent(
        "jobsuche",
        label,
        attempt,
        `HTTP ${r.status}: ${body.slice(0, 120)}`,
      );
      return null;
    }
    return r;
  }
  return null;
}

export async function collectJobsuche(
  cfg: AppConfig,
  stats: CollectStats,
): Promise<Job[]> {
  const js = cfg.collect.jobsuche ?? {};
  if (js.enabled === false) return [];

  const queries = js.queries ?? [
    "Backend Node.js",
    "Backend TypeScript",
    "Backend Entwickler Node",
    "Softwareentwickler TypeScript",
  ];
  const pages = js.pages ?? 2;
  const size = js.size ?? 15;
  const fetchDetails = js.fetch_details !== false;
  const maxDetails = js.max_details ?? 80;
  const detailPause = js.detail_pause_sec ?? 0.2;
  const wo = js.location ?? "Deutschland";
  const pause = Math.min(
    3,
    (cfg.collect.rate_limit?.pause_between_queries_sec ?? 8) / 2,
  );
  const rl = cfg.collect.rate_limit ?? {};

  const out: Job[] = [];
  const seenRef = new Set<string>();
  let detailsFetched = 0;

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi]!;
    if (qi) await sleep(pause * 1000);
    console.log(`[jobsuche] query=${JSON.stringify(q)}`);

    for (let page = 1; page <= pages; page++) {
      const r = await getWith429(
        `${BASE}/pc/v6/jobs`,
        { was: q, wo, page, size, angebotsart: 1 },
        rl,
        stats,
        `${q}#p${page}`,
      );
      if (!r) break;

      const payload = (await r.json()) as {
        ergebnisliste?: Record<string, unknown>[];
        maxErgebnisse?: number;
      };
      const items = payload.ergebnisliste ?? [];
      if (!items.length) break;

      for (const item of items) {
        const ref = String(item.referenznummer ?? "");
        if (!ref || seenRef.has(ref)) continue;
        seenRef.add(ref);

        let title = String(item.stellenangebotsTitel ?? "");
        let company = String(item.firma ?? "");
        let location = locText(item);
        let description = "";
        const url = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${ref}`;

        if (fetchDetails && detailsFetched < maxDetails) {
          const enc = Buffer.from(ref, "utf8").toString("base64");
          await sleep(detailPause * 1000);
          const dr = await getWith429(
            `${BASE}/pc/v4/jobdetails/${enc}`,
            null,
            rl,
            stats,
            `detail:${ref}`,
          );
          detailsFetched += 1;
          if (dr) {
            const detail = (await dr.json()) as Record<string, unknown>;
            description = String(detail.stellenangebotsBeschreibung ?? "");
            title = String(detail.stellenangebotsTitel ?? title);
            company = String(detail.firma ?? company);
            if (detail.stellenlokationen) {
              location = locText(detail) || location;
            }
          }
        }

        const blob = norm(`${title} ${location} ${description}`);
        if (
          !["remote", "homeoffice", "home office", "mobil", "node", "typescript", "nestjs"].some(
            (k) => blob.includes(k),
          )
        ) {
          continue;
        }

        out.push(
          normalizeRow(
            {
              title,
              company,
              location: location || "Germany",
              description,
              url,
              date_posted: item.datumErsteVeroeffentlichung ?? "",
              is_remote: ["remote", "homeoffice", "home office"].some((k) =>
                blob.includes(k),
              ),
            },
            "jobsuche",
          ),
        );
      }

      console.log(
        `  page=${page} got=${items.length} total_kept=${out.length} ` +
          `details=${detailsFetched}/${maxDetails} max=${payload.maxErgebnisse ?? "?"}`,
      );
      if (page * size >= Number(payload.maxErgebnisse ?? 0)) break;
    }
    stats.addRun({ source: "jobsuche", query: q, rows: out.length });
  }

  stats.notes.push(
    `jobsuche kept=${out.length} refs=${seenRef.size} details=${detailsFetched}`,
  );
  return out;
}
