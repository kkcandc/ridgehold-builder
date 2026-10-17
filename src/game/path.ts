import { BLOCK, COLS, ROWS, type GridPoint, inBounds } from './config';

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function findPath(
  costAt: (gx: number, gz: number) => number,
  start: GridPoint,
  goal: GridPoint,
): GridPoint[] | null {
  if (!inBounds(start.gx, start.gz) || !inBounds(goal.gx, goal.gz)) return null;
  if (start.gx === goal.gx && start.gz === goal.gz) return [start];
  if (costAt(start.gx, start.gz) >= BLOCK || costAt(goal.gx, goal.gz) >= BLOCK) return null;

  const n = COLS * ROWS;
  const gScore = new Float64Array(n);
  gScore.fill(BLOCK);
  const prev = new Int32Array(n);
  prev.fill(-1);
  const open: number[] = [];
  const inOpen = new Uint8Array(n);
  const si = start.gz * COLS + start.gx;
  const gi = goal.gz * COLS + goal.gx;
  gScore[si] = 0;
  open.push(si);
  inOpen[si] = 1;

  const heur = (i: number) => Math.abs((i % COLS) - goal.gx) + Math.abs(((i / COLS) | 0) - goal.gz);

  while (open.length) {
    let bestI = 0;
    let bestF = gScore[open[0]] + heur(open[0]);
    for (let i = 1; i < open.length; i++) {
      const f = gScore[open[i]] + heur(open[i]);
      if (f < bestF) {
        bestF = f;
        bestI = i;
      }
    }
    const cur = open[bestI];
    open.splice(bestI, 1);
    inOpen[cur] = 0;
    if (cur === gi) break;
    const cx = cur % COLS;
    const cz = (cur / COLS) | 0;
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (!inBounds(nx, nz)) continue;
      const step = costAt(nx, nz);
      if (step >= BLOCK) continue;
      const ni = nz * COLS + nx;
      const next = gScore[cur] + step;
      if (next + 1e-6 < gScore[ni]) {
        gScore[ni] = next;
        prev[ni] = cur;
        if (!inOpen[ni]) {
          open.push(ni);
          inOpen[ni] = 1;
        }
      }
    }
  }

  if (gScore[gi] >= BLOCK / 2) return null;
  const path: GridPoint[] = [];
  let c = gi;
  let guard = 0;
  while (c !== -1 && guard++ < n + 2) {
    path.push({ gx: c % COLS, gz: (c / COLS) | 0 });
    if (c === si) break;
    c = prev[c];
  }
  path.reverse();
  if (path[0]?.gx !== start.gx || path[0]?.gz !== start.gz) return null;
  return path;
}
