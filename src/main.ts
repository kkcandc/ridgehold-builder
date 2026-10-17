import './style.css';
import { CATALOG, SAVE_KEY, TOOLS, cellCenter, dims, footprintCenter, worldToCell, type Kind } from './game/config';
import { sampleHeight } from './game/terrain';
import { World } from './game/render';
import { GameState } from './game/state';
import { mountHud, type Tool } from './game/ui';

const stage = document.querySelector('#stage') as HTMLElement;
const fail = document.querySelector('#fail') as HTMLElement;

const game: { state: GameState } = { state: loadState() ?? GameState.fresh() };
let world: World;
try {
  world = new World(stage);
} catch (error) {
  console.error(error);
  fail.hidden = false;
  throw error;
}

const resumed = Boolean(game.state.view);
world.mount(game.state, !resumed);
if (game.state.view) world.applyView(game.state.view);
if (resumed) {
  const epigraph = document.querySelector('#epigraph');
  if (epigraph) epigraph.remove();
}

let newArm = 0;
const hud = mountHud({
  onTool(tool) {
    hud.tool = hud.tool === tool ? null : tool;
    hud.hideHint();
    if (!hud.tool) world.clearGhost();
  },
  onSpeed(speed) {
    game.state.speed = speed;
  },
  onRaids(on) {
    game.state.setRaids(on);
  },
  onSave() {
    persist(true);
  },
  onLoad() {
    const next = loadState();
    if (!next) {
      hud.toast('No ledger in this browser.');
      return;
    }
    adopt(next, false);
    hud.toast('The ledger opens.');
  },
  onNew() {
    const now = Date.now();
    if (now - newArm > 2600) {
      newArm = now;
      hud.toast('Click again to leave this ridge.');
      return;
    }
    newArm = 0;
    localStorage.removeItem(SAVE_KEY);
    adopt(GameState.fresh(), true);
    hud.toast('A new fold. The hall is raised.');
  },
  onDemolish() {
    if (game.state.selectedId == null) return;
    const err = game.state.demolish(game.state.selectedId);
    if (err) hud.toast(err);
  },
});
hud.speed = game.state.speed;

let hover: { x: number; z: number } | null = null;
let pointer = { x: 0, y: 0 };
let down = false;
let dragged = false;
let downX = 0;
let downY = 0;
let saveAcc = 0;

const clock = { last: performance.now() };

function frame(now: number): void {
  const raw = Math.min(0.25, (now - clock.last) / 1000);
  clock.last = now;
  game.state.tick(raw * game.state.speed);
  world.update(game.state, raw);
  const seenYield = new Map<number, number>();
  for (const gain of game.state.takeYields()) {
    const building = game.state.buildings.find((b) => b.id === gain.id);
    if (!building) continue;
    const { w, h } = dims(building.kind, building.rot);
    const spot = footprintCenter(building.gx, building.gz, w, h);
    const lift = sampleHeight(spot.x, spot.z, game.state.seed) + 2.2;
    const point = world.project(spot.x, lift, spot.z);
    if (!point) continue;
    const stack = seenYield.get(building.id) ?? 0;
    seenYield.set(building.id, stack + 1);
    hud.floater(`+${gain.amount}`, point.x, point.y - stack * 18, gain.resource);
  }
  hud.sync(game.state);
  saveAcc += raw;
  if (saveAcc > 22) {
    saveAcc = 0;
    persist(false);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => world.resize(stage.clientWidth, stage.clientHeight));
const observer = new ResizeObserver(() => world.resize(stage.clientWidth, stage.clientHeight));
observer.observe(stage);

world.dom.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  down = true;
  dragged = false;
  downX = event.clientX;
  downY = event.clientY;
  world.cancelIntro();
});
world.dom.addEventListener('pointermove', (event) => {
  pointer = { x: event.clientX, y: event.clientY };
  if (down && Math.hypot(event.clientX - downX, event.clientY - downY) > 6) dragged = true;
  hover = world.raycastTerrain(event.clientX, event.clientY);
  refreshGhost();
});
world.dom.addEventListener('pointerup', (event) => {
  if (event.button === 2) {
    hud.tool = null;
    world.clearGhost();
    hud.hideHint();
    return;
  }
  if (event.button !== 0) return;
  const wasDrag = dragged;
  down = false;
  if (!wasDrag) act(event.clientX, event.clientY);
});
world.dom.addEventListener('contextmenu', (event) => event.preventDefault());
world.dom.addEventListener('pointerleave', () => {
  hover = null;
  world.clearGhost();
  hud.hideHint();
});

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  const digit = TOOLS[Number(event.code.replace('Digit', '')) - 1];
  if (event.code.startsWith('Digit') && digit) {
    hud.tool = hud.tool === digit ? null : digit;
    refreshGhost();
    return;
  }
  if (event.code === 'KeyX') {
    hud.tool = hud.tool === 'demolish' ? null : 'demolish';
    world.clearGhost();
    hud.hideHint();
    return;
  }
  if (event.code === 'KeyR') {
    hud.rot = (hud.rot + 1) % 4;
    refreshGhost();
    return;
  }
  if (event.code === 'Escape') {
    hud.tool = null;
    game.state.selectedId = null;
    world.clearGhost();
    hud.hideHint();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    game.state.speed = game.state.speed === 0 ? 1 : 0;
    return;
  }
  if (event.code === 'Delete' || event.code === 'Backspace') {
    if (game.state.selectedId != null) {
      const err = game.state.demolish(game.state.selectedId);
      if (err) hud.toast(err);
    }
    return;
  }
  if (event.code === 'KeyF') {
    world.focusHall(game.state, false);
    return;
  }
  if (event.code === 'BracketRight') game.state.speed = Math.min(3, game.state.speed + 1);
  if (event.code === 'BracketLeft') game.state.speed = Math.max(0, game.state.speed - 1);
});

function refreshGhost(): void {
  if (!hud.tool || hud.tool === 'demolish' || !hover) {
    world.clearGhost();
    if (!hover || !hud.tool) hud.hideHint();
    if (hud.tool === 'demolish') hud.setHint('Pull down what stands here.', pointer.x, pointer.y, false);
    return;
  }
  const cell = worldToCell(hover.x, hover.z);
  const anchor = anchorOf(hud.tool, hud.rot, cell.gx, cell.gz);
  const err = game.state.canPlace(hud.tool, anchor.gx, anchor.gz, hud.rot);
  world.showGhost(hud.tool, hud.rot, anchor.gx, anchor.gz, err === null);
  const info = CATALOG[hud.tool];
  const { w, h } = dims(hud.tool, hud.rot);
  const cost = [info.wood ? `${info.wood} wood` : '', info.stone ? `${info.stone} stone` : ''].filter(Boolean).join(' · ');
  hud.setHint(err ?? `${info.name} ${w}×${h} · ${cost}`, pointer.x, pointer.y, err !== null);
}

function act(clientX: number, clientY: number): void {
  const hit = world.raycastTerrain(clientX, clientY);
  if (hud.tool === 'demolish') {
    const picked = world.raycastPick(clientX, clientY);
    const id = picked ?? (hit ? game.state.buildingAt(worldToCell(hit.x, hit.z).gx, worldToCell(hit.x, hit.z).gz)?.id : null);
    if (id == null) return;
    const err = game.state.demolish(id);
    if (err) hud.toast(err);
    return;
  }
  if (hud.tool && hit) {
    const cell = worldToCell(hit.x, hit.z);
    const anchor = anchorOf(hud.tool, hud.rot, cell.gx, cell.gz);
    const err = game.state.place(hud.tool, anchor.gx, anchor.gz, hud.rot);
    if (err) hud.toast(err);
    else world.nudge();
    refreshGhost();
    return;
  }
  const picked = world.raycastPick(clientX, clientY);
  if (picked != null) game.state.selectedId = picked;
  else if (hit) {
    const cell = worldToCell(hit.x, hit.z);
    game.state.selectedId = game.state.buildingAt(cell.gx, cell.gz)?.id ?? null;
  }
}

function anchorOf(kind: Kind, rot: number, gx: number, gz: number): { gx: number; gz: number } {
  const { w, h } = dims(kind, rot);
  return {
    gx: gx - Math.floor((w - 1) / 2),
    gz: gz - Math.floor((h - 1) / 2),
  };
}

function persist(announce: boolean): void {
  game.state.view = world.getView();
  game.state.speed = game.state.speed;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(game.state.toSave()));
    if (announce) hud.toast('The ledger is kept in this browser.');
  } catch (error) {
    console.error(error);
    if (announce) hud.toast('The ledger could not be kept.');
  }
}

function loadState(): GameState | null {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    return GameState.fromSave(JSON.parse(raw) as ReturnType<GameState['toSave']>);
  } catch (error) {
    console.error(error);
    return null;
  }
}

function adopt(next: GameState, intro: boolean): void {
  game.state = next;
  hud.tool = null;
  world.mount(next, intro);
  if (next.view && !intro) world.applyView(next.view);
  hud.speed = next.speed;
}

declare global {
  interface Window {
    __ridgehold?: {
      summary: () => ReturnType<GameState['summary']>;
      place: (kind: Kind, gx: number, gz: number) => string | null;
      resources: () => { wood: number; food: number; stone: number; pop: number };
      villagers: () => Array<{ x: number; z: number; mode: string }>;
      canPlace: (kind: Kind, gx: number, gz: number) => string | null;
      project: (gx: number, gz: number) => { x: number; y: number } | null;
      rayCell: (x: number, y: number) => { gx: number; gz: number } | null;
    };
  }
}

window.__ridgehold = {
  summary: () => game.state.summary(),
  place: (kind, gx, gz) => game.state.place(kind, gx, gz, 0),
  resources: () => ({
    wood: game.state.resources.wood,
    food: game.state.resources.food,
    stone: game.state.resources.stone,
    pop: game.state.villagers.length,
  }),
  villagers: () => game.state.villagers.map((v) => ({ x: v.x, z: v.z, mode: v.mode })),
  canPlace: (kind: Kind, gx: number, gz: number) => game.state.canPlace(kind, gx, gz, 0),
  project: (gx: number, gz: number) => {
    const spot = cellCenter(gx, gz);
    return world.project(spot.x, sampleHeight(spot.x, spot.z, game.state.seed) + 0.5, spot.z);
  },
  rayCell: (x: number, y: number) => {
    const hit = world.raycastTerrain(x, y);
    return hit ? worldToCell(hit.x, hit.z) : null;
  },
};
