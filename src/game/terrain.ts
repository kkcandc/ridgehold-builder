import { COLS, ROWS, cellCenter } from './config';

export interface TreeSpawn {
  gx: number;
  gz: number;
  x: number;
  z: number;
  scale: number;
  variant: number;
  rot: number;
  hp: number;
}

function hash2(ix: number, iz: number, seed: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const sx = smoothstep(fx);
  const sz = smoothstep(fz);
  const v00 = hash2(x0, z0, seed);
  const v10 = hash2(x0 + 1, z0, seed);
  const v01 = hash2(x0, z0 + 1, seed);
  const v11 = hash2(x0 + 1, z0 + 1, seed);
  return lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sz);
}

export function fbm(x: number, z: number, seed: number): number {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(x * f, z * f, seed + i * 19);
    norm += amp;
    amp *= 0.5;
    f *= 2.05;
  }
  return sum / norm;
}

function ramp(v: number, a: number, b: number): number {
  return smoothstep((v - a) / (b - a));
}

/** World-space height. The town sits on a long north-south ridge. */
export function sampleHeight(x: number, z: number, seed: number): number {
  const spread = 13.5;
  const ridge = 13.2 * Math.exp(-(x * x) / (2 * spread * spread));
  const roll = Math.sin(z * 0.045) * 0.85 + Math.sin(z * 0.012 + 1.4) * 0.4;
  const n = (fbm(x * 0.08 + 3.2, z * 0.07 - 1.1, seed) - 0.5) * 1.55;
  const ax = Math.abs(x);
  const shoulder = ramp(ax, 12, 24);
  const edge = ramp(ax, 30, 48);
  return ridge + roll * (1 - shoulder) + n * (1 - shoulder * 0.65) - shoulder * 9.2 - edge * 2;
}

export function sampleSlope(x: number, z: number, seed: number): number {
  const e = 0.85;
  const hL = sampleHeight(x - e, z, seed);
  const hR = sampleHeight(x + e, z, seed);
  const hD = sampleHeight(x, z - e, seed);
  const hU = sampleHeight(x, z + e, seed);
  return Math.hypot((hR - hL) / (2 * e), (hU - hD) / (2 * e));
}

export function buildCellFields(seed: number): { height: Float32Array; slope: Float32Array } {
  const height = new Float32Array(COLS * ROWS);
  const slope = new Float32Array(COLS * ROWS);
  for (let gz = 0; gz < ROWS; gz++) {
    for (let gx = 0; gx < COLS; gx++) {
      const { x, z } = cellCenter(gx, gz);
      const i = gz * COLS + gx;
      height[i] = sampleHeight(x, z, seed);
      slope[i] = sampleSlope(x, z, seed);
    }
  }
  return { height, slope };
}

export function generateTrees(seed: number): TreeSpawn[] {
  const trees: TreeSpawn[] = [];
  for (let gz = 1; gz < ROWS - 1; gz++) {
    for (let gx = 1; gx < COLS - 1; gx++) {
      const { x, z } = cellCenter(gx, gz);
      const h = sampleHeight(x, z, seed);
      const s = sampleSlope(x, z, seed);
      if (h < 5.4 || h > 10.6 || s > 0.72) continue;
      const roll = hash2(gx, gz, seed + 91);
      const shoulder = Math.abs(x);
      const density = shoulder < 7 ? 0.05 : shoulder < 14 ? 0.16 : 0.28;
      if (roll > density) continue;
      trees.push({
        gx,
        gz,
        x: x + (hash2(gx, gz, seed + 3) - 0.5) * 1.1,
        z: z + (hash2(gx, gz, seed + 5) - 0.5) * 1.1,
        scale: 0.75 + hash2(gx, gz, seed + 8) * 0.7,
        variant: hash2(gx, gz, seed + 11) > 0.45 ? 1 : 0,
        rot: hash2(gx, gz, seed + 13) * Math.PI * 2,
        hp: 5,
      });
    }
  }
  return trees;
}
