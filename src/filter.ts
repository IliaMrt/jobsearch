/**
 * Rule filter + heuristic scoring for junior–mid Node/TypeScript backend roles.
 * Hybrid / offline tracks use geo radius from config; remote is the default track.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, EvaluatedJob, Job, WorkTrack } from "./types.js";
import { loadConfig, writeJson, writeJsonl } from "./io.js";
import { jobBlob, norm } from "./textnorm.js";
import { resolveOffice } from "./geo.js";

function hits(blob: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) {
    const nn = norm(n);
    if (nn && blob.includes(nn)) found.push(n);
  }
  return found;
}

function groupHits(
  blob: string,
  groups: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, terms] of Object.entries(groups)) {
    out[name] = hits(blob, terms);
  }
  return out;
}

const TITLE_HARD_LEVEL =
  /\b(staff|principal|lead|leiter|head of|engineering manager|tech lead|technical lead|direktor|director)\b/i;
const TITLE_SENIOR = /\bsenior\b/i;
const STUDENT =
  /\b(werkstudent|working student|intern\b|internship|praktikum|trainee)\b/i;
const WRONG_STACK_TITLE =
  /(?:^|[\s/|(])(java(?!\s*script)|python|golang|(?<![a-z])go(?![a-z])|kotlin|c#|\.net|php|ruby|rails)(?:$|[\s/|),])/i;
const YEARS = /(\d+)\s*\+?\s*(?:years?|jahre)/gi;
const HARD_DEGREE =
  /(?:abgeschlossenes?\s+studium|bachelor.?s?\s+or\s+master.?s?\s+degree|university degree|hochschulabschluss|studium der informatik|completed degree)/i;
const DEGREE_ALT =
  /(?:oder\s+(?:eine\s+)?vergleichbare|or\s+equivalent|equivalent\s+(?:professional\s+)?experience|praktischer?\s+erfahrung|oder\s+eine\s+ausbildung|studium\s+oder\s+eine\s+ausbildung|or\s+comparable)/i;
const SOFT_OFFICE =
  /(?:homeoffice[-\s]?tage|home office days|büro in (?:der\s+)?(?:berlin|münchen|munich|hamburg|köln|cologne)|(?:berlin|münchen|munich|hamburg|köln|cologne)\s+office|based in our .{0,40}office|role is based in|we work together in person|in person\.|einmal (?:die|pro) woche|tage (?:pro woche )?im (?:büro|office)|begegnungen im büro|office als anker|vor ort bei|on[-\s]?site (?:at )?client|customer(?:'s)? office|regular travel|reisen zu kunden|kommandoierung|dienstreise)/i;
const ANTI_REMOTE =
  /(?:isn.?t remote|is not remote|not remote|no remote|kein remote|nicht remote|ohne remote|do not apply if you want a remote|please do not apply if you want a remote|remote (?:work |position )?is not (?:possible|available|an option)|no remote work|remote work not|onsite only|on[-\s]?site only|office[-\s]?only|ausschließlich (?:im )?büro|nur im büro|rein vor ort)/i;
const FORWARD_DEPLOYED = /\bforward[-\s]?deployed\b|\bforward deployed\b/i;
const HARD_GERMAN =
  /(?:german|deutsch)(?:kenntnisse)?[^.]{0,40}\b(?:c1|c2)\b|\b(?:c1|c2)\b[^.]{0,40}(?:german|deutsch)|verhandlungssicheres?\s+deutsch|deutsch\s+verhandlungssicher|deutsch auf (?:muttersprachen?niveau|c1|c2)/i;
const REMOTE_POSITIVE =
  /(?:100%\s*remote|fully remote|full remote|remote[-\s]?first|deutschlandweit remote|vollständig remote|voll remote|remote[-\s]?only|arbeiten von überall|remote within (?:germany|europe|eu)|work remotely|remote work (?:possible|erlaubt|möglich)|homeoffice 100|home office 100)/i;

function badUrl(url: string, company: string): string | null {
  const u = (url || "").trim();
  const c = String(company || "").trim().toLowerCase();
  if (!u || u === "nan" || u === "none") return "reject:empty_url";
  if (!c || c === "nan" || c === "none" || c === "null") return "reject:empty_company";
  return null;
}

function maxYearsRequired(blob: string): number {
  const nums: number[] = [];
  for (const m of blob.matchAll(YEARS)) nums.push(Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

function backendHeavyFullstack(
  title: string,
  titleRaw: string,
  blob: string,
): boolean {
  if (
    /\bfrontend\b|\bfront-end\b|\bfront end\b/.test(title) &&
    !/\bbackend\b|\bback-end\b/.test(title)
  ) {
    return false;
  }
  const head = titleRaw + " " + blob.slice(0, 2500);
  const hasNodeTs = /node\.?js|nodejs|typescript|nestjs|\bnode\b/i.test(head);
  if (!hasNodeTs) return false;
  const hasBe = /\bbackend\b|\bback-end\b|\bapi\b|\bnest\.?js\b|microservices?/i.test(
    head,
  );
  const hasFe = /\breact\b|\bvue\b|\bangular\b|\bnext\.?js\b/i.test(blob.slice(0, 2500));
  return hasBe || hasFe;
}

export function evaluate(job: Job, cfg: AppConfig): EvaluatedJob {
  const filters = cfg.filters;
  const scoring = cfg.scoring;
  const blob = jobBlob(job);
  const titleRaw = String(job.title || "");
  const title = norm(titleRaw);
  const url = String(job.url || "");
  const company = String(job.company || "");

  const reasons: string[] = [];
  let softFlags: string[] = [];
  let rejected = false;
  let officeCity: string | null = null;
  let officeDistanceKm: number | null = null;
  let workTrack: WorkTrack | null = null;

  const office = resolveOffice(job, blob, cfg);
  const withinHybrid = office.within_hybrid;
  const withinOffline = office.within_offline;
  const nearCity = office.city;
  const nearKm = office.km;

  const urlBad = badUrl(url, company);
  if (urlBad) {
    rejected = true;
    reasons.push(urlBad);
  }

  if (TITLE_HARD_LEVEL.test(titleRaw) || TITLE_HARD_LEVEL.test(title)) {
    rejected = true;
    reasons.push("reject_level:lead_staff_em");
  } else if (TITLE_SENIOR.test(titleRaw) || TITLE_SENIOR.test(title)) {
    softFlags.push("senior_title");
    reasons.push("soft:senior_title");
  }

  if (STUDENT.test(titleRaw) || STUDENT.test(blob.slice(0, 800))) {
    rejected = true;
    reasons.push("reject:student_intern");
  }

  if (WRONG_STACK_TITLE.test(titleRaw)) {
    if (!/node|typescript|nestjs/i.test(title)) {
      rejected = true;
      reasons.push("reject_title_stack");
    } else if (/\bjava\b/i.test(title) && !title.includes("javascript")) {
      rejected = true;
      reasons.push("reject_title_java_primary");
    }
  }

  const groups = groupHits(blob, filters.require_stack_groups);
  const stackOk = Object.values(groups).some((v) => v.length > 0);

  const frontendTitle = hits(title, ["frontend", "front-end", "front end"]);
  const fullstackTitle = hits(title, ["fullstack", "full-stack", "full stack"]);
  if (frontendTitle.length && !/\bbackend\b|\bback-end\b/.test(title)) {
    rejected = true;
    reasons.push(`reject_title:${frontendTitle.join(",")}`);
  } else if (fullstackTitle.length) {
    if (backendHeavyFullstack(title, titleRaw, blob)) {
      softFlags.push("fullstack_backend_heavy");
      reasons.push("soft:fullstack_backend_heavy");
    } else {
      rejected = true;
      reasons.push(`reject_title:${fullstackTitle.join(",")}`);
    }
  }

  const rejectHits = hits(blob, filters.reject_any);
  if (rejectHits.length && !frontendTitle.length) {
    const hardKeys: string[] = [];
    for (const h of rejectHits) {
      const nh = norm(h);
      if (nh.includes("english") || nh.includes("englisch")) {
        softFlags.push(`lang:${h}`);
        continue;
      }
      if (nh.includes("hybrid") || nh.includes("hybride") || nh.includes("teilhybrid")) {
        if (withinHybrid) {
          softFlags.push("hybrid_within_radius");
          reasons.push("soft:hybrid_within_radius");
          officeCity = nearCity;
          officeDistanceKm = nearKm;
        } else {
          hardKeys.push(h);
        }
        continue;
      }
      if (
        [
          "freelance",
          "freiberufl",
          "contractor",
          "relocation",
          "büro",
          "office",
          "days in the office",
          "tage im",
          "on-site",
        ].some((k) => nh.includes(k))
      ) {
        if (withinOffline) {
          softFlags.push("offline_within_radius");
          officeCity = nearCity;
          officeDistanceKm = nearKm;
          continue;
        }
        hardKeys.push(h);
      }
    }
    if (hardKeys.length) {
      rejected = true;
      reasons.push(`reject:${hardKeys.slice(0, 6).join(",")}`);
    } else if (rejectHits.some((h) => norm(h).includes("full") || norm(h).includes("front"))) {
      if (
        /\bfrontend\b.{0,40}\b(engineer|developer|entwickler)\b/.test(blob) &&
        !/\bbackend\b/.test(title)
      ) {
        rejected = true;
        reasons.push("reject_role_desc");
      } else if (/\bfullstack\b.{0,40}\b(engineer|developer|entwickler)\b/.test(blob)) {
        if (backendHeavyFullstack(title, titleRaw, blob)) {
          if (!softFlags.includes("fullstack_backend_heavy")) {
            softFlags.push("fullstack_backend_heavy");
            reasons.push("soft:fullstack_backend_heavy");
          }
        } else {
          rejected = true;
          reasons.push("reject_role_desc");
        }
      }
    }
  }

  const freelanceHits = hits(blob, filters.reject_freelance_signals ?? []);
  if (freelanceHits.length && cfg.profile.employment === "festanstellung") {
    rejected = true;
    reasons.push(`reject_freelance:${freelanceHits.slice(0, 4).join(",")}`);
  }

  if (HARD_DEGREE.test(blob) && !DEGREE_ALT.test(blob)) {
    const ctxOk =
      /(?:advantage|plus|nice to have|wünschenswert|von vorteil|idealerweise).{0,40}(?:degree|studium|bachelor|master)|(?:degree|studium|bachelor|master).{0,40}(?:advantage|plus|nice to have|wünschenswert|von vorteil)/i.test(
        blob,
      );
    if (!ctxOk) {
      rejected = true;
      reasons.push("reject:hard_degree_no_alt");
    }
  }

  if (SOFT_OFFICE.test(blob) || SOFT_OFFICE.test(titleRaw)) {
    if (withinHybrid) {
      softFlags.push("hybrid_within_radius");
      reasons.push("soft:soft_office_within_radius");
      officeCity = nearCity;
      officeDistanceKm = nearKm;
    } else if (withinOffline) {
      softFlags.push("offline_within_radius");
      reasons.push("soft:soft_office_offline");
      officeCity = nearCity;
      officeDistanceKm = nearKm;
    } else {
      rejected = true;
      reasons.push("reject:soft_office_not_full_remote");
    }
  }

  if (FORWARD_DEPLOYED.test(titleRaw) || FORWARD_DEPLOYED.test(blob.slice(0, 600))) {
    rejected = true;
    reasons.push("reject:forward_deployed");
  }

  if (HARD_GERMAN.test(blob)) {
    rejected = true;
    reasons.push("reject:german_c1_plus");
  }

  if (!stackOk) {
    rejected = true;
    reasons.push("reject:no_node_or_ts");
  }

  let remoteHits: string[] = [];
  const anti = ANTI_REMOTE.test(blob) || ANTI_REMOTE.test(titleRaw);
  let remoteOk = false;

  if (anti && !withinOffline) {
    rejected = true;
    reasons.push("reject:anti_remote");
  } else {
    if (anti && withinOffline) {
      softFlags.push("offline_anti_remote_ok");
      officeCity = officeCity ?? nearCity;
      officeDistanceKm = officeDistanceKm ?? nearKm;
    }
    if (REMOTE_POSITIVE.test(blob)) remoteHits.push("remote_positive");
    for (const m of blob.matchAll(/\bremote\b/g)) {
      const start = Math.max(0, m.index! - 24);
      const window = blob.slice(start, m.index! + m[0].length + 8);
      if (
        /(?:isn.?t|is not|not|no|kein|ohne|nicht)\s+remote|remote\s+(?:discovery|session|desktop|support)/.test(
          window,
        )
      ) {
        continue;
      }
      remoteHits.push("remote");
      break;
    }
    for (const h of hits(blob, filters.require_remote_signals)) {
      if (norm(h) === "remote" && !remoteHits.includes("remote")) continue;
      if (norm(h) !== "remote") remoteHits.push(h);
    }
    remoteOk = remoteHits.length > 0;
    if (!remoteOk && job.is_remote_flag && blob.length < 200) {
      remoteOk = true;
      remoteHits = ["flag_only_short_desc"];
    }

    if (softFlags.includes("hybrid_within_radius")) {
      workTrack = "hybrid";
      remoteOk = true;
      remoteHits = [...remoteHits, "hybrid_within_radius"];
    } else if (withinOffline && !remoteHits.includes("remote_positive")) {
      workTrack = "offline";
      softFlags.push("offline_within_radius");
      reasons.push("soft:offline_within_radius");
      officeCity = officeCity ?? nearCity;
      officeDistanceKm = officeDistanceKm ?? nearKm;
      remoteOk = true;
      remoteHits = [...remoteHits, "offline_within_radius"];
    } else if (remoteOk) {
      workTrack = "remote";
    } else if (withinOffline) {
      workTrack = "offline";
      softFlags.push("offline_within_radius");
      reasons.push("soft:offline_within_radius");
      officeCity = officeCity ?? nearCity;
      officeDistanceKm = officeDistanceKm ?? nearKm;
      remoteOk = true;
      remoteHits = [...remoteHits, "offline_within_radius"];
    } else {
      rejected = true;
      reasons.push("reject:no_remote");
      workTrack = null;
    }
  }

  const maxYears = maxYearsRequired(blob);
  const maxOk = filters.max_years_hard ?? 4;
  if (
    maxYears >= 5 &&
    new RegExp(
      `(?:mindestens|at least|min\\.?|minimum|über|more than).{0,12}${maxYears}|(?:${maxYears})\\s*\\+\\s*(?:years|jahre)`,
      "i",
    ).test(blob)
  ) {
    rejected = true;
    reasons.push(`reject:years>=${maxYears}`);
  } else if (maxYears > maxOk) {
    softFlags.push(`years:${maxYears}`);
  }

  // Scoring
  let score = 0;
  const preferHits = hits(blob, filters.prefer_any);
  score += (scoring.weights.prefer_hit ?? 0) * Math.min(preferHits.length, 3);

  if (groups.node?.length && groups.typescript?.length) {
    score += scoring.weights.both_node_and_ts ?? 0;
    reasons.push("node+ts");
  } else if (groups.node?.length || groups.typescript?.length) {
    score += 4;
    reasons.push("partial_stack");
  }

  const nestHits = hits(blob, scoring.nest_signals ?? []);
  if (nestHits.length) score += scoring.weights.nest_bonus ?? 0;

  const sqlHits = hits(blob, scoring.sql_signals);
  if (sqlHits.length) score += scoring.weights.sql_bonus ?? 0;
  const chHits = hits(blob, scoring.clickhouse_signals);
  if (chHits.length) score += scoring.weights.clickhouse_bonus ?? 0;
  const rqHits = hits(blob, scoring.rabbitmq_signals ?? []);
  if (rqHits.length) score += scoring.weights.rabbitmq_bonus ?? 0;
  const dockerHits = hits(blob, scoring.docker_signals ?? []);
  if (dockerHits.length) score += scoring.weights.docker_bonus ?? 0;

  const deHits = hits(blob, scoring.german_signals);
  if (deHits.length) score += scoring.weights.german_jd_bonus ?? 0;

  if (title.includes("backend")) {
    score += scoring.weights.title_backend_bonus ?? 0;
    reasons.push("title_backend");
  }

  if (/\b(junior|mid[-\s]?level|middle)\b/i.test(titleRaw)) {
    score += scoring.weights.junior_mid_bonus ?? 6;
    reasons.push("title_junior_mid");
  }

  let softHits = hits(blob, filters.soft_reject_any ?? []);
  if (
    (blob.includes("fließend") || blob.includes("fliessend")) &&
    blob.includes("englisch")
  ) {
    softHits = [...new Set([...softHits, "fluent_de_en"])];
  }
  if (softHits.length) {
    score += scoring.weights.soft_reject_penalty ?? 0;
    softFlags.push(...softHits.slice(0, 6));
    reasons.push(`soft:${softHits.slice(0, 4).join(",")}`);
  }

  if (
    /(?:3\+|mehrjährige|jahre).{0,40}(?:ruby|rails)|(?:ruby on rails|rails).{0,40}(?:must|pflicht|erfahrung)/i.test(
      blob,
    ) &&
    !title.includes("nodejs")
  ) {
    if (/erste erfahrung mit node/i.test(blob) || /3\+.{0,20}rails/i.test(blob)) {
      rejected = true;
      reasons.push("reject:rails_primary");
    }
  }

  if (title.includes("softwareentwickler") && blob.includes("java") && !blob.includes("nodejs")) {
    rejected = true;
    reasons.push("reject:java_shop");
  }
  if (
    blob.includes("java") &&
    (blob.includes("spring") || blob.includes("angular")) &&
    !blob.includes("nodejs") &&
    !blob.includes("nestjs")
  ) {
    rejected = true;
    reasons.push("reject:java_spring_no_node");
  }

  if (softFlags.some((f) => f.startsWith("years:"))) {
    score += scoring.weights.senior_years_penalty ?? -6;
  }
  if (softFlags.includes("senior_title")) {
    score += scoring.weights.senior_title_penalty ?? -4;
  }
  if (softFlags.includes("fullstack_backend_heavy")) {
    score += scoring.weights.fullstack_soft_penalty ?? -3;
  }
  if (softFlags.includes("hybrid_within_radius")) {
    score += scoring.weights.hybrid_ok_city_penalty ?? -4;
  }
  if (workTrack === "offline") {
    score += scoring.weights.offline_local_bonus ?? 4;
  }

  if (job.is_remote_flag && !remoteHits.length) {
    score += scoring.weights.missing_remote_explicit ?? 0;
  }

  if (nestHits.length && !reasons.join(",").includes("nest")) {
    reasons.push("nest");
  }

  if (HARD_DEGREE.test(blob) && DEGREE_ALT.test(blob)) {
    softFlags.push("degree_or_experience");
    reasons.push("degree_alt_ok");
  }

  softFlags = [...new Set(softFlags)];
  if (workTrack === null && !rejected) workTrack = "remote";

  return {
    ...job,
    rejected,
    score,
    reasons,
    matched_stack_groups: Object.fromEntries(
      Object.entries(groups).filter(([, v]) => v.length),
    ),
    matched_prefer: preferHits,
    matched_remote: remoteHits,
    matched_sql: sqlHits,
    matched_clickhouse: chHits,
    matched_nest: nestHits,
    matched_german: deHits,
    soft_flags: softFlags,
    max_years_detected: maxYears,
    work_track: workTrack,
    hybrid_track: workTrack === "hybrid",
    offline_track: workTrack === "offline",
    office_city: officeCity,
    office_distance_km: officeDistanceKm,
    hybrid_office_city: workTrack === "hybrid" ? officeCity : null,
    hybrid_distance_km: workTrack === "hybrid" ? officeDistanceKm : null,
  };
}

interface CompactJob {
  score: number;
  work_track: WorkTrack | null | undefined;
  needs_manual_review: boolean;
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  reasons: string[];
  soft_flags: string[];
  max_years_detected: number;
  matched_stack_groups: Record<string, string[]>;
  matched_clickhouse: string[];
  matched_nest: string[];
  snippet: string;
  office_city?: string | null;
  office_distance_km?: number | null;
}

function compactRows(rows: EvaluatedJob[], geo: boolean, reviewMin: number): CompactJob[] {
  return rows.map((j) => {
    const row: CompactJob = {
      score: j.score,
      work_track: j.work_track,
      needs_manual_review: j.score < reviewMin || j.soft_flags.length > 0,
      title: j.title,
      company: j.company,
      location: j.location,
      url: j.url,
      source: j.source,
      reasons: j.reasons,
      soft_flags: j.soft_flags,
      max_years_detected: j.max_years_detected,
      matched_stack_groups: j.matched_stack_groups,
      matched_clickhouse: j.matched_clickhouse,
      matched_nest: j.matched_nest,
      snippet: (j.description || "").slice(0, 500),
    };
    if (geo) {
      row.office_city = j.office_city;
      row.office_distance_km = j.office_distance_km;
    }
    return row;
  });
}

export function runFilter(configPath: string): { filtered: string; shortlist: string } {
  const cfg = loadConfig(configPath);
  const outDir = cfg.output.dir;
  const rawPath = join(outDir, cfg.output.raw);
  const jobs = readJsonlJobs(rawPath);

  const evaluated = jobs.map((j) => evaluate(j, cfg));
  const rejectedN = evaluated.filter((j) => j.rejected).length;
  const kept = evaluated.filter((j) => !j.rejected).sort((a, b) => b.score - a.score);

  const deduped: EvaluatedJob[] = [];
  const seen = new Set<string>();
  for (const j of kept) {
    const key = `${norm(j.company)}|${norm(j.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(j);
  }

  const filteredPath = join(outDir, cfg.output.filtered);
  writeJsonl(filteredPath, deduped);

  const shortlistMin = cfg.scoring.shortlist_min_score;
  const reviewMin = cfg.scoring.review_min_score;
  const scored = deduped.filter((j) => j.score >= shortlistMin);
  const remoteSl = scored.filter((j) => j.work_track === "remote");
  const hybridSl = scored.filter((j) => j.work_track === "hybrid");
  const offlineSl = scored.filter((j) => j.work_track === "offline");

  const compact = compactRows(remoteSl, false, reviewMin);
  const compactHybrid = compactRows(hybridSl, true, reviewMin);
  const compactOffline = compactRows(offlineSl, true, reviewMin);

  const home = cfg.geo.home_label;
  const hRadius = cfg.geo.hybrid_radius_km;
  const oRadius = cfg.geo.offline_radius_km;

  const shortlistPath = join(outDir, cfg.output.shortlist);
  writeJson(shortlistPath, compact);

  const hybridPath = join(outDir, cfg.output.hybrid_shortlist ?? "hybrid_shortlist.json");
  writeJson(hybridPath, {
    track: "hybrid",
    radius_km: hRadius,
    home,
    count: compactHybrid.length,
    jobs: compactHybrid,
  });

  const offlinePath = join(
    outDir,
    cfg.output.offline_shortlist ?? "offline_shortlist.json",
  );
  writeJson(offlinePath, {
    track: "offline",
    radius_km: oRadius,
    home,
    count: compactOffline.length,
    jobs: compactOffline,
  });

  const reportPath = join(outDir, cfg.output.report);
  const lines = [
    "# Job search report",
    "",
    `- profile: ${cfg.profile.name}`,
    `- raw: ${jobs.length}`,
    `- rejected by rules: ${rejectedN}`,
    `- after rules (deduped): ${deduped.length}`,
    `- shortlist remote: ${remoteSl.length}`,
    `- shortlist hybrid ≤${hRadius}km: ${hybridSl.length}`,
    `- shortlist offline ≤${oRadius}km: ${offlineSl.length}`,
    `- strong matches remote (score>=${reviewMin}, no soft): ${
      remoteSl.filter((j) => j.score >= reviewMin && !j.soft_flags.length).length
    }`,
    "",
  ];

  const statsPath = join(outDir, cfg.output.collect_stats ?? "collect_stats.json");
  lines.push("## Collect health", "");
  if (existsSync(statsPath)) {
    const rawStats = JSON.parse(readFileSync(statsPath, "utf8")) as {
      incomplete?: boolean;
      rate_limit_events?: { source?: string; query?: string; attempt?: number; message?: string }[];
      notes?: string[];
    };
    const events = rawStats.rate_limit_events ?? [];
    if (!events.length && !rawStats.incomplete) {
      lines.push("- rate limits: none detected");
    } else {
      lines.push(
        `- **WARNING: rate limiting / incomplete collect** (${events.length} event(s))`,
      );
      for (const e of events) {
        lines.push(
          `  - \`${e.source}\` query=${JSON.stringify(e.query)} attempt=${e.attempt}: ${e.message}`,
        );
      }
      for (const note of rawStats.notes ?? []) lines.push(`- note: ${note}`);
      lines.push("- shortlist may be incomplete — re-run later or lower query volume");
    }
  } else {
    lines.push("- no collect_stats.json (ran with `--skip-collect`?)");
  }
  lines.push("");

  const section = (title: string, rows: CompactJob[], geo: boolean) => {
    lines.push("", `## ${title}`, "");
    if (!rows.length) {
      lines.push("- —");
      return;
    }
    for (const j of rows.slice(0, 40)) {
      const flag = j.needs_manual_review ? " ⚠️ review" : "";
      const geoLine = geo
        ? `  office≈${j.office_city ?? "?"} (~${j.office_distance_km} km)  \n`
        : "";
      lines.push(
        `- **${j.score}** ${j.title} @ ${j.company}${flag}  \n` +
          geoLine +
          `  ${j.url}  \n` +
          `  soft: ${j.soft_flags.join(", ") || "—"}`,
      );
    }
  };

  section("Shortlist remote", compact, false);
  section(`Shortlist hybrid (≤${hRadius} km from ${home})`, compactHybrid, true);
  section(`Shortlist offline (≤${oRadius} km from ${home})`, compactOffline, true);
  writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");

  console.log(
    `raw=${jobs.length} rejected=${rejectedN} kept=${deduped.length} ` +
      `remote=${remoteSl.length} hybrid=${hybridSl.length} offline=${offlineSl.length} ` +
      `-> ${shortlistPath} / ${hybridPath} / ${offlinePath}`,
  );
  return { filtered: filteredPath, shortlist: shortlistPath };
}

function readJsonlJobs(path: string): Job[] {
  if (!existsSync(path)) return [];
  const rows: Job[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t) rows.push(JSON.parse(t) as Job);
  }
  return rows;
}
