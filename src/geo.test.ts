import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, nearestOffice } from "./geo.js";

describe("haversineKm", () => {
  it("returns ~0 for identical points", () => {
    assert.ok(haversineKm([52.52, 13.405], [52.52, 13.405]) < 0.01);
  });

  it("is roughly Berlin–Potsdam distance", () => {
    const km = haversineKm([52.52, 13.405], [52.3906, 13.0645]);
    assert.ok(km > 20 && km < 40, `got ${km}`);
  });
});

describe("nearestOffice", () => {
  it("finds Berlin in free text", () => {
    const home: [number, number] = [52.52, 13.405];
    const { city, km } = nearestOffice("Office in Berlin, hybrid 2 days", home);
    assert.equal(city, "berlin");
    assert.ok(km !== null && km < 5);
  });
});
