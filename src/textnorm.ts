/** Normalize job-description text so stack keywords match reliably. */

const WS = /\s+/g;

export function norm(text: string | null | undefined): string {
  if (!text) return "";
  let t = String(text).toLowerCase();
  t = t.replaceAll("node.js", "nodejs");
  t = t.replaceAll("node js", "nodejs");
  t = t.replaceAll("node-js", "nodejs");
  t = t.replaceAll("nest.js", "nestjs");
  t = t.replaceAll("nest js", "nestjs");
  t = t.replaceAll("type script", "typescript");
  t = t.replaceAll("type-script", "typescript");
  t = t.replaceAll("postgres.js", "postgresql");
  t = t.replaceAll("postgre sql", "postgresql");
  t = t.replaceAll("click house", "clickhouse");
  t = t.replaceAll("rabbit mq", "rabbitmq");
  t = t.replaceAll("full-stack", "fullstack");
  t = t.replaceAll("full stack", "fullstack");
  t = t.replaceAll("front-end", "frontend");
  t = t.replaceAll("front end", "frontend");
  t = t.replaceAll("back-end", "backend");
  t = t.replaceAll("back end", "backend");
  t = t.replaceAll("home office", "homeoffice");
  t = t.replaceAll("home-office", "homeoffice");
  return t.replace(WS, " ").trim();
}

export function jobBlob(job: {
  title?: string;
  location?: string;
  description?: string;
  job_type?: string;
}): string {
  return norm(
    `${job.title ?? ""} ${job.location ?? ""} ${job.description ?? ""} ${job.job_type ?? ""}`,
  );
}
