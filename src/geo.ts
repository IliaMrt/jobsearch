/** Distance helpers for hybrid / offline shortlists. */

import type { AppConfig } from "./types.js";
import { norm } from "./textnorm.js";

/** Known cities near a typical NE-Germany / Berlin home base. */
const CITY_COORDS: Record<string, [number, number]> = {
  berlin: [52.52, 13.405],
  potsdam: [52.3906, 13.0645],
  oranienburg: [52.754, 13.236],
  bernau: [52.679, 13.587],
  eberswalde: [52.833, 13.819],
  "frankfurt oder": [52.347, 14.55],
  "frankfurt (oder)": [52.347, 14.55],
  cottbus: [51.756, 14.334],
  rostock: [54.0924, 12.0991],
  schwerin: [53.6355, 11.4012],
  neubrandenburg: [53.5643, 13.2753],
  greifswald: [54.0865, 13.3923],
  stralsund: [54.309, 13.081],
  szczecin: [53.4285, 14.5528],
  stettin: [53.4285, 14.5528],
  hamburg: [53.5511, 9.9937],
  magdeburg: [52.1202, 11.6276],
  leipzig: [51.3397, 12.3731],
  dresden: [51.0504, 13.7373],
};

export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const r = 6371;
  const p1 = (a[0] * Math.PI) / 180;
  const p2 = (b[0] * Math.PI) / 180;
  const dPhi = ((b[0] - a[0]) * Math.PI) / 180;
  const dL = ((b[1] - a[1]) * Math.PI) / 180;
  const x =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dL / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}

function homeCoords(cfg: AppConfig): [number, number] {
  return [cfg.geo.home_lat, cfg.geo.home_lon];
}

function fold(t: string): string {
  return t
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .replaceAll("ß", "ss");
}

export function nearestOffice(
  text: string,
  home: [number, number],
): { city: string | null; km: number | null } {
  const t = fold(norm(text));
  let bestName: string | null = null;
  let bestKm: number | null = null;

  const names = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const key = fold(name);
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(key)}(?![a-z0-9])`);
    if (!re.test(t)) continue;
    const coords = CITY_COORDS[name]!;
    const km = haversineKm(home, coords);
    if (bestKm === null || km < bestKm) {
      bestKm = km;
      bestName = name;
    }
  }
  return { city: bestName, km: bestKm };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveOffice(
  job: { location?: string },
  blob: string,
  cfg: AppConfig,
): {
  city: string | null;
  km: number | null;
  within_hybrid: boolean;
  within_offline: boolean;
} {
  const home = homeCoords(cfg);
  const loc = `${job.location ?? ""} ${blob.slice(0, 1500)}`;
  const { city, km } = nearestOffice(loc, home);
  const hR = cfg.geo.hybrid_radius_km;
  const oR = cfg.geo.offline_radius_km;
  return {
    city,
    km: km === null ? null : Math.round(km * 10) / 10,
    within_hybrid: km !== null && km <= hR,
    within_offline: km !== null && km <= oR,
  };
}
