import assert from "node:assert/strict";
import test from "node:test";
import { averageHash, hammingHex } from "./phash.js";

function solid(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return data;
}

test("identical images have distance zero", () => {
  const pixels = solid(16, 16, [20, 40, 60, 255]);
  const hash = averageHash(pixels, 16, 16);
  assert.equal(hammingHex(hash, averageHash(pixels, 16, 16)), 0);
});

test("a different image is not treated as the same photo", () => {
  const dark = averageHash(solid(32, 32, [10, 10, 10, 255]), 32, 32);
  const split = solid(32, 32, [10, 10, 10, 255]);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const i = (y * 32 + x) * 4;
      split[i] = 240;
      split[i + 1] = 240;
      split[i + 2] = 240;
    }
  }
  assert.ok(hammingHex(dark, averageHash(split, 32, 32)) > 6);
});
