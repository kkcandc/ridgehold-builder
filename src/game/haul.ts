import {
  BLOCK,
  DIRS,
  cellCenter,
  cellsFor,
  dims,
  footprintCenter,
  inBounds,
  idx,
  type GridPoint,
  type Kind,
} from './config';
import { findPath } from './path';
import type { Building, GameState } from './state';

const HAUL_KINDS: Kind[] = ['farm', 'woodcamp', 'mill', 'quarry'];

export interface HaulRoute {
  targetId: number;
  points: Array<{ x: number; z: number }>;
}

export function planHauls(state: GameState, limit = 3): HaulRoute[] {
  const hall = state.hall();
  const producers = state.buildings
    .filter((building) => HAUL_KINDS.includes(building.kind))
    .sort((a, b) => {
      const linked = Number(state.isLinked(b)) - Number(state.isLinked(a));
      if (linked) return linked;
      const order = HAUL_KINDS.indexOf(a.kind) - HAUL_KINDS.indexOf(b.kind);
      if (order) return order;
      return a.id - b.id;
    });
  const routes: HaulRoute[] = [];
  for (const target of producers) {
    if (routes.length >= limit) break;
    const points = routeBetween(state, hall, target);
    if (!points || points.length < 2) continue;
    routes.push({ targetId: target.id, points });
  }
  return routes;
}

function routeBetween(state: GameState, from: Building, to: Building): Array<{ x: number; z: number }> | null {
  const fromAt = centerOf(from);
  const toAt = centerOf(to);
  const start = approach(state, from, toAt);
  const goal = approach(state, to, fromAt);
  if (!start || !goal) return null;
  const path = findPath((gx, gz) => state.walkCost[idx(gx, gz)], start, goal);
  if (!path || path.length < 2) return null;
  return path.map((cell) => cellCenter(cell.gx, cell.gz));
}

function centerOf(building: Building): { x: number; z: number } {
  const { w, h } = dims(building.kind, building.rot);
  return footprintCenter(building.gx, building.gz, w, h);
}

function approach(state: GameState, building: Building, prefer: { x: number; z: number }): GridPoint | null {
  const cells = cellsFor(building.kind, building.gx, building.gz, building.rot);
  let best: GridPoint | null = null;
  let bestD = 1e9;
  const consider = (gx: number, gz: number) => {
    if (!inBounds(gx, gz)) return;
    if (state.walkCost[idx(gx, gz)] >= BLOCK) return;
    const at = cellCenter(gx, gz);
    const d = Math.abs(at.x - prefer.x) + Math.abs(at.z - prefer.z);
    if (d < bestD) {
      bestD = d;
      best = { gx, gz };
    }
  };
  if (building.kind === 'farm' || building.kind === 'road') {
    for (const cell of cells) consider(cell.gx, cell.gz);
  }
  for (const cell of cells) {
    for (const [dx, dz] of DIRS) consider(cell.gx + dx, cell.gz + dz);
  }
  return best;
}
