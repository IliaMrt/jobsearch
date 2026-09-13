/** Optional AI review via OpenRouter after the rule filter. */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { AppConfig, EvaluatedJob } from "./types.js";
import { loadConfig, writeJson } from "./io.js";
import { sleep } from "./io.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function profileBrief(cfg: AppConfig, profileMd: string): string {
  const p = cfg.profile;
  const home = cfg.geo.home_label;
  const hybridKm = cfg.geo.hybrid_radius_km;
  const parts = [
    `Name: ${p.name}`,
    `Target role: ${p.title}`,
    `Level: ${p.level} (career transition; Senior title = soft, not Lead/Staff/EM)`,
    `Home: ${p.location_home}`,
    `Work: remote preferred; hybrid only within ${hybridKm}km of ${home}; ${p.employment}`,
    `German: ${p.languages.german ?? ""}`,
    `English: ${p.languages.english ?? ""} (language = risk flag, not auto-skip)`,
    `Core stack: ${(p.stack_core ?? []).join(", ")}`,
    `OK: ${(p.stack_ok ?? []).join(", ")}`,
    "Role: backend first; backend-heavy fullstack (Node/TS + light FE) = stretch ok.",
    "Not: pure frontend, Lead/Staff/EM.",
    "No CS degree required path; bootcamp / practical experience ok.",
    "Relevant backend experience ~1–2 years (Node/TS, SQL, messaging, Docker).",
  ];
  if (existsSync(profileMd)) {
    parts.push("--- profile.md ---");
    parts.push(readFileSync(profileMd, "utf8").slice(0, 2500));
  }
  return parts.join("\n");
}

function systemPrompt(home: string, hybridKm: number): string {
  return `You are a recruiter assistant for job matching in Germany.
Reply with a JSON object only, no markdown.

Goal: two usable lists — "apply" (good match) and "stretch" (risk, but worth applying).
Language and soft skills are RISK FLAGS, not automatic skips for "fluent English" / B1.

Hard skip ONLY when clearly:
- Office-only / anti-remote / "isn't remote" with no exception.
- Pure frontend primary role (no backend).
- Lead / Staff / Principal / Engineering Manager / Director (not Senior alone).
- German business-fluent / C1–C2 as hard requirement.
- Mandatory degree with no "or experience" alternative.
- Foreign primary stack (Java/Spring, Rails, senior AWS-AI) without real Node/TS backend work.

Do NOT auto-skip (prefer stretch + risk flag):
- "fluent / strong / business English" with otherwise good tech fit → stretch, blocker "EN risk".
- Hybrid / occasional office only if office ≤${hybridKm} km from ${home} → stretch ok, flag hybrid_travel. Far cities → skip.
- Senior in title when tasks look mid/IC and stack fits → apply or stretch.
- Backend-heavy fullstack (Node/TS + React/Vue, backend clearly primary) → apply/stretch ok.
- Take rule soft_flags seriously (senior_title, hybrid_within_radius, fullstack_backend_heavy, lang:*).

Primary: tech fit (Node/TS, SQL, Docker, messaging, APIs, backend tasks), remote/hybrid realism, task level.
Then language as a flag — a human decides finally.

JSON schema:
{
  "verdict": "apply" | "stretch" | "skip",
  "score": 0-100,
  "stack_fit": "high"|"medium"|"low",
  "remote_fit": "high"|"medium"|"low",
  "language_fit": "high"|"medium"|"low",
  "level_fit": "high"|"medium"|"low",
  "risk_flags": ["en_b1", "hybrid_travel", "senior_title", "fullstack_fe", "..."],
  "blockers": ["real hard blockers only"],
  "pros": ["..."],
  "summary_de": "2-3 sentences in German: tech match first, then risks"
}`;
}

function sanitizeForLlm(text: string, maxLen?: number): string {
  if (!text) return "";
  let t = String(text);
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
  const repl: Record<string, string> = {
    "\u201c": "'",
    "\u201d": "'",
    "\u2018": "'",
    "\u2019": "'",
    "\u00ab": "'",
    "\u00bb": "'",
    '"': "'",
    "\\": "/",
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "`": "'",
  };
  for (const [a, b] of Object.entries(repl)) t = t.replaceAll(a, b);
  t = t.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  if (maxLen != null) t = t.slice(0, maxLen);
  return t.trim();
}

function sanitizeModelJson(text: string): string {
  if (!text) return "";
  let t = String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
  for (const [a, b] of [
    ["\u201c", '"'],
    ["\u201d", '"'],
    ["\u2018", "'"],
    ["\u2019", "'"],
    ["\u00ab", '"'],
    ["\u00bb", '"'],
    ["\u2013", "-"],
    ["\u2014", "-"],
    ["\u2026", "..."],
  ] as const) {
    t = t.replaceAll(a, b);
  }
  return t.trim();
}

function extractJson(text: string): Record<string, unknown> {
  let t = sanitizeModelJson(text);
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON object in model response");
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return JSON.parse(m[0].replace(/[\r\n]+/g, " ")) as Record<string, unknown>;
    }
  }
}

async function reviewJob(opts: {
  apiKey: string;
  model: string;
  profile: string;
  system: string;
  job: EvaluatedJob;
  temperature: number;
  maxDescChars: number;
}): Promise<Record<string, unknown>> {
  const desc = sanitizeForLlm(
    opts.job.description || "",
    opts.maxDescChars,
  );
  const user = sanitizeForLlm(
    `## Candidate\n${opts.profile}\n\n` +
      `## Job\n` +
      `Title: ${sanitizeForLlm(String(opts.job.title || ""))}\n` +
      `Company: ${sanitizeForLlm(String(opts.job.company || ""))}\n` +
      `Location: ${sanitizeForLlm(String(opts.job.location || ""))}\n` +
      `URL: ${opts.job.url}\n` +
      `Heuristic score: ${opts.job.score}\n` +
      `Rule reasons: ${JSON.stringify(opts.job.reasons)}\n` +
      `Soft flags: ${JSON.stringify(opts.job.soft_flags)}\n\n` +
      `### Description\n${desc}\n`,
  );

  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/IliaMrt/jobsearch",
      "X-Title": "JobSearch pipeline",
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`OpenRouter HTTP ${r.status}: ${body.slice(0, 500)}`);
  }

  const data = (await r.json()) as {
    choices: { message: { content: string } }[];
    usage?: Record<string, unknown>;
  };
  const content = data.choices[0]?.message?.content ?? "";
  const parsed = extractJson(content);
  return {
    title: opts.job.title,
    company: opts.job.company,
    url: opts.job.url,
    source: opts.job.source,
    heuristic_score: opts.job.score,
    ai: parsed,
    model: opts.model,
    usage: data.usage ?? {},
  };
}

export async function runAiReview(configPath: string): Promise<string> {
  loadDotenv();
  const cfg = loadConfig(configPath);
  const aiCfg = cfg.ai_review ?? {};
  if (aiCfg.enabled === false) {
    console.log("ai_review disabled in config");
    return join(cfg.output.dir, aiCfg.output ?? "ai_shortlist.json");
  }

  const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY missing. Copy .env.example to .env or export the key.",
    );
  }

  const model = aiCfg.model ?? "openai/gpt-4o-mini";
  const maxJobs = aiCfg.max_jobs ?? 25;
  const temperature = aiCfg.temperature ?? 0.1;
  const maxDesc = aiCfg.max_desc_chars ?? 6000;
  const minHeuristic = aiCfg.min_heuristic_score ?? 0;
  const keepVerdicts = new Set(
    (aiCfg.keep_verdicts ?? ["apply", "stretch"]).map((v) => v.toLowerCase()),
  );
  const pause = aiCfg.pause_sec ?? 0.4;

  const outDir = cfg.output.dir;
  const filteredPath = join(outDir, cfg.output.filtered);
  if (!existsSync(filteredPath)) {
    throw new Error(`missing ${filteredPath} — run the filter first`);
  }

  let jobs: EvaluatedJob[] = [];
  for (const line of readFileSync(filteredPath, "utf8").split("\n")) {
    if (line.trim()) jobs.push(JSON.parse(line) as EvaluatedJob);
  }

  jobs = jobs.filter(
    (j) =>
      (j.work_track ?? "remote") === "remote" &&
      !j.hybrid_track &&
      !j.offline_track &&
      (j.score ?? 0) >= minHeuristic,
  );
  jobs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  jobs = jobs.slice(0, maxJobs);

  const profile = profileBrief(cfg, "profile.md");
  const system = systemPrompt(cfg.geo.home_label, cfg.geo.hybrid_radius_km);
  const results: Record<string, unknown>[] = [];
  const errors: string[] = [];

  console.log(`[ai] model=${model} jobs=${jobs.length}`);
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    console.log(`[ai] ${i + 1}/${jobs.length} ${job.title}`);
    try {
      results.push(
        await reviewJob({
          apiKey,
          model,
          profile,
          system,
          job,
          temperature,
          maxDescChars: maxDesc,
        }),
      );
    } catch (err) {
      const msg = `${job.title}: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`  !! ${msg}`);
      errors.push(msg);
    }
    if (pause) await sleep(pause * 1000);
  }

  const aiScore = (row: Record<string, unknown>): number => {
    const ai = row.ai as { score?: unknown } | undefined;
    const n = Number(ai?.score ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const kept = results.filter((r) => {
    const ai = r.ai as { verdict?: string } | undefined;
    return keepVerdicts.has(String(ai?.verdict ?? "").toLowerCase());
  });
  kept.sort((a, b) => aiScore(b) - aiScore(a));
  results.sort((a, b) => aiScore(b) - aiScore(a));

  const applyList = kept.filter(
    (r) =>
      String((r.ai as { verdict?: string })?.verdict ?? "").toLowerCase() === "apply",
  );
  const stretchList = kept.filter(
    (r) =>
      String((r.ai as { verdict?: string })?.verdict ?? "").toLowerCase() ===
      "stretch",
  );

  const aiAllPath = join(outDir, aiCfg.output_all ?? "ai_reviews.json");
  const aiShortPath = join(outDir, aiCfg.output ?? "ai_shortlist.json");
  writeJson(aiAllPath, {
    model,
    reviewed: results.length,
    errors,
    results,
  });
  writeJson(aiShortPath, {
    model,
    kept_verdicts: [...keepVerdicts].sort(),
    count: kept.length,
    apply_count: applyList.length,
    stretch_count: stretchList.length,
    apply: applyList,
    stretch: stretchList,
    jobs: kept,
  });

  const compact = kept.map((r) => {
    const ai = (r.ai as Record<string, unknown>) ?? {};
    return {
      score: ai.score,
      verdict: ai.verdict,
      needs_manual_review: String(ai.verdict).toLowerCase() === "stretch",
      title: r.title,
      company: r.company,
      url: r.url,
      source: r.source,
      heuristic_score: r.heuristic_score,
      risk_flags: ai.risk_flags ?? [],
      blockers: ai.blockers ?? [],
      pros: ai.pros ?? [],
      summary_de: ai.summary_de,
      stack_fit: ai.stack_fit,
      remote_fit: ai.remote_fit,
      language_fit: ai.language_fit,
      level_fit: ai.level_fit,
      model,
    };
  });
  writeJson(join(outDir, cfg.output.shortlist), compact);

  const reportPath = join(outDir, cfg.output.report);
  const lines = [
    "",
    "## AI review (OpenRouter)",
    "",
    `- model: \`${model}\``,
    `- reviewed: ${results.length}`,
    `- apply: ${applyList.length}`,
    `- stretch: ${stretchList.length}`,
    `- kept total (${[...keepVerdicts].sort().join(", ")}): ${kept.length}`,
    `- errors: ${errors.length}`,
    "",
  ];

  const bullets = (rows: Record<string, unknown>[], heading: string) => {
    lines.push(`### ${heading}`, "");
    if (!rows.length) {
      lines.push("- —", "");
      return;
    }
    for (const r of rows) {
      const ai = (r.ai as Record<string, unknown>) ?? {};
      const risks = (ai.risk_flags as string[]) ?? [];
      lines.push(
        `- **${ai.verdict} ${ai.score}** ${r.title} @ ${r.company}  \n` +
          `  ${r.url}  \n` +
          `  ${ai.summary_de ?? ""}  \n` +
          `  risk: ${risks.join(", ") || "—"}  \n` +
          `  blockers: ${((ai.blockers as string[]) ?? []).join(", ") || "—"}`,
      );
    }
    lines.push("");
  };

  bullets(applyList, "Apply");
  bullets(stretchList, "Stretch");
  if (errors.length) {
    lines.push("### AI errors");
    for (const e of errors) lines.push(`- ${e}`);
  }
  appendFileSync(reportPath, lines.join("\n") + "\n", "utf8");

  console.log(
    `[ai] apply=${applyList.length} stretch=${stretchList.length} -> ${aiShortPath}`,
  );
  return aiShortPath;
}
