import {
  BLOCK,
  CATALOG,
  CELL,
  COLS,
  DIRS,
  ROWS,
  cellCenter,
  cellsFor,
  dims,
  footprintCenter,
  idx,
  inBounds,
  seasonMult,
  seasonOf,
  worldToCell,
  type GridPoint,
  type Kind,
  type Routine,
  type Season,
} from './config';
import { findPath } from './path';
import { buildCellFields, generateTrees, type TreeSpawn } from './terrain';

export interface Building {
  id: number;
  kind: Kind;
  gx: number;
  gz: number;
  rot: number;
  hp: number;
  maxHp: number;
  workerIds: number[];
  growth: number;
  noted: boolean;
}

export interface Villager {
  id: number;
  x: number;
  z: number;
  homeId: number;
  jobId: number | null;
  routine: Routine;
  timer: number;
  mode: 'idle' | 'walk' | 'work' | 'flee';
  facing: number;
  phase: number;
  path: GridPoint[] | null;
  pathI: number;
  pathRev: number;
  wander: GridPoint | null;
}

export interface Raider {
  id: number;
  x: number;
  z: number;
  hp: number;
  facing: number;
  phase: number;
  path: GridPoint[] | null;
  pathI: number;
  stuck: number;
}

export interface Shot {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  life: number;
}

export interface SaveData {
  v: 1;
  seed: number;
  day: number;
  wood: number;
  food: number;
  stone: number;
  buildings: Array<Omit<Building, 'workerIds' | 'noted'>>;
  villagers: Array<Pick<Villager, 'id' | 'x' | 'z' | 'homeId' | 'jobId' | 'routine' | 'timer' | 'facing'>>;
  treeHp: number[];
  raidsEnabled: boolean;
  nextRaidDay: number;
  nextId: number;
  nextAgent: number;
  log: string[];
  aimsDone: string[];
  speed: number;
  view?: { px: number; py: number; pz: number; tx: number; ty: number; tz: number };
}

const AIM_DEFS: Array<{ id: string; text: string; met: (s: GameState) => boolean }> = [
  { id: 'souls', text: 'Shelter sixteen souls', met: (s) => s.villagers.length >= 16 },
  { id: 'mill', text: 'Raise a windmill on the ridge', met: (s) => s.buildings.some((b) => b.kind === 'mill') },
  { id: 'granary', text: 'Keep 160 food in store', met: (s) => s.resources.food >= 160 },
  { id: 'pales', text: 'Plant twelve palisades', met: (s) => s.countKind('wall') >= 12 },
  {
    id: 'town',
    text: 'Let Ridgehold become a town',
    met: (s) => {
      const t = s.tierName();
      return t === 'Town' || t === 'Borough';
    },
  },
];

export const AIMS = AIM_DEFS.map(({ id, text }) => ({ id, text }));

export class GameState {
  seed: number;
  day: number;
  resources = { wood: 64, food: 78, stone: 42 };
  buildings: Building[] = [];
  villagers: Villager[] = [];
  raiders: Raider[] = [];
  trees: TreeSpawn[] = [];
  shots: Shot[] = [];
  log: string[] = [];
  raidsEnabled = true;
  nextRaidDay = 15;
  aimsDone: string[] = [];
  speed = 1;
  selectedId: number | null = null;
  view: SaveData['view'];

  occupancy = new Int32Array(COLS * ROWS);
  walkCost = new Float32Array(COLS * ROWS);
  raidCost = new Float32Array(COLS * ROWS);
  roadLink = new Uint8Array(COLS * ROWS);
  cellH: Float32Array;
  cellS: Float32Array;
  navRev = 0;
  treeRev = 0;

  private nextId = 1;
  private nextAgent = 1;
  private econAcc = 0;
  private growAcc = 0;
  private hunger = 0;
  private jobAcc = 0;
  private aimAcc = 0;
  private shotAcc = 0;
  private breach = 0;
  private warned = false;
  private season: Season = 'spring';
  private tier = 'Hamlet';
  private byId = new Map<number, Building>();
  private foodFrac = 0;
  private quietWood = new Set<number>();

  private constructor(seed: number) {
    this.seed = seed;
    this.day = 3.4;
    const fields = buildCellFields(seed);
    this.cellH = fields.height;
    this.cellS = fields.slope;
    this.trees = generateTrees(seed);
    this.season = seasonOf(this.day);
    this.tier = 'Hamlet';
  }

  static fresh(seed = Math.floor(Math.random() * 999983)): GameState {
    const s = new GameState(seed);
    s.foundHamlet();
    s.logMsg('The high fold is in your keeping.');
    return s;
  }

  static fromSave(data: SaveData): GameState | null {
    if (!data || data.v !== 1 || !Array.isArray(data.buildings)) return null;
    if (!data.buildings.some((b) => b.kind === 'hall')) return null;
    const s = new GameState(data.seed);
    s.day = data.day;
    s.resources.wood = data.wood;
    s.resources.food = data.food;
    s.resources.stone = data.stone;
    s.raidsEnabled = data.raidsEnabled;
    s.nextRaidDay = data.nextRaidDay;
    s.nextId = data.nextId;
    s.nextAgent = data.nextAgent;
    s.log = data.log.slice(0, 32);
    s.aimsDone = data.aimsDone.slice();
    s.speed = data.speed ?? 1;
    s.view = data.view;
    s.season = seasonOf(s.day);
    for (const raw of data.buildings) {
      const info = CATALOG[raw.kind];
      if (!info) return null;
      const b: Building = {
        ...raw,
        workerIds: [],
        noted: true,
        maxHp: info.hp,
      };
      s.buildings.push(b);
      s.byId.set(b.id, b);
    }
    if (data.treeHp && data.treeHp.length === s.trees.length) {
      for (let i = 0; i < s.trees.length; i++) s.trees[i].hp = data.treeHp[i];
    }
    s.rebuildNav();
    for (const raw of data.villagers) {
      const homeOk = s.byId.has(raw.homeId);
      const v: Villager = {
        id: raw.id,
        x: raw.x,
        z: raw.z,
        homeId: homeOk ? raw.homeId : s.hall().id,
        jobId: raw.jobId && s.byId.has(raw.jobId) ? raw.jobId : null,
        routine: raw.routine ?? 'wander',
        timer: raw.timer ?? 1,
        mode: 'idle',
        facing: raw.facing ?? 0,
        phase: Math.random() * Math.PI * 2,
        path: null,
        pathI: 0,
        pathRev: -1,
        wander: null,
      };
      s.villagers.push(v);
    }
    s.dirtyAssign();
    s.tier = s.tierName();
    return s;
  }

  toSave(): SaveData {
    return {
      v: 1,
      seed: this.seed,
      day: this.day,
      wood: this.resources.wood,
      food: this.resources.food,
      stone: this.resources.stone,
      buildings: this.buildings.map(({ workerIds: _w, noted: _n, ...rest }) => rest),
      villagers: this.villagers.map((v) => ({
        id: v.id,
        x: v.x,
        z: v.z,
        homeId: v.homeId,
        jobId: v.jobId,
        routine: v.routine,
        timer: v.timer,
        facing: v.facing,
      })),
      treeHp: this.trees.map((t) => t.hp),
      raidsEnabled: this.raidsEnabled,
      nextRaidDay: this.nextRaidDay,
      nextId: this.nextId,
      nextAgent: this.nextAgent,
      log: this.log.slice(0, 32),
      aimsDone: this.aimsDone.slice(),
      speed: this.speed,
      view: this.view,
    };
  }

  summary() {
    return {
      pop: this.villagers.length,
      beds: this.beds(),
      buildings: this.buildings.map((b) => b.kind),
      wood: this.resources.wood,
      food: this.resources.food,
      stone: this.resources.stone,
      day: this.day,
      tier: this.tierName(),
      raiders: this.raiders.length,
      buildable: this.buildableCount(),
      nav: this.navRev,
    };
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    this.day += dt / 76;
    this.updateSeason();
    this.econAcc += dt;
    while (this.econAcc >= 3.1) {
      this.econAcc -= 3.1;
      this.economyTick();
    }
    this.growAccTick(dt);
    this.jobAcc += dt;
    if (this.jobAcc > 6) {
      this.jobAcc = 0;
      this.assignJobs();
    }
    this.updateVillagers(dt);
    this.updateRaids(dt);
    this.aimAcc += dt;
    if (this.aimAcc > 1.2) {
      this.aimAcc = 0;
      this.checkAims();
      this.checkTier();
    }
    for (const shot of this.shots) shot.life -= dt;
    if (this.shots.length) this.shots = this.shots.filter((s) => s.life > 0);
  }

  canPlace(kind: Kind, gx: number, gz: number, rot: number, ignoreCost = false): string | null {
    if (kind === 'hall') return 'The hall already stands.';
    const info = CATALOG[kind];
    const cells = cellsFor(kind, gx, gz, rot);
    for (const c of cells) {
      if (!inBounds(c.gx, c.gz)) return 'Beyond the fold.';
      if (this.occupancy[idx(c.gx, c.gz)]) return 'That ground is taken.';
      const h = this.cellH[idx(c.gx, c.gz)];
      const s = this.cellS[idx(c.gx, c.gz)];
      if (h < 6.15) return 'Too low. Keep to the ridge.';
      const slopeLimit = kind === 'road' || kind === 'wall' ? 0.78 : kind === 'quarry' ? 0.7 : 0.56;
      if (s > slopeLimit) return 'The slope will not hold.';
    }
    if (!ignoreCost) {
      if (this.resources.wood < info.wood) return `Need ${info.wood} wood.`;
      if (this.resources.stone < info.stone) return `Need ${info.stone} stone.`;
    }
    return null;
  }

  place(kind: Kind, gx: number, gz: number, rot: number): string | null {
    const err = this.canPlace(kind, gx, gz, rot, false);
    if (err) return err;
    const info = CATALOG[kind];
    this.resources.wood -= info.wood;
    this.resources.stone -= info.stone;
    const cells = cellsFor(kind, gx, gz, rot);
    let bonus = 0;
    for (const tree of this.trees) {
      if (tree.hp <= 0) continue;
      if (cells.some((c) => c.gx === tree.gx && c.gz === tree.gz)) {
        tree.hp = 0;
        bonus += 1;
        this.treeRev++;
      }
    }
    this.resources.wood += bonus;
    this.stamp(kind, gx, gz, rot);
    if (kind === 'house') this.logMsg('A new roof takes the wind.');
    else if (kind === 'farm') this.logMsg('Another strip of the fold is turned.');
    else if (kind === 'mill') this.logMsg('The sails go up over the saddle.');
    else if (kind === 'woodcamp') this.logMsg('Axes ring against the treeline.');
    else if (kind === 'quarry') this.logMsg('They cut into the bone of the ridge.');
    this.assignJobs();
    return null;
  }

  demolish(id: number): string | null {
    const b = this.byId.get(id);
    if (!b) return 'Nothing there.';
    if (b.kind === 'hall') return 'The hall is the fold.';
    const info = CATALOG[b.kind];
    this.resources.wood += Math.floor(info.wood * 0.5);
    this.resources.stone += Math.floor(info.stone * 0.5);
    this.removeBuilding(b, false);
    this.logMsg(`${info.name} comes down. Half the timber returns.`);
    return null;
  }

  buildingAt(gx: number, gz: number): Building | null {
    if (!inBounds(gx, gz)) return null;
    const id = this.occupancy[idx(gx, gz)];
    return id ? (this.byId.get(id) ?? null) : null;
  }

  countKind(kind: Kind): number {
    let n = 0;
    for (const b of this.buildings) if (b.kind === kind) n++;
    return n;
  }

  beds(): number {
    let n = 0;
    for (const b of this.buildings) n += CATALOG[b.kind].beds;
    return n;
  }

  tierName(): string {
    const pop = this.villagers.length;
    const houses = this.countKind('house');
    const walls = this.countKind('wall');
    const mill = this.countKind('mill') > 0;
    if (pop >= 36 && walls >= 10 && mill) return 'Borough';
    if (pop >= 22 && houses >= 5) return 'Town';
    if (pop >= 10) return 'Village';
    return 'Hamlet';
  }

  isLinked(b: Building): boolean {
    if (b.kind === 'hall') return true;
    const cells = cellsFor(b.kind, b.gx, b.gz, b.rot);
    for (const c of cells) {
      if (b.kind === 'road' && this.roadLink[idx(c.gx, c.gz)]) return true;
      for (const [dx, dz] of DIRS) {
        const nx = c.gx + dx;
        const nz = c.gz + dz;
        if (!inBounds(nx, nz)) continue;
        if (this.roadLink[idx(nx, nz)]) return true;
      }
    }
    return false;
  }

  hall(): Building {
    const h = this.buildings.find((b) => b.kind === 'hall');
    if (!h) throw new Error('Ridgehold has no hall');
    return h;
  }

  setRaids(on: boolean): void {
    this.raidsEnabled = on;
    if (!on && this.raiders.length) {
      this.raiders = [];
      this.breach = 0;
      this.logMsg('The watch stands down. The valley is ignored.');
    }
  }

  private foundHamlet(): void {
    const site = this.findSite();
    const hw = CATALOG.hall.w;
    const hh = CATALOG.hall.h;
    const hx = site.gx - Math.floor(hw / 2);
    const hz = site.gz - Math.floor(hh / 2);
    this.stamp('hall', hx, hz, 0, true);
    const hall = this.hall();
    const { w, h } = dims(hall.kind, hall.rot);
    const spineX = hall.gx + Math.floor(w / 2);
    for (let i = 0; i < 8; i++) this.tryStamp('road', spineX, hall.gz + h + i);
    for (let i = 1; i <= 4; i++) this.tryStamp('road', spineX, hall.gz - i);
    this.tryStamp('house', spineX + 1, hall.gz + h);
    this.tryStamp('farm', spineX - 3, hall.gz + h);
    if (!this.buildings.some((b) => b.kind === 'house')) this.forceKind('house', spineX + 1, hall.gz + h);
    if (!this.buildings.some((b) => b.kind === 'farm')) this.forceKind('farm', spineX - 3, hall.gz + h + 1);
    for (let i = 0; i < 6; i++) this.spawnVillager();
    this.assignJobs();
  }

  private findSite(): GridPoint {
    let best: GridPoint = { gx: (COLS / 2) | 0, gz: (ROWS / 2) | 0 };
    let score = -1e9;
    for (let gz = 2; gz < ROWS - 2; gz++) {
      for (let gx = 2; gx < COLS - 2; gx++) {
        const i = idx(gx, gz);
        const h = this.cellH[i];
        const s = this.cellS[i];
        if (s > 0.4 || h < 8) continue;
        const flat = this.flatNeighbors(gx, gz);
        const sc = h * 2.2 + flat * 0.35 - s * 6 - Math.abs(gx - COLS / 2) * 0.18 - Math.abs(gz - ROWS / 2) * 0.04;
        if (sc > score) {
          score = sc;
          best = { gx, gz };
        }
      }
    }
    return best;
  }

  private flatNeighbors(gx: number, gz: number): number {
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inBounds(gx + dx, gz + dz)) continue;
        if (this.cellS[idx(gx + dx, gz + dz)] < 0.42) n++;
      }
    }
    return n;
  }

  private tryStamp(kind: Kind, gx: number, gz: number): boolean {
    for (let r = 0; r <= 8; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r !== 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const x = gx + dx;
          const z = gz + dz;
          if (this.canPlace(kind, x, z, 0, true) === null) {
            this.stamp(kind, x, z, 0, true);
            return true;
          }
        }
      }
    }
    return false;
  }

  private forceKind(kind: Kind, preferGx: number, preferGz: number): void {
    let best: GridPoint | null = null;
    let bestD = 1e9;
    const { w, h } = dims(kind, 0);
    for (let gz = 1; gz < ROWS - h - 1; gz++) {
      for (let gx = 1; gx < COLS - w - 1; gx++) {
        const cells = cellsFor(kind, gx, gz, 0);
        if (cells.some((c) => this.occupancy[idx(c.gx, c.gz)] || this.cellH[idx(c.gx, c.gz)] < 6.2)) continue;
        if (cells.some((c) => this.cellS[idx(c.gx, c.gz)] > 0.62)) continue;
        const d = Math.abs(gx - preferGx) + Math.abs(gz - preferGz);
        if (d < bestD) {
          bestD = d;
          best = { gx, gz };
        }
      }
    }
    if (best) this.stamp(kind, best.gx, best.gz, 0, true);
  }

  private stamp(kind: Kind, gx: number, gz: number, rot: number, bootstrap = false): Building {
    const info = CATALOG[kind];
    const b: Building = {
      id: this.nextId++,
      kind,
      gx,
      gz,
      rot,
      hp: info.hp,
      maxHp: info.hp,
      workerIds: [],
      growth: kind === 'farm' ? 0.72 : 0,
      noted: bootstrap,
    };
    this.buildings.push(b);
    this.byId.set(b.id, b);
    this.rebuildNav();
    return b;
  }

  private removeBuilding(b: Building, silent: boolean): void {
    this.buildings = this.buildings.filter((x) => x.id !== b.id);
    this.byId.delete(b.id);
    const hallId = this.hall().id;
    for (const v of this.villagers) {
      if (v.homeId === b.id) v.homeId = hallId;
      if (v.jobId === b.id) {
        v.jobId = null;
        v.path = null;
        v.routine = 'wander';
      }
    }
    if (this.selectedId === b.id) this.selectedId = null;
    this.rebuildNav();
    while (this.villagers.length > this.beds()) {
      const v = this.villagers.pop();
      if (v && !silent) this.logMsg('Without a roof, someone takes the valley road.');
    }
    this.assignJobs();
  }

  private rebuildNav(): void {
    this.occupancy.fill(0);
    for (const b of this.buildings) {
      for (const c of cellsFor(b.kind, b.gx, b.gz, b.rot)) {
        if (inBounds(c.gx, c.gz)) this.occupancy[idx(c.gx, c.gz)] = b.id;
      }
    }
    for (let gz = 0; gz < ROWS; gz++) {
      for (let gx = 0; gx < COLS; gx++) {
        const i = idx(gx, gz);
        const h = this.cellH[i];
        const s = this.cellS[i];
        const id = this.occupancy[i];
        let walk = BLOCK;
        let raid = 4 + s * 5;
        if (!id) {
          if (h >= 6.05 && s <= 0.8) walk = 4.4;
          else walk = BLOCK;
          raid = h < 2 ? 7 : 3.4 + s * 3;
        } else {
          const b = this.byId.get(id)!;
          if (b.kind === 'wall') {
            walk = BLOCK;
            raid = BLOCK;
          } else if (b.kind === 'road') {
            walk = 1;
            raid = 1.35;
          } else if (b.kind === 'farm') {
            walk = 2.3;
            raid = 2.1;
          } else {
            walk = BLOCK;
            raid = BLOCK;
          }
        }
        this.walkCost[i] = walk;
        this.raidCost[i] = raid;
      }
    }
    this.floodRoads();
    this.navRev++;
  }

  private floodRoads(): void {
    this.roadLink.fill(0);
    const hall = this.buildings.find((b) => b.kind === 'hall');
    if (!hall) return;
    const q: number[] = [];
    for (const c of cellsFor(hall.kind, hall.gx, hall.gz, hall.rot)) {
      const i = idx(c.gx, c.gz);
      this.roadLink[i] = 1;
      q.push(i);
    }
    for (let head = 0; head < q.length; head++) {
      const i = q[head];
      const gx = i % COLS;
      const gz = (i / COLS) | 0;
      for (const [dx, dz] of DIRS) {
        const nx = gx + dx;
        const nz = gz + dz;
        if (!inBounds(nx, nz)) continue;
        const ni = idx(nx, nz);
        if (this.roadLink[ni]) continue;
        const id = this.occupancy[ni];
        if (!id) continue;
        const kind = this.byId.get(id)?.kind;
        if (kind === 'road' || kind === 'hall') {
          this.roadLink[ni] = 1;
          q.push(ni);
        }
      }
    }
  }

  private economyTick(): void {
    if (this.raiders.length) {
      this.consume();
      return;
    }
    const season = seasonOf(this.day);
    for (const b of this.buildings) {
      const crew = b.workerIds.length;
      if (!crew || CATALOG[b.kind].slots <= 0) continue;
      const linked = this.isLinked(b);
      const link = linked ? 1 : 0.4;
      const crewFactor = Math.min(CATALOG[b.kind].slots, crew) === 1 ? 1 : 1.4;
      if (b.kind === 'farm') {
        let mill = 1;
        if (this.millHelps(b)) mill = 1.45;
        const gain = Math.max(1, Math.round(3 * seasonMult(season) * crewFactor * link * mill));
        this.resources.food += gain;
        const target = season === 'winter' ? 0.15 : season === 'spring' ? 0.62 : season === 'autumn' ? 0.78 : 1;
        b.growth += (target - b.growth) * 0.25;
      } else if (b.kind === 'mill') {
        if (linked) this.resources.food += 1;
      } else if (b.kind === 'woodcamp') {
        const tree = this.nearestTree(b, 7);
        if (!tree) {
          if (!this.quietWood.has(b.id)) {
            this.quietWood.add(b.id);
            this.logMsg('A woodcamp looks over a thinning treeline.');
          }
        } else {
          this.resources.wood += 2;
          tree.hp -= 1;
          if (tree.hp <= 0) {
            tree.hp = 0;
            this.resources.wood += 2;
            this.treeRev++;
          }
        }
      } else if (b.kind === 'quarry') {
        this.resources.stone += crewFactor > 1 ? 2 : 1;
      }
    }
    for (const b of this.buildings) {
      if (b.kind !== 'farm') continue;
      const target = seasonOf(this.day) === 'winter' ? 0.12 : 0.84;
      b.growth += (target - b.growth) * 0.08;
    }
    this.consume();
  }

  private consume(): void {
    const pop = this.villagers.length;
    if (!pop) return;
    this.foodFrac += pop * 0.48;
    const whole = Math.floor(this.foodFrac);
    this.foodFrac -= whole;
    this.resources.food = Math.max(0, this.resources.food - whole);
  }

  private millHelps(farm: Building): boolean {
    for (const m of this.buildings) {
      if (m.kind !== 'mill' || !m.workerIds.length) continue;
      if (!this.isLinked(m) || !this.isLinked(farm)) continue;
      const dist = Math.abs(m.gx - farm.gx) + Math.abs(m.gz - farm.gz);
      if (dist <= 14) return true;
    }
    return false;
  }

  private nearestTree(b: Building, radius: number): TreeSpawn | null {
    const { w, h } = dims(b.kind, b.rot);
    const c = footprintCenter(b.gx, b.gz, w, h);
    let best: TreeSpawn | null = null;
    let bestD = radius * CELL;
    for (const tree of this.trees) {
      if (tree.hp <= 0) continue;
      const d = Math.hypot(tree.x - c.x, tree.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = tree;
      }
    }
    return best;
  }

  private growAccTick(dt: number): void {
    if (this.raiders.length) return;
    if (this.resources.food <= 0) {
      this.hunger += dt;
      this.growAcc = 0;
      if (this.hunger > 20 && this.villagers.length > 3) {
        this.hunger = 0;
        this.villagers.pop();
        this.logMsg('The granary is bare. A household takes the valley road.');
        this.assignJobs();
      }
      return;
    }
    this.hunger = Math.max(0, this.hunger - dt * 0.4);
    if (this.resources.food > 36 && this.villagers.length < this.beds()) {
      this.growAcc += dt;
      if (this.growAcc > 24) {
        this.growAcc = 0;
        this.spawnVillager();
        this.assignJobs();
        this.logMsg('A new household climbs the ridge.');
      }
    } else {
      this.growAcc = Math.max(0, this.growAcc - dt * 0.35);
    }
  }

  private spawnVillager(): void {
    if (this.villagers.length >= this.beds()) return;
    const home = this.pickHome();
    if (!home) return;
    const approach = this.approachCell(worldToCell(0, 0), home) ?? cellsFor(home.kind, home.gx, home.gz, home.rot)[0];
    const p = cellCenter(approach.gx, approach.gz);
    const v: Villager = {
      id: this.nextAgent++,
      x: p.x,
      z: p.z,
      homeId: home.id,
      jobId: null,
      routine: 'wander',
      timer: 1,
      mode: 'idle',
      facing: Math.random() * Math.PI * 2,
      phase: Math.random() * 10,
      path: null,
      pathI: 0,
      pathRev: -1,
      wander: null,
    };
    this.villagers.push(v);
  }

  private pickHome(): Building | null {
    const homes = this.buildings.filter((b) => CATALOG[b.kind].beds > 0);
    let best: Building | null = null;
    let bestLoad = 1e9;
    for (const home of homes) {
      let n = 0;
      for (const v of this.villagers) if (v.homeId === home.id) n++;
      const load = n / CATALOG[home.kind].beds;
      if (n < CATALOG[home.kind].beds && load < bestLoad) {
        bestLoad = load;
        best = home;
      }
    }
    return best;
  }

  private assignJobs(): void {
    for (const b of this.buildings) b.workerIds = [];
    const pool = this.villagers.slice().sort((a, b) => a.id - b.id);
    const works = this.buildings.filter((b) => CATALOG[b.kind].slots > 0);
    for (const wp of works) {
      for (let s = 0; s < CATALOG[wp.kind].slots; s++) {
        let best = -1;
        let bestD = 1e9;
        const center = footprintCenter(wp.gx, wp.gz, dims(wp.kind, wp.rot).w, dims(wp.kind, wp.rot).h);
        for (let i = 0; i < pool.length; i++) {
          const d = Math.hypot(pool[i].x - center.x, pool[i].z - center.z);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (best < 0) break;
        const v = pool.splice(best, 1)[0];
        if (v.jobId !== wp.id) {
          v.jobId = wp.id;
          v.path = null;
          v.routine = 'toWork';
        }
        wp.workerIds.push(v.id);
      }
    }
    for (const v of pool) {
      if (v.jobId !== null) {
        v.jobId = null;
        v.path = null;
        v.routine = 'wander';
        v.timer = 0;
      }
    }
  }

  private dirtyAssign(): void {
    this.assignJobs();
  }

  private updateVillagers(dt: number): void {
    const raid = this.raiders.length > 0;
    for (const v of this.villagers) {
      v.phase += dt * (v.mode === 'walk' || v.mode === 'flee' ? 8.5 : v.mode === 'work' ? 6 : 2);
      if (raid) {
        const hall = this.hall();
        const arrived = this.walkToward(v, hall, dt, true);
        v.mode = arrived ? 'idle' : 'flee';
        v.routine = 'toHome';
        continue;
      }
      if (v.jobId && this.byId.has(v.jobId)) {
        const job = this.byId.get(v.jobId)!;
        if (v.routine === 'working') {
          v.timer -= dt;
          v.mode = 'work';
          const c = footprintCenter(job.gx, job.gz, dims(job.kind, job.rot).w, dims(job.kind, job.rot).h);
          v.facing = Math.atan2(c.x - v.x, c.z - v.z);
          if (v.timer <= 0) {
            v.routine = 'toHome';
            v.path = null;
          }
          continue;
        }
        if (v.routine === 'resting') {
          v.timer -= dt;
          v.mode = 'idle';
          if (v.timer <= 0) {
            v.routine = 'toWork';
            v.path = null;
          }
          continue;
        }
        if (v.routine === 'toHome') {
          const home = this.byId.get(v.homeId) ?? this.hall();
          const arrived = this.walkToward(v, home, dt, false);
          if (arrived) {
            v.routine = 'resting';
            v.timer = 2.1 + (v.id % 5) * 0.35;
            v.mode = 'idle';
          }
          continue;
        }
        const arrived = this.walkToward(v, job, dt, false);
        if (arrived) {
          v.routine = 'working';
          v.timer = 5.2 + (v.id % 4) * 0.4;
          v.mode = 'work';
        }
        continue;
      }
      if (!v.wander || v.timer <= 0) {
        v.wander = this.randomStroll(v);
        v.timer = 4.5 + (v.id % 5);
        v.path = null;
      }
      v.timer -= dt;
      if (v.wander) {
        const fake: Building = {
          id: -1,
          kind: 'road',
          gx: v.wander.gx,
          gz: v.wander.gz,
          rot: 0,
          hp: 1,
          maxHp: 1,
          workerIds: [],
          growth: 0,
          noted: true,
        };
        this.walkToward(v, fake, dt, false);
      }
    }
  }

  private randomStroll(v: Villager): GridPoint {
    const origin = worldToCell(v.x, v.z);
    for (let k = 0; k < 24; k++) {
      const gx = Math.max(0, Math.min(COLS - 1, origin.gx + Math.floor(Math.random() * 11) - 5));
      const gz = Math.max(0, Math.min(ROWS - 1, origin.gz + Math.floor(Math.random() * 11) - 5));
      if (this.walkCost[idx(gx, gz)] < 8) return { gx, gz };
    }
    return origin;
  }

  private walkToward(v: Villager, dest: Building, dt: number, flee: boolean): boolean {
    const from = worldToCell(v.x, v.z);
    if (this.walkCost[idx(from.gx, from.gz)] >= BLOCK) {
      const nudge = this.nearestWalkable(from);
      if (nudge) {
        const p = cellCenter(nudge.gx, nudge.gz);
        v.x = p.x;
        v.z = p.z;
      }
    }
    const goal = this.approachCell(worldToCell(v.x, v.z), dest);
    if (!goal) {
      v.mode = 'idle';
      return false;
    }
    const here = worldToCell(v.x, v.z);
    if (here.gx === goal.gx && here.gz === goal.gz && (!v.path || v.pathI >= v.path.length)) {
      v.mode = flee ? 'idle' : 'idle';
      return true;
    }
    if (!v.path || v.pathRev !== this.navRev || v.pathI >= v.path.length) {
      const start = worldToCell(v.x, v.z);
      v.path = findPath((gx, gz) => this.walkCost[idx(gx, gz)], start, goal);
      v.pathI = 0;
      v.pathRev = this.navRev;
      if (v.path && v.path.length && v.path[0].gx === start.gx && v.path[0].gz === start.gz) v.pathI = 1;
    }
    if (!v.path || v.pathI >= v.path.length) {
      v.mode = 'idle';
      return here.gx === goal.gx && here.gz === goal.gz;
    }
    const stepCell = v.path[v.pathI];
    const target = cellCenter(stepCell.gx, stepCell.gz);
    const ox = (((v.id * 17) % 5) - 2) * 0.07;
    const oz = (((v.id * 11) % 5) - 2) * 0.07;
    const tx = target.x + ox;
    const tz = target.z + oz;
    const dx = tx - v.x;
    const dz = tz - v.z;
    const dist = Math.hypot(dx, dz);
    const step = (flee ? 3.1 : 2.65) * dt;
    if (dist <= step + 0.001) {
      v.x = tx;
      v.z = tz;
      v.pathI++;
      if (v.pathI >= v.path.length) return true;
    } else if (dist > 0) {
      v.x += (dx / dist) * step;
      v.z += (dz / dist) * step;
      v.facing = Math.atan2(dx, dz);
      v.mode = flee ? 'flee' : 'walk';
    }
    return false;
  }

  private approachCell(from: GridPoint, b: Building): GridPoint | null {
    const cells = cellsFor(b.kind, b.gx, b.gz, b.rot);
    let best: GridPoint | null = null;
    let bestD = 1e9;
    const consider = (gx: number, gz: number) => {
      if (!inBounds(gx, gz)) return;
      if (this.walkCost[idx(gx, gz)] >= BLOCK) return;
      const d = Math.abs(gx - from.gx) + Math.abs(gz - from.gz);
      if (d < bestD) {
        bestD = d;
        best = { gx, gz };
      }
    };
    if (b.kind === 'farm' || b.kind === 'road') {
      for (const c of cells) consider(c.gx, c.gz);
    }
    for (const c of cells) {
      for (const [dx, dz] of DIRS) consider(c.gx + dx, c.gz + dz);
    }
    return best;
  }

  private nearestWalkable(from: GridPoint): GridPoint | null {
    if (inBounds(from.gx, from.gz) && this.walkCost[idx(from.gx, from.gz)] < BLOCK) return from;
    for (let r = 1; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const gx = from.gx + dx;
          const gz = from.gz + dz;
          if (!inBounds(gx, gz)) continue;
          if (this.walkCost[idx(gx, gz)] < BLOCK) return { gx, gz };
        }
      }
    }
    return null;
  }

  private updateRaids(dt: number): void {
    if (!this.raidsEnabled) return;
    if (!this.raiders.length && this.day >= this.nextRaidDay) {
      this.spawnRaid();
    } else if (!this.raiders.length && !this.warned && this.day >= this.nextRaidDay - 1.15) {
      this.warned = true;
      this.logMsg('Smoke in the cut. Something is climbing.');
    }
    if (!this.raiders.length) return;
    const hall = this.hall();
    const hc = footprintCenter(hall.gx, hall.gz, dims(hall.kind, hall.rot).w, dims(hall.kind, hall.rot).h);
    let threat = false;
    for (const r of this.raiders) {
      r.phase += dt * 8;
      const from = worldToCell(r.x, r.z);
      const goal = this.approachCellRaid(hall);
      if (goal && (!r.path || r.pathI >= r.path.length)) {
        r.path = findPath((gx, gz) => this.raidCost[idx(gx, gz)], from, goal);
        r.pathI = 0;
        if (r.path && r.path[0] && r.path[0].gx === from.gx && r.path[0].gz === from.gz) r.pathI = 1;
      }
      const wall = this.adjacentWall(from);
      const longWay = !r.path || r.path.length - r.pathI > 22;
      if (wall && (longWay || !r.path)) {
        wall.hp -= 16 * dt;
        r.stuck += dt;
        r.facing = Math.atan2(
          cellCenter(wall.gx, wall.gz).x - r.x,
          cellCenter(wall.gx, wall.gz).z - r.z,
        );
        if (wall.hp <= 0) {
          this.logMsg('A pale splinters.');
          this.removeBuilding(wall, true);
          r.path = null;
        }
        continue;
      }
      if (r.path && r.pathI < r.path.length) {
        const stepCell = r.path[r.pathI];
        const target = cellCenter(stepCell.gx, stepCell.gz);
        const dx = target.x - r.x;
        const dz = target.z - r.z;
        const dist = Math.hypot(dx, dz);
        const step = 1.72 * dt;
        if (dist <= step + 0.001) {
          r.x = target.x;
          r.z = target.z;
          r.pathI++;
        } else if (dist > 0) {
          r.x += (dx / dist) * step;
          r.z += (dz / dist) * step;
          r.facing = Math.atan2(dx, dz);
        }
        r.stuck = 0;
      } else {
        r.stuck += dt;
        const dx = hc.x - r.x;
        const dz = hc.z - r.z;
        const dist = Math.hypot(dx, dz) || 1;
        r.x += (dx / dist) * 1.2 * dt;
        r.z += (dz / dist) * 1.2 * dt;
        r.facing = Math.atan2(dx, dz);
      }
      if (Math.hypot(r.x - hc.x, r.z - hc.z) < 4.2) threat = true;
    }
    this.breach = threat ? this.breach + dt : Math.max(0, this.breach - dt);
    this.shotAcc += dt;
    if (this.shotAcc > 0.75 && this.villagers.length >= 5) {
      this.shotAcc = 0;
      const volleys = Math.max(1, Math.floor(this.villagers.length / 10));
      const targets = this.raiders
        .filter((r) => Math.hypot(r.x - hc.x, r.z - hc.z) < 18)
        .sort((a, b) => a.hp - b.hp);
      for (let i = 0; i < volleys && i < targets.length; i++) {
        targets[i].hp -= 8;
        this.shots.push({ x1: hc.x, z1: hc.z, x2: targets[i].x, z2: targets[i].z, life: 0.28 });
      }
    }
    const before = this.raiders.length;
    this.raiders = this.raiders.filter((r) => r.hp > 0);
    if (before && !this.raiders.length && this.breach < 3) {
      this.resources.stone += 4;
      this.logMsg('The valley turns back. The pales held.');
      this.finishRaid();
      return;
    }
    if (this.breach >= 3.1) {
      this.resources.food = Math.floor(this.resources.food * 0.82);
      this.resources.wood = Math.floor(this.resources.wood * 0.9);
      this.resources.stone = Math.floor(this.resources.stone * 0.92);
      const victim = this.buildings.find((b) => b.kind !== 'hall' && b.kind !== 'road');
      if (victim) {
        victim.hp -= 36;
        if (victim.hp <= 0) this.removeBuilding(victim, true);
      }
      this.raiders = [];
      this.logMsg('They reach the hall yard. Stores are lighter when they go.');
      this.finishRaid();
    }
  }

  private finishRaid(): void {
    this.breach = 0;
    this.warned = false;
    this.nextRaidDay = this.day + 8 + Math.random() * 5;
  }

  private spawnRaid(): void {
    const count = Math.min(10, 3 + Math.floor(this.villagers.length / 8));
    const east = Math.random() < 0.5;
    for (let i = 0; i < count; i++) {
      const gz = 2 + Math.floor(Math.random() * (ROWS - 4));
      let gx = east ? COLS - 2 : 1;
      for (let k = 0; k < COLS; k++) {
        const tryX = east ? COLS - 2 - k : k;
        if (this.raidCost[idx(tryX, gz)] < BLOCK) {
          gx = tryX;
          break;
        }
      }
      const p = cellCenter(gx, gz);
      this.raiders.push({
        id: this.nextAgent++,
        x: p.x + (Math.random() - 0.5),
        z: p.z + (Math.random() - 0.5) * 2,
        hp: 34,
        facing: east ? -Math.PI / 2 : Math.PI / 2,
        phase: Math.random() * 6,
        path: null,
        pathI: 0,
        stuck: 0,
      });
    }
    this.breach = 0;
    this.logMsg(east ? 'Raiders on the east cut.' : 'Raiders on the west cut.');
  }

  private approachCellRaid(b: Building): GridPoint | null {
    const cells = cellsFor(b.kind, b.gx, b.gz, b.rot);
    let best: GridPoint | null = null;
    let bestD = 1e9;
    for (const c of cells) {
      for (const [dx, dz] of DIRS) {
        const gx = c.gx + dx;
        const gz = c.gz + dz;
        if (!inBounds(gx, gz)) continue;
        if (this.raidCost[idx(gx, gz)] >= BLOCK) continue;
        const d = Math.abs(gx - (COLS / 2)) + Math.abs(gz - c.gz);
        if (d < bestD) {
          bestD = d;
          best = { gx, gz };
        }
      }
    }
    return best;
  }

  private adjacentWall(from: GridPoint): Building | null {
    let best: Building | null = null;
    let bestD = 1e9;
    for (const [dx, dz] of DIRS) {
      const gx = from.gx + dx;
      const gz = from.gz + dz;
      if (!inBounds(gx, gz)) continue;
      const b = this.buildingAt(gx, gz);
      if (b?.kind === 'wall') {
        const d = Math.abs(dx) + Math.abs(dz);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
    }
    return best;
  }

  private updateSeason(): void {
    const next = seasonOf(this.day);
    if (next === this.season) return;
    this.season = next;
    if (next === 'spring') this.logMsg('Spring thaw. The fold greens.');
    else if (next === 'summer') this.logMsg('Summer. The sails work for their keep.');
    else if (next === 'autumn') this.logMsg('Autumn light. Bring the grain in.');
    else this.logMsg('Winter. The fields sleep. Count the granary.');
  }

  private checkTier(): void {
    const next = this.tierName();
    if (next === this.tier) return;
    this.tier = next;
    this.logMsg(`Word on the road: Ridgehold is a ${next.toLowerCase()}.`);
  }

  private checkAims(): void {
    for (const aim of AIM_DEFS) {
      if (this.aimsDone.includes(aim.id)) continue;
      if (aim.met(this)) {
        this.aimsDone.push(aim.id);
        this.logMsg(`Kept: ${aim.text.toLowerCase()}.`);
      }
    }
  }

  private buildableCount(): number {
    let n = 0;
    for (let i = 0; i < this.cellH.length; i++) {
      if (this.cellH[i] >= 6.15 && this.cellS[i] <= 0.56) n++;
    }
    return n;
  }

  private logMsg(text: string): void {
    this.log.unshift(text);
    if (this.log.length > 32) this.log.pop();
  }
}
