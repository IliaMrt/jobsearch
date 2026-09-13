import type { RateLimitConfig } from "./types.js";
import { sleep } from "./io.js";

export interface RateEvent {
  source: string;
  query: string;
  attempt: number;
  message: string;
  at: string;
}

export class CollectStats {
  events: RateEvent[] = [];
  queryRuns: Record<string, unknown>[] = [];
  incomplete = false;
  notes: string[] = [];

  addEvent(source: string, query: string, attempt: number, message: string): void {
    this.events.push({
      source,
      query,
      attempt,
      message,
      at: new Date().toISOString(),
    });
    this.incomplete = true;
  }

  addRun(data: Record<string, unknown>): void {
    this.queryRuns.push(data);
  }

  toJSON(): Record<string, unknown> {
    return {
      incomplete: this.incomplete,
      rate_limit_events: this.events,
      query_runs: this.queryRuns,
      notes: this.notes,
      warning_count: this.events.length,
    };
  }
}

const DEFAULT_RL: RateLimitConfig = {
  pause_between_queries_sec: 8,
  pause_between_arbeitnow_pages_sec: 1.5,
  max_retries_on_429: 3,
  backoff_base_sec: 20,
  backoff_max_sec: 180,
  min_results_ratio: 0.25,
};

export function resolveRateLimit(
  user?: Partial<RateLimitConfig>,
): RateLimitConfig {
  return { ...DEFAULT_RL, ...user };
}

/** Exponential backoff with jitter. `attempt` starts at 1. */
export async function sleepBackoff(
  attempt: number,
  opts: { baseSeconds: number; maxSeconds: number; jitter?: number },
): Promise<number> {
  const jitter = opts.jitter ?? 0.25;
  let delay = Math.min(opts.maxSeconds, opts.baseSeconds * 2 ** (attempt - 1));
  delay *= 1 + (Math.random() * 2 - 1) * jitter;
  delay = Math.max(0.5, delay);
  await sleep(delay * 1000);
  return delay;
}
