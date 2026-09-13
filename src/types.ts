/** Shared shapes used across collect → filter → AI review. */

export type WorkTrack = "remote" | "hybrid" | "offline";

export interface Job {
  id: string;
  source: string;
  title: string;
  company: string;
  location: string;
  is_remote_flag: boolean;
  url: string;
  description: string;
  date_posted: string;
  job_type: string;
  collected_at: string;
}

export interface EvaluatedJob extends Job {
  rejected: boolean;
  score: number;
  reasons: string[];
  matched_stack_groups: Record<string, string[]>;
  matched_prefer: string[];
  matched_remote: string[];
  matched_sql: string[];
  matched_clickhouse: string[];
  matched_nest: string[];
  matched_german: string[];
  soft_flags: string[];
  max_years_detected: number;
  work_track: WorkTrack | null;
  hybrid_track: boolean;
  offline_track: boolean;
  office_city: string | null;
  office_distance_km: number | null;
  hybrid_office_city: string | null;
  hybrid_distance_km: number | null;
}

export interface RateLimitConfig {
  pause_between_queries_sec: number;
  pause_between_arbeitnow_pages_sec: number;
  max_retries_on_429: number;
  backoff_base_sec: number;
  backoff_max_sec: number;
  min_results_ratio: number;
}

export interface AppConfig {
  profile: {
    name: string;
    title: string;
    location_home: string;
    level: string;
    languages: { german?: string; english?: string };
    employment: string;
    work_format: string;
    regions_ok: string[];
    stack_core: string[];
    stack_ok: string[];
    stack_avoid_as_role: string[];
  };
  collect: {
    merge_with_existing?: boolean;
    rate_limit?: Partial<RateLimitConfig>;
    arbeitnow?: boolean;
    arbeitnow_max_pages?: number;
    arbeitnow_max_jobs?: number;
    arbeitnow_queries?: string[];
    jobsuche?: {
      enabled?: boolean;
      location?: string;
      pages?: number;
      size?: number;
      fetch_details?: boolean;
      detail_pause_sec?: number;
      max_details?: number;
      queries?: string[];
    };
    remotive?: { enabled?: boolean; searches?: string[] };
    jobicy?: { enabled?: boolean; count?: number; tags?: string[] };
  };
  filters: {
    require_stack_groups: Record<string, string[]>;
    require_mode: string;
    max_years_hard: number;
    prefer_any: string[];
    reject_any: string[];
    soft_reject_any: string[];
    require_remote_signals: string[];
    reject_freelance_signals: string[];
  };
  scoring: {
    weights: Record<string, number>;
    shortlist_min_score: number;
    review_min_score: number;
    sql_signals: string[];
    clickhouse_signals: string[];
    rabbitmq_signals?: string[];
    docker_signals?: string[];
    nest_signals?: string[];
    german_signals: string[];
  };
  output: {
    dir: string;
    raw: string;
    filtered: string;
    shortlist: string;
    hybrid_shortlist?: string;
    offline_shortlist?: string;
    report: string;
    collect_stats?: string;
  };
  geo: {
    home_label: string;
    home_lat: number;
    home_lon: number;
    hybrid_radius_km: number;
    offline_radius_km: number;
  };
  ai_review: {
    enabled?: boolean;
    model?: string;
    max_jobs?: number;
    min_heuristic_score?: number;
    temperature?: number;
    max_desc_chars?: number;
    pause_sec?: number;
    keep_verdicts?: string[];
    output?: string;
    output_all?: string;
  };
}
