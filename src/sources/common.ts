import { createHash } from "node:crypto";
import { norm } from "../textnorm.js";
import type { Job } from "../types.js";

export function jobId(
  source: string,
  title: string,
  company: string,
  url: string,
): string {
  const raw = `${source}|${norm(company)}|${norm(title)}|${url.split("?")[0]}`;
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

export function normalizeRow(
  row: Record<string, unknown>,
  source: string,
): Job {
  const title = String(row.title ?? row.job_title ?? "");
  const company = String(row.company ?? row.company_name ?? "");
  const rawLoc = row.location;
  const location = Array.isArray(rawLoc)
    ? rawLoc.map(String).join(", ")
    : String(rawLoc ?? "");

  const description = String(row.description ?? row.job_description ?? "");
  let url = String(
    row.job_url ?? row.url ?? row.job_url_direct ?? row.slug ?? "",
  );
  if (source === "arbeitnow" && url && !url.startsWith("http")) {
    url = `https://www.arbeitnow.com/jobs/${url}`;
  }

  let isRemote = Boolean(row.is_remote);
  if (!isRemote) {
    const blob = norm(`${title} ${location} ${description}`);
    isRemote = ["remote", "homeoffice", "work from home", "wfh"].some((s) =>
      blob.includes(s),
    );
  }

  return {
    id: jobId(source, title, company, url),
    source,
    title,
    company,
    location,
    is_remote_flag: isRemote,
    url: url ? url.split("?")[0]! : "",
    description,
    date_posted: String(row.date_posted ?? row.created_at ?? ""),
    job_type: String(row.job_type ?? ""),
    collected_at: new Date().toISOString(),
  };
}

/** EU / DACH / timezone signals used by Remotive & Jobicy. */
export function europeOrDeLocation(text: string): boolean {
  const t = norm(text);
  const keys = [
    "german",
    "germany",
    "deutschland",
    "austria",
    "österreich",
    "osterreich",
    "switzerland",
    "schweiz",
    "liechtenstein",
    "dach",
    "dach region",
    "europe",
    "europa",
    "eu",
    "emea",
    "worldwide",
    "world wide",
    "anywhere",
    "remote",
    "cet",
    "cest",
    "timezone: europe",
  ];
  return keys.some((k) => t.includes(k));
}
