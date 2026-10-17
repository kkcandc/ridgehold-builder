import { CATALOG, CELL, COLS, ROWS, TOOLS, cellCenter, timeLabel, type Kind } from './config';
import { AIMS, type GameState } from './state';
import { sampleHeight } from './terrain';

export type Tool = Kind | 'demolish' | null;

const ICONS: Record<string, string> = {
  road: '<svg viewBox="0 0 24 24"><path d="M4 16h16M7 8h10" stroke="#e0c48a" stroke-width="2"/><path d="M8 8v8M12 8v8M16 8v8" stroke="#cbb892" stroke-width="1.4"/></svg>',
  house: '<svg viewBox="0 0 24 24"><path d="M3 12 L12 4 L21 12 V20 H3 Z" fill="none" stroke="#e0c48a" stroke-width="1.6"/><rect x="10" y="14" width="4" height="6" fill="#8c3b3b"/></svg>',
  farm: '<svg viewBox="0 0 24 24"><path d="M4 18h16M6 18c1-6 2-8 3-8s2 2 3 8M12 18c1-7 2-9 3-9s2 2 3 9" fill="none" stroke="#d2b15a" stroke-width="1.5"/></svg>',
  mill: '<svg viewBox="0 0 24 24"><circle cx="12" cy="14" r="4" fill="none" stroke="#e0c48a" stroke-width="1.6"/><path d="M12 10 V3 M12 14 L19 8 M12 14 L5 20 M12 14 L18 19" stroke="#f0e6c8" stroke-width="1.4"/></svg>',
  wall: '<svg viewBox="0 0 24 24"><path d="M5 20 V8 L8 5 L11 8 V20 M13 20 V9 L16 6 L19 9 V20" fill="none" stroke="#c4a27a" stroke-width="1.6"/></svg>',
  woodcamp: '<svg viewBox="0 0 24 24"><path d="M4 16h8l2-4h6" fill="none" stroke="#c4a27a" stroke-width="1.6"/><path d="M6 16v-4h4v4" fill="none" stroke="#e0c48a" stroke-width="1.4"/></svg>',
  quarry: '<svg viewBox="0 0 24 24"><path d="M4 17 L9 8 L14 17 Z M12 17 L17 9 L22 17" fill="none" stroke="#d5d0c8" stroke-width="1.5"/></svg>',
  demolish: '<svg viewBox="0 0 24 24"><path d="M5 19 L19 5 M8 19h11" stroke="#e08a72" stroke-width="1.7"/></svg>',
};

export interface Hud {
  tool: Tool;
  rot: number;
  speed: number;
  toast(message: string): void;
  setHint(text: string, x: number, y: number, bad: boolean): void;
  hideHint(): void;
  sync(state: GameState): void;
  floater(text: string, x: number, y: number, kind: 'wood' | 'food' | 'stone'): void;
}

export function mountHud(
  handlers: {
    onTool: (tool: Tool) => void;
    onSpeed: (speed: number) => void;
    onRaids: (on: boolean) => void;
    onSave: () => void;
    onLoad: () => void;
    onNew: () => void;
    onDemolish: () => void;
  },
): Hud {
  const toolbar = document.querySelector('#toolbar') as HTMLElement;
  const hint = document.createElement('div');
  hint.id = 'hint';
  hint.hidden = true;
  document.body.appendChild(hint);

  for (const kind of TOOLS) {
    const info = CATALOG[kind];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'build';
    button.dataset.tool = kind;
    button.innerHTML = `${ICONS[kind]}<strong>${info.name}</strong><em>${info.hotkey} · ${costLine(info.wood, info.stone)}</em>`;
    button.addEventListener('click', () => handlers.onTool(kind));
    toolbar.append(button);
  }
  const demolish = document.createElement('button');
  demolish.type = 'button';
  demolish.className = 'build';
  demolish.dataset.tool = 'demolish';
  demolish.innerHTML = `${ICONS.demolish}<strong>Pull down</strong><em>X · half the timber back</em>`;
  demolish.addEventListener('click', () => handlers.onTool('demolish'));
  toolbar.append(demolish);

  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    button.addEventListener('click', () => handlers.onSpeed(Number(button.dataset.speed)));
  });
  document.querySelector('#btn-raids')?.addEventListener('click', () => {
    const button = document.querySelector('#btn-raids') as HTMLButtonElement;
    handlers.onRaids(button.getAttribute('aria-pressed') !== 'true');
  });
  document.querySelector('#btn-save')?.addEventListener('click', () => handlers.onSave());
  document.querySelector('#btn-load')?.addEventListener('click', () => handlers.onLoad());
  document.querySelector('#btn-new')?.addEventListener('click', () => handlers.onNew());
  document.querySelector('#inspect-demolish')?.addEventListener('click', () => handlers.onDemolish());

  const aims = document.querySelector('#aim-list') as HTMLElement;
  for (const aim of AIMS) {
    const li = document.createElement('li');
    li.dataset.aim = aim.id;
    li.textContent = aim.text;
    aims.append(li);
  }

  let toastTimer = 0;
  const prev = { wood: -1, food: -1, stone: -1, pop: -1 };
  let logSig = '';
  let mapAcc = 0;

  const hud: Hud = {
    tool: null,
    rot: 0,
    speed: 1,
    toast(message: string) {
      const el = document.querySelector('#toast') as HTMLElement;
      el.textContent = message;
      el.classList.add('show');
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
    },
    setHint(text: string, x: number, y: number, bad: boolean) {
      hint.hidden = false;
      hint.textContent = text;
      hint.classList.toggle('bad', bad);
      hint.style.left = `${Math.min(window.innerWidth - 250, x + 16)}px`;
      hint.style.top = `${Math.min(window.innerHeight - 48, y + 16)}px`;
    },
    hideHint() {
      hint.hidden = true;
    },
    floater(text: string, x: number, y: number, kind: 'wood' | 'food' | 'stone') {
      const el = document.createElement('span');
      el.className = `floater ${kind}`;
      el.textContent = text;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      document.body.appendChild(el);
      const drop = () => el.remove();
      el.addEventListener('animationend', drop);
      window.setTimeout(drop, 1100);
    },
    sync(state: GameState) {
      hud.speed = state.speed;
      setNum('#res-wood', Math.floor(state.resources.wood), prev, 'wood');
      setNum('#res-food', Math.floor(state.resources.food), prev, 'food');
      setNum('#res-stone', Math.floor(state.resources.stone), prev, 'stone');
      const pop = state.villagers.length;
      const popEl = document.querySelector('#res-pop .num') as HTMLElement;
      const popText = `${pop} / ${state.beds()}`;
      if (popEl.textContent !== popText) {
        if (prev.pop >= 0 && pop !== prev.pop) flash(document.querySelector('#res-pop') as HTMLElement, pop > prev.pop);
        popEl.textContent = popText;
        prev.pop = pop;
      }
      const clock = document.querySelector('#clock') as HTMLElement;
      clock.textContent = `${state.tierName()} · ${timeLabel(state.day)}`;
      const threat = document.querySelector('#threat') as HTMLElement;
      if (state.raiders.length) threat.textContent = 'Raiders on the cut';
      else if (!state.raidsEnabled) threat.textContent = 'The watch stands down';
      else if (state.day >= state.nextRaidDay - 1.15) threat.textContent = 'Smoke in the cut';
      else threat.textContent = 'The valley is quiet';
      const alarm = document.querySelector('#alarm') as HTMLElement;
      alarm.hidden = state.raiders.length === 0;
      document.body.classList.toggle('is-raid', state.raiders.length > 0);
      const raids = document.querySelector('#btn-raids') as HTMLButtonElement;
      raids.setAttribute('aria-pressed', state.raidsEnabled ? 'true' : 'false');
      raids.textContent = state.raidsEnabled ? 'Watching' : 'Watch off';
      document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
        button.classList.toggle('active', Number(button.dataset.speed) === state.speed);
      });
      document.querySelectorAll<HTMLButtonElement>('.build').forEach((button) => {
        const tool = button.dataset.tool;
        button.classList.toggle('active', tool === hud.tool);
        if (tool && tool !== 'demolish') {
          const info = CATALOG[tool as Kind];
          button.classList.toggle('poor', state.resources.wood < info.wood || state.resources.stone < info.stone);
        }
      });
      const sig = state.log.slice(0, 6).join('|');
      if (sig !== logSig) {
        logSig = sig;
        const list = document.querySelector('#log') as HTMLElement;
        list.innerHTML = state.log
          .slice(0, 6)
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('');
      }
      for (const aim of AIMS) {
        const li = aims.querySelector(`[data-aim="${aim.id}"]`);
        li?.classList.toggle('met', state.aimsDone.includes(aim.id));
      }
      const inspect = document.querySelector('#inspect') as HTMLElement;
      const selected = state.buildings.find((b) => b.id === state.selectedId);
      if (!selected) inspect.hidden = true;
      else {
        inspect.hidden = false;
        const info = CATALOG[selected.kind];
        (document.querySelector('#inspect-title') as HTMLElement).textContent = info.name;
        const linked = state.isLinked(selected);
        const lines = [
          info.blurb,
          `Condition ${Math.max(0, Math.ceil((selected.hp / selected.maxHp) * 100))}%.`,
          info.slots ? `Hands at work: ${selected.workerIds.length} / ${info.slots}.` : '',
          info.beds ? `Beds: ${info.beds}.` : '',
          selected.kind === 'hall' ? 'Every road is measured from here.' : linked ? 'A road reaches the hall.' : 'No road to the hall. Output is thin.',
        ].filter(Boolean);
        (document.querySelector('#inspect-body') as HTMLElement).textContent = lines.join(' ');
        const pull = document.querySelector('#inspect-demolish') as HTMLButtonElement;
        pull.hidden = selected.kind === 'hall';
      }
      mapAcc += 1;
      if (mapAcc % 20 === 0) drawMap(state);
    },
  };
  return hud;
}

function costLine(wood: number, stone: number): string {
  const parts = [];
  if (wood) parts.push(`${wood} wood`);
  if (stone) parts.push(`${stone} stone`);
  return parts.join(' · ') || 'already standing';
}

function setNum(selector: string, value: number, prev: { wood: number; food: number; stone: number }, key: 'wood' | 'food' | 'stone') {
  const root = document.querySelector(selector) as HTMLElement;
  const num = root.querySelector('.num') as HTMLElement;
  if (prev[key] >= 0 && value !== prev[key]) flash(root, value > prev[key]);
  num.textContent = String(value);
  prev[key] = value;
}

function flash(el: HTMLElement, up: boolean): void {
  el.classList.remove('up', 'down', 'bump');
  void el.offsetWidth;
  el.classList.add(up ? 'up' : 'down');
  if (up) el.classList.add('bump');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

const MAP_COLORS: Record<string, string> = {
  road: '#c4b08a',
  house: '#f0d7b0',
  farm: '#d2b15a',
  mill: '#f4efe2',
  wall: '#8d5a3a',
  woodcamp: '#6e8f4e',
  quarry: '#b7b2aa',
  hall: '#e07a45',
};

function drawMap(state: GameState): void {
  const canvas = document.querySelector('#minimap') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const image = ctx.createImageData(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = Math.min(COLS - 1, Math.floor((px / w) * COLS));
      const gz = Math.min(ROWS - 1, Math.floor((py / h) * ROWS));
      const { x, z } = cellCenter(gx, gz);
      const height = sampleHeight(x, z, state.seed);
      const t = Math.max(0, Math.min(1, (height - 1) / 12));
      const i = (py * w + px) * 4;
      image.data[i] = 40 + t * 90;
      image.data[i + 1] = 48 + t * 80;
      image.data[i + 2] = 36 + t * 30;
      image.data[i + 3] = 255;
      if (height < 1.4) {
        image.data[i] = 28;
        image.data[i + 1] = 58;
        image.data[i + 2] = 64;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  for (const building of state.buildings) {
    ctx.fillStyle = MAP_COLORS[building.kind] ?? '#fff';
    const bw = building.kind === 'hall' ? 3 : CATALOG[building.kind].w;
    const bh = building.kind === 'hall' ? 4 : CATALOG[building.kind].h;
    ctx.fillRect((building.gx / COLS) * w, (building.gz / ROWS) * h, Math.max(2, (bw / COLS) * w), Math.max(2, (bh / ROWS) * h));
  }
  ctx.fillStyle = '#f7f1e4';
  for (const villager of state.villagers) {
    const cell = {
      gx: Math.floor(villager.x / CELL + COLS / 2),
      gz: Math.floor(villager.z / CELL + ROWS / 2),
    };
    ctx.fillRect((cell.gx / COLS) * w, (cell.gz / ROWS) * h, 2, 2);
  }
  ctx.fillStyle = '#e05040';
  for (const raider of state.raiders) {
    const gx = Math.floor(raider.x / CELL + COLS / 2);
    const gz = Math.floor(raider.z / CELL + ROWS / 2);
    ctx.fillRect((gx / COLS) * w, (gz / ROWS) * h, 2, 2);
  }
}
