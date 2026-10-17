import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { HttpError } from "../errors.js";

export const DUPLICATE_HAMMING = 6;

export function averageHash(rgba: Uint8Array, width: number, height: number): string {
  const size = 8;
  const samples: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / size));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / size));
      const i = (sy * width + sx) * 4;
      samples.push(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    }
  }
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  let hex = "";
  for (let i = 0; i < samples.length; i += 4) {
    const nibble =
      (samples[i] >= avg ? 8 : 0) +
      (samples[i + 1] >= avg ? 4 : 0) +
      (samples[i + 2] >= avg ? 2 : 0) +
      (samples[i + 3] >= avg ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

export function hammingHex(left: string, right: string): number {
  if (left.length !== right.length) return 64;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) {
    let bits = parseInt(left[i], 16) ^ parseInt(right[i], 16);
    while (bits) {
      distance += bits & 1;
      bits >>= 1;
    }
  }
  return distance;
}

export function assertImage(buffer: Buffer, mime: string): "image/jpeg" | "image/png" {
  const jpegMagic = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const pngMagic =
    buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (mime === "image/jpeg" && jpegMagic) return "image/jpeg";
  if (mime === "image/png" && pngMagic) return "image/png";
  throw new HttpError(400, "UNSUPPORTED_FILE", "Upload one jpg or png, up to 10 MB.");
}

export function perceptualHash(buffer: Buffer, mime: "image/jpeg" | "image/png"): string | undefined {
  try {
    if (mime === "image/png") {
      const png = PNG.sync.read(buffer);
      return averageHash(png.data, png.width, png.height);
    }
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return averageHash(decoded.data, decoded.width, decoded.height);
  } catch {
    return undefined;
  }
}
