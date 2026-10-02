export const COLS = 48;
export const ROWS = 36;
export const CELL = 2;
export const WORLD_W = COLS * CELL;
export const WORLD_D = ROWS * CELL;

export const DAY_SECONDS = 76;
export const ECON_SECONDS = 3.1;
export const WALK_SPEED = 2.65;
export const RAIDER_SPEED = 1.72;
export const SAVE_KEY = 'ridgehold.v1';

export type Kind =
  | 'road'
  | 'house'
  | 'farm'
  | 'mill'
  | 'wall'
  | 'woodcamp'
  | 'quarry'
  | 'hall';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Routine = 'toWork' | 'working' | 'toHome' | 'resting' | 'wander';
export type AgentMode = 'idle' | 'walk' | 'work' | 'flee';

export interface KindInfo {
  kind: Kind;
  name: string;
  blurb: string;
  w: number;
  h: number;
  wood: number;
  stone: number;
  slots: number;
  beds: number;
  hp: number;
  hotkey: string;
}

export const CATALOG: Record<Kind, KindInfo> = {
  road: {
    kind: 'road',
    name: 'Road',
    blurb: 'Packed earth and split stone. Folk follow it, and so does the yield.',
    w: 1,
    h: 1,
    wood: 1,
    stone: 0,
    slots: 0,
    beds: 0,
    hp: 40,
    hotkey: '1',
  },
  house: {
    kind: 'house',
    name: 'House',
    blurb: 'A hearth and four beds, set against the wind.',
    w: 2,
    h: 2,
    wood: 12,
    stone: 3,
    slots: 0,
    beds: 4,
    hp: 90,
    hotkey: '2',
  },
  farm: {
    kind: 'farm',
    name: 'Farm',
    blurb: 'Thin ridge soil, turned and sown. A mill nearby makes it count.',
    w: 3,
    h: 2,
    wood: 8,
    stone: 0,
    slots: 2,
    beds: 0,
    hp: 60,
    hotkey: '3',
  },
  mill: {
    kind: 'mill',
    name: 'Mill',
    blurb: 'Sails over the saddle. Staffed and road-linked, it lifts every nearby field.',
    w: 2,
    h: 2,
    wood: 16,
    stone: 10,
    slots: 1,
    beds: 0,
    hp: 110,
    hotkey: '4',
  },
  wall: {
    kind: 'wall',
    name: 'Palisade',
    blurb: 'Sharpened pales. They turn a charge into a long walk.',
    w: 1,
    h: 1,
    wood: 3,
    stone: 0,
    slots: 0,
    beds: 0,
    hp: 100,
    hotkey: '5',
  },
  woodcamp: {
    kind: 'woodcamp',
    name: 'Woodcamp',
    blurb: 'Axes and a drying stack. Claim a stretch of the treeline.',
    w: 2,
    h: 2,
    wood: 10,
    stone: 0,
    slots: 2,
    beds: 0,
    hp: 70,
    hotkey: '6',
  },
  quarry: {
    kind: 'quarry',
    name: 'Quarry',
    blurb: 'A cut into the bone of the ridge. Slow stone, honest stone.',
    w: 2,
    h: 2,
    wood: 10,
    stone: 6,
    slots: 2,
    beds: 0,
    hp: 80,
    hotkey: '7',
  },
  hall: {
    kind: 'hall',
    name: 'Hall',
    blurb: 'The long roof everyone measures home from.',
    w: 3,
    h: 4,
    wood: 0,
    stone: 0,
    slots: 0,
    beds: 8,
    hp: 280,
    hotkey: '',
  },
};

export const TOOLS: Kind[] = ['road', 'house', 'farm', 'mill', 'wall', 'woodcamp', 'quarry'];

export interface GridPoint {
  gx: number;
  gz: number;
}

export function idx(gx: number, gz: number): number {
  return gz * COLS + gx;
}

export function inBounds(gx: number, gz: number): boolean {
  return gx >= 0 && gz >= 0 && gx < COLS && gz < ROWS;
}

export function dims(kind: Kind, rot: number): { w: number; h: number } {
  const info = CATALOG[kind];
  if (((rot % 4) + 4) % 2 === 1) return { w: info.h, h: info.w };
  return { w: info.w, h: info.h };
}

export function cellCenter(gx: number, gz: number): { x: number; z: number } {
  return {
    x: (gx + 0.5 - COLS / 2) * CELL,
    z: (gz + 0.5 - ROWS / 2) * CELL,
  };
}

export function footprintCenter(gx: number, gz: number, w: number, h: number): { x: number; z: number } {
  return {
    x: (gx + w / 2 - COLS / 2) * CELL,
    z: (gz + h / 2 - ROWS / 2) * CELL,
  };
}

export function worldToCell(x: number, z: number): GridPoint {
  const gx = Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL + COLS / 2)));
  const gz = Math.max(0, Math.min(ROWS - 1, Math.floor(z / CELL + ROWS / 2)));
  return { gx, gz };
}

export function cellsFor(kind: Kind, gx: number, gz: number, rot: number): GridPoint[] {
  const { w, h } = dims(kind, rot);
  const out: GridPoint[] = [];
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) out.push({ gx: gx + dx, gz: gz + dz });
  }
  return out;
}

export function seasonOf(day: number): Season {
  const d = ((Math.floor(day) % 32) + 32) % 32;
  if (d < 8) return 'spring';
  if (d < 16) return 'summer';
  if (d < 24) return 'autumn';
  return 'winter';
}

export function seasonMult(season: Season): number {
  if (season === 'spring') return 1.15;
  if (season === 'summer') return 1.45;
  if (season === 'autumn') return 0.95;
  return 0.22;
}

export function timeLabel(day: number): string {
  const tod = day - Math.floor(day);
  let watch = 'Night';
  if (tod >= 0.22 && tod < 0.32) watch = 'Dawn';
  else if (tod >= 0.32 && tod < 0.68) watch = 'Day';
  else if (tod >= 0.68 && tod < 0.8) watch = 'Dusk';
  const season = seasonOf(day);
  const name = season.charAt(0).toUpperCase() + season.slice(1);
  return `Day ${Math.floor(day) + 1} · ${name} · ${watch}`;
}

export function sunElevation(tod: number): number {
  return Math.sin((tod - 0.25) * Math.PI * 2);
}

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const BLOCK = 1e9;
