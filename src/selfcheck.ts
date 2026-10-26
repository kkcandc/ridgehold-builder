import { GameState } from './game/state';
import { worldToCell } from './game/config';
import { planHauls } from './game/haul';

const state = GameState.fresh(11);
const hauls = planHauls(state);
if (!hauls.length || hauls[0].points.length < 2) throw new Error('fresh ridge has no cart route');
const summary = state.summary();
console.log('fresh', JSON.stringify(summary));
if (!summary.buildings.includes('hall')) throw new Error('missing hall');
if (!summary.buildings.includes('house')) throw new Error('missing house');
if (!summary.buildings.includes('farm')) throw new Error('missing farm');
if (state.villagers.length < 4) throw new Error('too few villagers');
if (summary.buildable < 80) throw new Error(`ridge too narrow: ${summary.buildable}`);

const start = state.villagers.map((v) => ({ x: v.x, z: v.z, job: v.jobId, routine: v.routine }));
const food0 = state.resources.food;
const wood0 = state.resources.wood;
for (let i = 0; i < 50; i++) state.tick(0.4);

let moved = 0;
for (let i = 0; i < state.villagers.length; i++) {
  const v = state.villagers[i];
  const s = start[i];
  if (!s) continue;
  const d = Math.hypot(v.x - s.x, v.z - s.z);
  if (d > 0.45) moved++;
}
console.log('after 20s', JSON.stringify(state.summary()), 'moved', moved, 'food', state.resources.food, 'wood', state.resources.wood);
if (moved < 2) {
  console.log(
    state.villagers.map((v) => ({
      id: v.id,
      mode: v.mode,
      routine: v.routine,
      job: v.jobId,
      cell: worldToCell(v.x, v.z),
      path: v.path?.length ?? null,
      pathI: v.pathI,
    })),
  );
  throw new Error('villagers did not move');
}
if (state.resources.food === food0) throw new Error('food did not tick');

let placedRoad = false;
let placedHouse = false;
for (let gz = 0; gz < 36 && (!placedRoad || !placedHouse); gz++) {
  for (let gx = 0; gx < 48 && (!placedRoad || !placedHouse); gx++) {
    if (!placedRoad && state.canPlace('road', gx, gz, 0) === null) {
      const err = state.place('road', gx, gz, 0);
      if (err) throw new Error(err);
      placedRoad = true;
    } else if (!placedHouse && state.canPlace('house', gx, gz, 0) === null) {
      const err = state.place('house', gx, gz, 0);
      if (err) throw new Error(err);
      placedHouse = true;
    }
  }
}
if (!placedRoad || !placedHouse) throw new Error('could not place road and house');
if (state.resources.wood >= wood0) throw new Error('wood was not spent');

const save = state.toSave();
const loaded = GameState.fromSave(save);
if (!loaded) throw new Error('save failed');
if (loaded.villagers.length !== state.villagers.length) throw new Error('save lost people');
if (Math.round(loaded.resources.wood) !== Math.round(state.resources.wood)) throw new Error('save lost wood');

for (let i = 0; i < 30; i++) state.tick(0.5);
console.log('ok', JSON.stringify(state.summary()));
