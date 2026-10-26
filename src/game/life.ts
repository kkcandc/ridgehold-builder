import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { planHauls, type HaulRoute } from './haul';
import { sampleHeight } from './terrain';
import type { GameState } from './state';

const CARTS = 3;
const BIRDS = 6;
const PUFFS = 40;

export interface SmokeSource {
  x: number;
  y: number;
  z: number;
  tone: 'hearth' | 'work' | 'dust';
}

export interface LifeSample {
  reduced: boolean;
  flap: number;
  carts: Array<{ x: number; z: number }>;
}

interface CartRun {
  route: HaulRoute;
  dist: number;
  dir: 1 | -1;
  pause: number;
  length: number;
  x: number;
  z: number;
}

export class SettlementLife {
  private readonly reduced: boolean;
  private readonly flap = { value: 1 };
  private readonly carts: Array<CartRun | null> = Array.from({ length: CARTS }, () => null);
  private readonly cartBody: THREE.InstancedMesh;
  private readonly birds: THREE.InstancedMesh;
  private readonly smoke: THREE.Points;
  private readonly smokePos: THREE.BufferAttribute;
  private readonly smokeCol: THREE.BufferAttribute;
  private readonly puffLife = new Float32Array(PUFFS);
  private readonly puffMax = new Float32Array(PUFFS);
  private readonly puffSeed = new Float32Array(PUFFS);
  private readonly puffOx = new Float32Array(PUFFS);
  private readonly puffOy = new Float32Array(PUFFS);
  private readonly puffOz = new Float32Array(PUFFS);
  private readonly puffSet = new Uint8Array(PUFFS);
  private readonly dummy = new THREE.Object3D();
  private readonly cartMatrix = new THREE.Matrix4();
  private navStamp = -1;
  private flockT = 0.6;
  private flockHeld = false;

  constructor(scene: THREE.Scene, reduced: boolean, _time: { value: number }) {
    this.reduced = reduced;
    this.flap.value = reduced ? 0 : 1;

    this.cartBody = new THREE.InstancedMesh(cartBodyGeometry(), cartMaterial(), CARTS);
    this.cartBody.castShadow = false;
    this.cartBody.frustumCulled = false;

    const birdGeo = birdGeometry();
    const birdMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    this.birds = new THREE.InstancedMesh(birdGeo, birdMat, BIRDS);
    this.birds.frustumCulled = false;
    for (let i = 0; i < BIRDS; i++) {
      this.birds.setColorAt(i, new THREE.Color(i % 3 === 0 ? 0xe4dcc8 : 0x2c2824));
    }
    if (this.birds.instanceColor) this.birds.instanceColor.needsUpdate = true;

    const smokeGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(PUFFS * 3);
    const col = new Float32Array(PUFFS * 3);
    for (let i = 0; i < PUFFS; i++) {
      pos[i * 3 + 1] = -40;
      this.puffLife[i] = Math.random();
      this.puffMax[i] = 2.2 + Math.random() * 1.8;
      this.puffSeed[i] = Math.random() * Math.PI * 2;
    }
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    smokeGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const smokeMat = new THREE.PointsMaterial({
      size: 0.58,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.smoke = new THREE.Points(smokeGeo, smokeMat);
    this.smoke.frustumCulled = false;
    this.smokePos = smokeGeo.getAttribute('position') as THREE.BufferAttribute;
    this.smokeCol = smokeGeo.getAttribute('color') as THREE.BufferAttribute;

    scene.add(this.cartBody, this.birds, this.smoke);
    this.hideCarts();
  }

  reset(): void {
    this.navStamp = -1;
    this.flockHeld = false;
    this.flockT = 0.6;
    for (let i = 0; i < CARTS; i++) this.carts[i] = null;
    this.puffSet.fill(0);
    this.hideCarts();
  }

  sample(): LifeSample {
    return {
      reduced: this.reduced,
      flap: this.flap.value,
      carts: this.carts.filter((cart): cart is CartRun => cart !== null).map((cart) => ({ x: cart.x, z: cart.z })),
    };
  }

  update(state: GameState, dt: number, seed: number, sources: SmokeSource[], focus: { x: number; y: number; z: number }): void {
    this.updateCarts(state, dt, seed);
    this.updateBirds(dt, focus);
    this.updateSmoke(dt, sources);
  }

  private updateCarts(state: GameState, dt: number, seed: number): void {
    if (this.navStamp !== state.navRev) {
      this.navStamp = state.navRev;
      const routes = planHauls(state);
      for (let i = 0; i < CARTS; i++) {
        const route = routes[i];
        if (!route) {
          this.carts[i] = null;
          continue;
        }
        const length = polylineLength(route.points);
        const previous = this.carts[i];
        const keep = previous !== null && previous.route.targetId === route.targetId;
        this.carts[i] = {
          route,
          dist: keep ? Math.min(previous.dist, length) : length * (this.reduced ? 0.9 : 0.1 + i * 0.05),
          dir: keep ? previous.dir : 1,
          pause: keep ? previous.pause : 0,
          length,
          x: previous?.x ?? route.points[0].x,
          z: previous?.z ?? route.points[0].z,
        };
      }
    }

    const motion = this.reduced ? 0 : dt;
    for (let i = 0; i < CARTS; i++) {
      const cart = this.carts[i];
      if (!cart) {
        this.parkHidden(i);
        continue;
      }
      if (motion > 0 && cart.pause > 0) cart.pause = Math.max(0, cart.pause - motion);
      else if (motion > 0) {
        cart.dist += cart.dir * motion * 0.76;
        if (cart.dist >= cart.length) {
          cart.dist = cart.length;
          cart.dir = -1;
          cart.pause = 1.15;
        } else if (cart.dist <= 0) {
          cart.dist = 0;
          cart.dir = 1;
          cart.pause = 0.9;
        }
      }
      const at = pointAlong(cart.route.points, cart.dist);
      cart.x = at.x;
      cart.z = at.z;
      const y = sampleHeight(at.x, at.z, seed);
      const facing = Math.atan2(at.dx, at.dz);
      this.dummy.position.set(at.x, y, at.z);
      this.dummy.rotation.order = 'XYZ';
      this.dummy.rotation.set(0, facing, 0);
      this.dummy.scale.setScalar(1.48);
      this.dummy.updateMatrix();
      this.cartMatrix.copy(this.dummy.matrix);
      this.cartBody.setMatrixAt(i, this.cartMatrix);
    }
    this.cartBody.instanceMatrix.needsUpdate = true;
  }

  private parkHidden(index: number): void {
    this.dummy.position.set(0, -80, 0);
    this.dummy.scale.setScalar(0.001);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.updateMatrix();
    this.cartBody.setMatrixAt(index, this.dummy.matrix);
  }

  private hideCarts(): void {
    for (let i = 0; i < CARTS; i++) this.parkHidden(i);
    this.cartBody.instanceMatrix.needsUpdate = true;
  }

  private updateBirds(dt: number, focus: { x: number; y: number; z: number }): void {
    if (this.reduced && this.flockHeld) return;
    if (!this.reduced) this.flockT += dt * 0.32;
    const angle = this.flockT;
    const radius = 6.2 + Math.sin(this.flockT * 0.65) * (this.reduced ? 0 : 1.2);
    const tangent = angle + Math.PI / 2;
    const bank = this.reduced ? 0 : 0.42;
    for (let i = 0; i < BIRDS; i++) {
      const lane = i - (BIRDS - 1) / 2;
      const back = Math.abs(lane) * 0.62;
      const x = focus.x + Math.cos(angle) * (radius - back) + Math.cos(tangent) * lane * 0.9;
      const z = focus.z + Math.sin(angle) * (radius - back) + Math.sin(tangent) * lane * 0.9;
      const y = focus.y + 4.6 + (this.reduced ? 0 : Math.sin(this.flockT * 1.3 + i) * 0.22) - back * 0.08;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.order = 'YXZ';
      this.dummy.rotation.set(this.reduced ? 0 : Math.sin(this.flockT + i) * 0.08, tangent, bank);
      this.dummy.scale.set(1.7, 1.7, 1.7);
      this.dummy.updateMatrix();
      this.birds.setMatrixAt(i, this.dummy.matrix);
    }
    this.birds.instanceMatrix.needsUpdate = true;
    if (this.reduced) this.flockHeld = true;
  }

  private updateSmoke(dt: number, sources: SmokeSource[]): void {
    if (!sources.length) {
      for (let i = 0; i < PUFFS; i++) this.smokePos.setXYZ(i, 0, -40, 0);
      this.smokePos.needsUpdate = true;
      return;
    }
    for (let i = 0; i < PUFFS; i++) {
      const source = sources[i % sources.length];
      if (!this.puffSet[i]) {
        this.puffOx[i] = source.x;
        this.puffOy[i] = source.y;
        this.puffOz[i] = source.z;
        this.puffSet[i] = 1;
      }
      if (!this.reduced) this.puffLife[i] += dt * 0.34;
      if (!this.reduced && this.puffLife[i] >= this.puffMax[i]) {
        this.puffLife[i] = 0;
        this.puffMax[i] = 2.1 + (this.puffSeed[i] % 1) * 1.7;
        this.puffOx[i] = source.x;
        this.puffOy[i] = source.y;
        this.puffOz[i] = source.z;
      }
      const t = this.reduced ? (i % 8) / 8 : Math.min(1, this.puffLife[i] / this.puffMax[i]);
      const rise = source.tone === 'dust' ? 1.7 : 2.9;
      const sway = this.reduced ? 0 : Math.sin(this.puffSeed[i] + t * 5.2) * t * 0.42;
      const wash = this.reduced ? 0 : Math.cos(this.puffSeed[i] * 0.7 + t * 3.4) * t * 0.28;
      const ox = this.reduced ? source.x : this.puffOx[i];
      const oy = this.reduced ? source.y : this.puffOy[i];
      const oz = this.reduced ? source.z : this.puffOz[i];
      this.smokePos.setXYZ(i, ox + sway, oy + t * rise, oz + wash);
      const tone = source.tone === 'dust' ? [0.62, 0.5, 0.38] : source.tone === 'work' ? [0.78, 0.76, 0.7] : [0.9, 0.84, 0.74];
      this.smokeCol.setXYZ(i, tone[0], tone[1], tone[2]);
    }
    this.smokePos.needsUpdate = true;
    this.smokeCol.needsUpdate = true;
  }
}

function polylineLength(points: Array<{ x: number; z: number }>): number {
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    length += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return Math.max(0.001, length);
}

function pointAlong(points: Array<{ x: number; z: number }>, dist: number): { x: number; z: number; dx: number; dz: number } {
  let remain = dist;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (remain <= seg || i === points.length - 2) {
      const t = seg < 1e-5 ? 0 : Math.max(0, Math.min(1, remain / seg));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: b.x - a.x, dz: b.z - a.z };
    }
    remain -= seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, z: last.z, dx: 0, dz: 1 };
}

function painted(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const mesh = geo.index ? geo.toNonIndexed() : geo;
  if (mesh !== geo) geo.dispose();
  const tint = new THREE.Color(color);
  const count = mesh.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  mesh.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return mesh;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return painted(geo, color);
}

function cartBodyGeometry(): THREE.BufferGeometry {
  const parts = [
    box(0.78, 0.1, 1.2, 0, 0.38, 0, 0x7a5134),
    box(0.06, 0.22, 1.2, -0.36, 0.52, 0, 0x6a432c),
    box(0.06, 0.22, 1.2, 0.36, 0.52, 0, 0x6a432c),
    box(0.72, 0.2, 0.06, 0, 0.5, 0.57, 0x5c3b28),
    box(0.5, 0.32, 0.5, 0, 0.66, -0.06, 0xf3e6c8),
    box(0.06, 0.06, 0.62, 0, 0.36, 0.88, 0x3a2c22),
    box(0.1, 0.28, 0.1, -0.06, 0.42, 1.02, 0x2c2622),
    box(0.1, 0.28, 0.1, 0.06, 0.42, 1.02, 0x2c2622),
    box(0.22, 0.28, 0.14, 0, 0.68, 1.02, 0x8d3d36),
    box(0.16, 0.14, 0.14, 0, 0.88, 1.02, 0xd2ae8e),
    box(0.2, 0.1, 0.16, 0, 0.96, 1.0, 0x8d3d36),
    wheel(-0.42, 0.36),
    wheel(0.42, 0.36),
    wheel(-0.42, -0.36),
    wheel(0.42, -0.36),
  ];
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('cart geometry failed');
  return merged;
}

function wheel(x: number, z: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.18, 0.18, 0.08, 8);
  geo.rotateZ(Math.PI / 2);
  geo.translate(x, 0.2, z);
  return painted(geo, 0x241c16);
}

function cartMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ vertexColors: true });
}

function birdGeometry(): THREE.BufferGeometry {
  const body = painted(new THREE.BoxGeometry(0.12, 0.05, 0.46), 0xffffff);
  const left = new THREE.BoxGeometry(0.62, 0.02, 0.16);
  left.translate(-0.36, 0, 0.02);
  const right = new THREE.BoxGeometry(0.62, 0.02, 0.16);
  right.translate(0.36, 0, 0.02);
  const parts = [body, painted(left, 0xffffff), painted(right, 0xffffff)];
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('bird geometry failed');
  return merged;
}
