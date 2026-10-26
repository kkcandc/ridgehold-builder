import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CELL,
  COLS,
  ROWS,
  WORLD_D,
  WORLD_W,
  cellCenter,
  cellsFor,
  dims,
  footprintCenter,
  seasonOf,
  sunElevation,
  type Kind,
  type Season,
} from './config';
import type { Building, GameState } from './state';
import { sampleHeight, sampleSlope } from './terrain';
import { SettlementLife, type LifeSample, type SmokeSource } from './life';

const TUNICS = [0x8d3d36, 0x355e49, 0x3c4e78, 0x8a5a2c, 0x6d4560, 0xb7a37a, 0x4e5c38];

interface View {
  root: THREE.Group;
  windows: THREE.MeshStandardMaterial[];
  blades?: THREE.Object3D;
  banners: THREE.Object3D[];
  wheat?: THREE.InstancedMesh;
  chimney?: THREE.Vector3;
  baseRotX: number;
  baseRotZ: number;
  pick: THREE.Mesh;
  pop: number;
  groundY: number;
}

interface Mote {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
}

interface Grave {
  view: View;
  t: number;
  groundY: number;
}

function smokeTone(kind: Kind): SmokeSource['tone'] | null {
  if (kind === 'house' || kind === 'hall') return 'hearth';
  if (kind === 'farm' || kind === 'mill' || kind === 'woodcamp') return 'work';
  if (kind === 'quarry') return 'dust';
  return null;
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function easeOutBack(t: number): number {
  const c1 = 2.4;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function paint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function mat(color: number, roughness = 0.88, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function shade(color: number, seed: number, spread = 0.06): THREE.MeshStandardMaterial {
  const m = mat(color);
  const n = Math.sin(seed * 12.9898) * 43758.5453;
  const f = n - Math.floor(n);
  m.color.offsetHSL((f - 0.5) * 0.02, (f - 0.5) * 0.08, (f - 0.5) * spread);
  return m;
}

function gable(w: number, d: number, h: number, y0: number, material: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const len = Math.hypot(w / 2, h);
  const theta = Math.atan2(h, w / 2);
  const geo = new THREE.BoxGeometry(len, 0.1, d);
  const left = new THREE.Mesh(geo, material);
  left.position.set(-w / 4, y0 + h / 2, 0);
  left.rotation.z = theta;
  const right = new THREE.Mesh(geo, material);
  right.position.set(w / 4, y0 + h / 2, 0);
  right.rotation.z = -theta;
  left.castShadow = right.castShadow = true;
  left.receiveShadow = right.receiveShadow = true;
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, d * 1.02), material);
  ridge.position.set(0, y0 + h, 0);
  ridge.castShadow = true;
  g.add(left, right, ridge);
  return g;
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    const list = Array.isArray(material) ? material : [material];
    for (const entry of list) entry?.dispose();
  });
}

function makePerson(color: number, raider: boolean): THREE.Group {
  const g = new THREE.Group();
  const tunic = mat(color, 0.82);
  const skin = mat(raider ? 0xb08968 : 0xd2ae8e, 0.72);
  const cloth = mat(raider ? 0x5c1c1c : color, 0.9);
  const dark = mat(0x2c2622, 0.9);
  const hipL = new THREE.Group();
  const hipR = new THREE.Group();
  hipL.position.set(-0.07, 0.34, 0);
  hipR.position.set(0.07, 0.34, 0);
  const legGeo = new THREE.BoxGeometry(0.08, 0.3, 0.08);
  const legL = new THREE.Mesh(legGeo, dark);
  const legR = new THREE.Mesh(legGeo, dark);
  legL.position.y = -0.15;
  legR.position.y = -0.15;
  hipL.add(legL);
  hipR.add(legR);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.26, 2, 6), tunic);
  body.position.y = 0.62;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 7), skin);
  head.position.y = 0.96;
  head.castShadow = true;
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.22, 6), cloth);
  hood.position.y = 1.08;
  const arm = new THREE.Group();
  arm.position.set(0.16, 0.72, 0.02);
  const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.07), tunic);
  armMesh.position.y = -0.12;
  arm.add(armMesh);
  if (raider) {
    const spear = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.85, 0.04), mat(0x6b543c));
    spear.position.set(0.02, 0.15, 0.08);
    spear.rotation.x = 0.4;
    arm.add(spear);
  }
  g.add(hipL, hipR, body, head, hood, arm);
  g.userData.hipL = hipL;
  g.userData.hipR = hipR;
  g.userData.arm = arm;
  return g;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly dom: HTMLCanvasElement;

  private seed = 1;
  private terrain!: THREE.Mesh;
  private terrainColors!: THREE.BufferAttribute;
  private water!: THREE.Mesh;
  private skyMat!: THREE.ShaderMaterial;
  private starMat!: THREE.PointsMaterial;
  private sunLight: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sunOrb: THREE.Mesh;
  private moonOrb: THREE.Mesh;
  private uTime = { value: 0 };
  private views = new Map<number, View>();
  private picks: THREE.Mesh[] = [];
  private people = new Map<number, THREE.Group>();
  private raiderMeshes = new Map<number, THREE.Group>();
  private pines!: THREE.InstancedMesh;
  private broads!: THREE.InstancedMesh;
  private pineList: number[] = [];
  private broadList: number[] = [];
  private rocks!: THREE.InstancedMesh;
  private ghost = new THREE.Group();
  private ghostKey = '';
  private selectRing: THREE.Mesh;
  private shotLines: THREE.LineSegments;
  private fireflies: THREE.Points;
  private life!: SettlementLife;
  private smokeScratch = new THREE.Vector3();
  private smokeCache: SmokeSource[] = [];
  private smokeCacheRev = -1;
  private smokeCacheCount = -1;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private introActive = false;
  private introT = 0;
  private introFrom = new THREE.Vector3();
  private introTo = new THREE.Vector3();
  private frameDt = 0.016;
  private treeStamp = -1;
  private seasonStamp: Season | null = null;
  private roadStamp = -1;
  private dummy = new THREE.Object3D();
  private wheatMat: THREE.MeshStandardMaterial;
  private pineMat: THREE.MeshStandardMaterial;
  private broadMat: THREE.MeshStandardMaterial;
  private reduced = false;
  private quietSpawn = false;
  private graves: Grave[] = [];
  private motes: Mote[] = [];
  private motePos!: THREE.BufferAttribute;
  private moteCol!: THREE.BufferAttribute;
  private moteLife!: THREE.BufferAttribute;
  private motePoints!: THREE.Points;
  private ringPool: THREE.Mesh[] = [];
  private liveRings: Array<{ mesh: THREE.Mesh; t: number; life: number; spread: number }> = [];
  private kick = new THREE.Vector3();
  private appliedKick = new THREE.Vector3();
  private readonly moteCap = 96;

  constructor(stage: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(stage.clientWidth, stage.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.dom = this.renderer.domElement;
    stage.appendChild(this.dom);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.35, 420);
    this.camera.position.set(22, 18, 22);
    this.controls = new OrbitControls(this.camera, this.dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 86;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(0, 8, 0);

    this.scene.fog = new THREE.FogExp2('#d7c4a2', 0.008);
    this.scene.background = new THREE.Color('#9eb6d4');

    this.hemi = new THREE.HemisphereLight('#e7eef8', '#8a7048', 1.15);
    this.scene.add(this.hemi);
    this.sunLight = new THREE.DirectionalLight('#fff4dc', 3.4);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 90;
    this.sunLight.shadow.camera.left = -36;
    this.sunLight.shadow.camera.right = 36;
    this.sunLight.shadow.camera.top = 36;
    this.sunLight.shadow.camera.bottom = -36;
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.04;
    this.scene.add(this.sunLight, this.sunLight.target);
    this.fill = new THREE.DirectionalLight('#c5d4ea', 0.85);
    this.scene.add(this.fill);

    this.sunOrb = new THREE.Mesh(
      new THREE.SphereGeometry(4.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#ffe1a8', fog: false }),
    );
    this.moonOrb = new THREE.Mesh(
      new THREE.SphereGeometry(2.1, 12, 10),
      new THREE.MeshBasicMaterial({ color: '#d5deea', fog: false }),
    );
    this.scene.add(this.sunOrb, this.moonOrb);

    this.wheatMat = mat(0xc6a84a, 0.95);
    this.pineMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.broadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 });
    this.windify(this.pineMat);
    this.windify(this.broadMat);
    this.windify(this.wheatMat);

    this.selectRing = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 0.96, 4),
      new THREE.MeshBasicMaterial({ color: '#f0d7a0', side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    this.selectRing.rotation.x = -Math.PI / 2;
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);

    this.shotLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#f3ddb0', transparent: true, opacity: 0.85 }),
    );
    this.scene.add(this.shotLines);

    const flyGeo = new THREE.BufferGeometry();
    const flyPos = new Float32Array(36 * 3);
    for (let i = 0; i < 36; i++) {
      flyPos[i * 3] = (Math.random() - 0.5) * 34;
      flyPos[i * 3 + 1] = 8 + Math.random() * 3;
      flyPos[i * 3 + 2] = (Math.random() - 0.5) * 28;
    }
    flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
    this.fireflies = new THREE.Points(
      flyGeo,
      new THREE.PointsMaterial({ color: '#f1e2a8', size: 0.18, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.scene.add(this.fireflies);

    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.life = new SettlementLife(this.scene, this.reduced, this.uTime);
    this.setupJuice();
    this.buildSky();
    this.resize(stage.clientWidth, stage.clientHeight);
  }

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.dom.style.width = `${width}px`;
    this.dom.style.height = `${height}px`;
  }

  nudge(): void {
    if (this.reduced || this.introActive) return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.multiplyScalar(-0.34);
    dir.y += 0.07;
    this.kick.add(dir);
    if (this.kick.length() > 0.5) this.kick.setLength(0.5);
  }

  mount(state: GameState, intro: boolean): void {
    this.clearDynamic();
    this.quietSpawn = true;
    this.seed = state.seed;
    this.seasonStamp = null;
    this.roadStamp = -1;
    this.treeStamp = -1;
    this.buildTerrain(state);
    this.buildWater();
    this.buildForest(state);
    this.buildRocks();
    this.focusHall(state, intro);
  }

  cancelIntro(): void {
    if (!this.introActive) return;
    this.introActive = false;
    this.camera.position.copy(this.introTo);
    this.controls.enabled = true;
  }

  getView(): { px: number; py: number; pz: number; tx: number; ty: number; tz: number } {
    return {
      px: this.camera.position.x,
      py: this.camera.position.y,
      pz: this.camera.position.z,
      tx: this.controls.target.x,
      ty: this.controls.target.y,
      tz: this.controls.target.z,
    };
  }

  applyView(view: { px: number; py: number; pz: number; tx: number; ty: number; tz: number }): void {
    this.cancelIntro();
    this.camera.position.set(view.px, view.py, view.pz);
    this.controls.target.set(view.tx, view.ty, view.tz);
  }

  focusHall(state: GameState, intro: boolean): void {
    const hall = state.hall();
    const { w, h } = dims(hall.kind, hall.rot);
    const c = footprintCenter(hall.gx, hall.gz, w, h);
    const y = sampleHeight(c.x, c.z, this.seed);
    this.controls.target.set(c.x, y + 1.2, c.z);
    this.introTo.set(c.x + 11, y + 9.5, c.z + 13);
    this.introFrom.set(c.x + 22, y + 16, c.z + 24);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (intro && !reduce) {
      this.introActive = true;
      this.introT = 0;
      this.camera.position.copy(this.introFrom);
      this.controls.enabled = false;
    } else {
      this.introActive = false;
      this.camera.position.copy(this.introTo);
      this.controls.enabled = true;
    }
  }

  raycastTerrain(clientX: number, clientY: number): { x: number; z: number } | null {
    this.aim(clientX, clientY);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    if (!hits.length) return null;
    return { x: hits[0].point.x, z: hits[0].point.z };
  }

  project(x: number, y: number, z: number): { x: number; y: number } | null {
    const point = new THREE.Vector3(x, y, z);
    point.project(this.camera);
    if (point.z > 1) return null;
    const rect = this.dom.getBoundingClientRect();
    return {
      x: rect.left + (point.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-point.y * 0.5 + 0.5) * rect.height,
    };
  }

  raycastPick(clientX: number, clientY: number): number | null {
    this.aim(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.picks, false);
    if (!hits.length) return null;
    const id = hits[0].object.userData.pickId;
    return typeof id === 'number' ? id : null;
  }

  update(state: GameState, rawDt: number): void {
    this.uTime.value += rawDt;
    const season = seasonOf(state.day);
    const tod = state.day - Math.floor(state.day);
    this.updateSky(tod, season);
    if (this.seasonStamp !== season || this.roadStamp !== state.navRev) {
      this.paintTerrain(state, season);
      this.seasonStamp = season;
      this.roadStamp = state.navRev;
      this.tintTrees(season);
      this.wheatMat.color.set(season === 'winter' ? '#8d8458' : season === 'autumn' ? '#e0b45a' : '#d2b15a');
    }
    if (this.treeStamp !== state.treeRev) this.stampTrees(state);

    this.frameDt = rawDt;
    this.syncBuildings(state);
    this.quietSpawn = false;
    this.updateBuildFeel(rawDt);
    this.syncPeople(state);
    this.syncRaiders(state);
    this.syncSelection(state);
    this.syncShots(state);
    this.life.update(state, rawDt, this.seed, this.smokeSources(state), this.flockFocus(state));
    this.updateFireflies(tod, rawDt);

    if (this.introActive) {
      this.introT += rawDt;
      const k = smooth(this.introT / 3.3);
      this.camera.position.lerpVectors(this.introFrom, this.introTo, k);
      if (k >= 1) {
        this.introActive = false;
        this.controls.enabled = true;
      }
      this.appliedKick.set(0, 0, 0);
    } else {
      this.camera.position.sub(this.appliedKick);
    }
    this.controls.update();
    this.kick.multiplyScalar(Math.exp(-rawDt * 7.5));
    if (this.kick.lengthSq() < 1e-5) this.kick.set(0, 0, 0);
    if (!this.introActive) {
      this.camera.position.add(this.kick);
      this.appliedKick.copy(this.kick);
    }
    const target = this.controls.target;
    this.sunLight.target.position.copy(target);
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  private aim(clientX: number, clientY: number): void {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private buildSky(): void {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color('#6ea0d8') },
        uHorizon: { value: new THREE.Color('#f0d2a4') },
        uNadir: { value: new THREE.Color('#8a6a48') },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vPos;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uNadir;
        void main() {
          float h = normalize(vPos).y;
          vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.62, h));
          col = mix(uNadir, col, smoothstep(-0.35, 0.08, h));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 28, 18), this.skyMat);
    this.scene.add(sky);

    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(220 * 3);
    for (let i = 0; i < 220; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.45;
      const r = 180;
      starPos[i * 3] = Math.cos(theta) * Math.cos(phi) * r;
      starPos[i * 3 + 1] = Math.sin(phi) * r + 10;
      starPos[i * 3 + 2] = Math.sin(theta) * Math.cos(phi) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({ color: '#f4f7ff', size: 0.85, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.scene.add(new THREE.Points(starGeo, this.starMat));
  }

  private buildTerrain(state: GameState): void {
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      (this.terrain.material as THREE.Material).dispose();
    }
    const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, 128, 96);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, sampleHeight(x, z, this.seed));
    }
    geo.computeVertexNormals();
    const colors = new Float32Array(pos.count * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.terrainColors = geo.getAttribute('color') as THREE.BufferAttribute;
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
    this.terrain = new THREE.Mesh(geo, material);
    this.terrain.receiveShadow = true;
    this.terrain.name = 'terrain';
    this.scene.add(this.terrain);
    this.paintTerrain(state, seasonOf(state.day));
    this.seasonStamp = seasonOf(state.day);
    this.roadStamp = state.navRev;
  }

  private paintTerrain(state: GameState, season: Season): void {
    const pos = this.terrain.geometry.attributes.position;
    const roads = state.buildings.filter((b) => b.kind === 'road' || b.kind === 'hall' || b.kind === 'farm');
    const color = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const slope = sampleSlope(x, z, this.seed);
      const n = ((Math.sin(x * 12.2) + Math.cos(z * 9.4)) * 0.5 + 1) * 0.5;
      const grass =
        season === 'spring' ? '#86b154' : season === 'summer' ? '#5f8d3c' : season === 'autumn' ? '#b08a3e' : '#8d977c';
      color.set(grass);
      color.lerp(new THREE.Color('#7c746b'), smooth((slope - 0.45) / 0.6));
      if (y < 4.4) color.lerp(new THREE.Color('#6b5436'), smooth((4.4 - y) / 2.4));
      if (season === 'winter') {
        const snow = smooth((y - 7.4) / 2.8) * (1 - smooth((slope - 0.25) / 0.6));
        color.lerp(new THREE.Color('#e7eef2'), snow);
      }
      color.offsetHSL(0, 0, (n - 0.5) * 0.07);
      for (const road of roads) {
        const d = dims(road.kind, road.rot);
        const c = footprintCenter(road.gx, road.gz, d.w, d.h);
        const reach = road.kind === 'road' ? 1.15 : Math.max(d.w, d.h) * CELL * 0.42;
        if (Math.hypot(x - c.x, z - c.z) < reach) {
          color.lerp(new THREE.Color(road.kind === 'farm' ? '#6a4a30' : '#6d5840'), road.kind === 'road' ? 0.55 : 0.28);
          break;
        }
      }
      this.terrainColors.setXYZ(i, color.r, color.g, color.b);
    }
    this.terrainColors.needsUpdate = true;
  }

  private buildWater(): void {
    if (this.water) {
      this.scene.remove(this.water);
      this.water.geometry.dispose();
      (this.water.material as THREE.Material).dispose();
    }
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.uTime },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          float w = sin(vUv.x * 46.0 + uTime * 0.8) * sin(vUv.y * 32.0 - uTime * 0.6);
          vec3 deep = vec3(0.12, 0.24, 0.28);
          vec3 glaze = vec3(0.55, 0.72, 0.68);
          float shore = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
          vec3 col = mix(deep, glaze, 0.32 + w * 0.12);
          gl_FragColor = vec4(col, 0.62 * (0.75 + shore * 0.25));
        }
      `,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W * 1.35, WORLD_D * 1.35), material);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 1.25;
    this.scene.add(this.water);
  }

  private treeGeometry(kind: 'pine' | 'broad'): THREE.BufferGeometry {
    const trunk = new THREE.CylinderGeometry(0.07, 0.12, 0.5, 5).toNonIndexed();
    trunk.translate(0, 0.25, 0);
    paint(trunk, new THREE.Color('#5b4030'));
    const leaf =
      kind === 'pine'
        ? new THREE.ConeGeometry(0.52, 1.28, 6).toNonIndexed()
        : new THREE.IcosahedronGeometry(0.46, 0);
    leaf.translate(0, kind === 'pine' ? 1.05 : 0.92, 0);
    paint(leaf, new THREE.Color(kind === 'pine' ? '#2d5536' : '#3f6a3c'));
    const merged = mergeGeometries([trunk, leaf]);
    trunk.dispose();
    leaf.dispose();
    if (!merged) throw new Error('tree geometry failed');
    return merged;
  }

  private windify(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 iPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 iPos = vec3(0.0);
          #endif
          float sway = sin(uTime * 1.35 + iPos.x * 0.17 + iPos.z * 0.11 + position.y) * pow(max(position.y, 0.0), 1.1) * 0.055;
          transformed.x += sway;
          transformed.z += sway * 0.32;`,
        );
    };
  }

  private buildForest(state: GameState): void {
    if (this.pines) {
      this.scene.remove(this.pines);
      this.pines.geometry.dispose();
    }
    if (this.broads) {
      this.scene.remove(this.broads);
      this.broads.geometry.dispose();
    }
    this.pineList = [];
    this.broadList = [];
    state.trees.forEach((tree, index) => {
      if (tree.variant === 0) this.pineList.push(index);
      else this.broadList.push(index);
    });
    this.pines = new THREE.InstancedMesh(this.treeGeometry('pine'), this.pineMat, Math.max(1, this.pineList.length));
    this.broads = new THREE.InstancedMesh(this.treeGeometry('broad'), this.broadMat, Math.max(1, this.broadList.length));
    this.pines.castShadow = this.broads.castShadow = true;
    this.pines.receiveShadow = this.broads.receiveShadow = true;
    this.scene.add(this.pines, this.broads);
    this.stampTrees(state);
    this.tintTrees(seasonOf(state.day));
  }

  private stampTrees(state: GameState): void {
    const place = (mesh: THREE.InstancedMesh, list: number[]) => {
      list.forEach((treeIndex, i) => {
        const tree = state.trees[treeIndex];
        const y = sampleHeight(tree.x, tree.z, this.seed);
        const alive = tree.hp > 0;
        this.dummy.position.set(tree.x, alive ? y : y - 1, tree.z);
        this.dummy.rotation.set(0, tree.rot, 0);
        this.dummy.scale.setScalar(alive ? tree.scale : 0.001);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
      });
      mesh.count = list.length;
      mesh.visible = list.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(this.pines, this.pineList);
    place(this.broads, this.broadList);
    this.treeStamp = state.treeRev;
  }

  private tintTrees(season: Season): void {
    const tint = season === 'autumn' ? '#e4b06a' : season === 'winter' ? '#c5cfc8' : season === 'spring' ? '#d5e7b8' : '#ffffff';
    this.pineMat.color.set(tint);
    this.broadMat.color.set(season === 'autumn' ? '#f0c27a' : tint);
  }

  private buildRocks(): void {
    if (this.rocks) {
      this.scene.remove(this.rocks);
      this.rocks.geometry.dispose();
    }
    const spots: Array<{ x: number; z: number; s: number; r: number }> = [];
    for (let gz = 0; gz < ROWS; gz += 1) {
      for (let gx = 0; gx < COLS; gx += 1) {
        const { x, z } = cellCenter(gx, gz);
        const y = sampleHeight(x, z, this.seed);
        const slope = sampleSlope(x, z, this.seed);
        const roll = Math.abs(Math.sin(gx * 13.2 + gz * 7.7 + this.seed));
        if (slope < 0.72 || y < 2 || y > 9.5 || roll > 0.42) continue;
        spots.push({ x, z, s: 0.35 + roll * 0.9, r: roll * 6 });
      }
    }
    const geo = new THREE.DodecahedronGeometry(0.55, 0);
    const material = mat(0x8a847c, 0.95);
    this.rocks = new THREE.InstancedMesh(geo, material, Math.max(1, spots.length));
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    spots.forEach((spot, i) => {
      const y = sampleHeight(spot.x, spot.z, this.seed);
      this.dummy.position.set(spot.x, y + 0.15, spot.z);
      this.dummy.rotation.set(spot.r, spot.r * 0.5, spot.r * 0.2);
      this.dummy.scale.setScalar(spot.s);
      this.dummy.updateMatrix();
      this.rocks.setMatrixAt(i, this.dummy.matrix);
    });
    this.rocks.count = Math.max(1, spots.length);
    this.rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(this.rocks);
  }

  private clearDynamic(): void {
    for (const grave of this.graves) this.finishGrave(grave);
    this.graves = [];
    this.motes = [];
    for (const ring of this.liveRings) ring.mesh.visible = false;
    this.liveRings = [];
    this.kick.set(0, 0, 0);
    this.appliedKick.set(0, 0, 0);
    for (const id of [...this.views.keys()]) this.removeView(id);
    for (const mesh of this.people.values()) {
      this.scene.remove(mesh);
      disposeTree(mesh);
    }
    for (const mesh of this.raiderMeshes.values()) {
      this.scene.remove(mesh);
      disposeTree(mesh);
    }
    this.people.clear();
    this.raiderMeshes.clear();
    this.picks = [];
    this.life.reset();
    this.smokeCacheRev = -1;
  }

  lifeSample(): LifeSample {
    return this.life.sample();
  }

  private syncBuildings(state: GameState): void {
    const alive = new Set(state.buildings.map((b) => b.id));
    for (const id of this.views.keys()) {
      if (alive.has(id)) continue;
      const view = this.views.get(id);
      if (!view) continue;
      this.views.delete(id);
      this.beginCollapse(view);
    }
    for (const building of state.buildings) {
      if (!this.views.has(building.id)) this.addBuilding(building, !this.quietSpawn);
      this.refreshBuilding(state, building);
    }
  }

  private addBuilding(building: Building, juice: boolean): void {
    const { w, h } = dims(building.kind, building.rot);
    const center = footprintCenter(building.gx, building.gz, w, h);
    const y = sampleHeight(center.x, center.z, this.seed);
    const root = this.createMesh(building, w, h);
    root.position.set(center.x, y, center.z);
    const hx1 = sampleHeight(center.x - 0.8, center.z, this.seed);
    const hx2 = sampleHeight(center.x + 0.8, center.z, this.seed);
    const hz1 = sampleHeight(center.x, center.z - 0.8, this.seed);
    const hz2 = sampleHeight(center.x, center.z + 0.8, this.seed);
    const baseRotZ = THREE.MathUtils.clamp((hx1 - hx2) / 2.2, -0.1, 0.1);
    const baseRotX = THREE.MathUtils.clamp((hz2 - hz1) / 2.2, -0.1, 0.1);
    root.rotation.x = baseRotX;
    root.rotation.z = baseRotZ;
    const pop = juice && !this.reduced ? 0 : 1;
    root.scale.setScalar(pop === 0 ? 0.001 : 1);
    const { w: fw, h: fh } = dims(building.kind, building.rot);
    const pick = new THREE.Mesh(
      new THREE.BoxGeometry(fw * CELL * 0.96, 2.4, fh * CELL * 0.96),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pick.position.y = 1.1;
    pick.userData.pickId = building.id;
    root.add(pick);
    this.picks.push(pick);
    this.scene.add(root);
    const view: View = {
      root,
      windows: root.userData.windows ?? [],
      blades: root.userData.blades,
      banners: root.userData.banners ?? [],
      wheat: root.userData.wheat,
      chimney: root.userData.chimney,
      baseRotX,
      baseRotZ,
      pick,
      pop,
      groundY: y,
    };
    this.views.set(building.id, view);
    if (pop === 0) this.puff(center.x, y, center.z, 'dust');
  }

  private refreshBuilding(state: GameState, building: Building): void {
    const view = this.views.get(building.id);
    if (!view) return;
    const hurt = building.hp < building.maxHp * 0.55 ? 0.1 : 0;
    view.root.rotation.z = view.baseRotZ + hurt;
    if (view.blades) {
      const turning = building.workerIds.length > 0 && state.raiders.length === 0;
      view.blades.rotation.z += (turning ? 1.35 : 0.22) * this.frameDt;
    }
    for (const banner of view.banners) banner.rotation.y = Math.sin(this.uTime.value * 1.4 + building.id) * 0.35;
    if (view.wheat) this.stampWheat(view.wheat, building.growth);
    const night = 1 - smooth((sunElevation(state.day - Math.floor(state.day)) + 0.05) / 0.45);
    for (const windowMat of view.windows) windowMat.emissiveIntensity = night * 1.35;
  }

  private setupJuice(): void {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(this.moteCap * 3);
    const col = new Float32Array(this.moteCap * 3);
    const life = new Float32Array(this.moteCap);
    for (let i = 0; i < this.moteCap; i++) pos[i * 3 + 1] = -80;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aLife;
        varying vec3 vColor;
        varying float vLife;
        void main() {
          vColor = aColor;
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(560.0 / max(1.0, -mv.z), 4.0, 72.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vLife;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float soft = smoothstep(0.5, 0.08, d);
          gl_FragColor = vec4(vColor, soft * vLife);
        }
      `,
    });
    this.motePoints = new THREE.Points(geo, material);
    this.motePoints.frustumCulled = false;
    this.scene.add(this.motePoints);
    this.motePos = geo.getAttribute('position') as THREE.BufferAttribute;
    this.moteCol = geo.getAttribute('aColor') as THREE.BufferAttribute;
    this.moteLife = geo.getAttribute('aLife') as THREE.BufferAttribute;

    const ringGeo = new THREE.CircleGeometry(1, 22);
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xe7d3b0,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.ringPool.push(mesh);
    }
  }

  private puff(x: number, y: number, z: number, kind: 'dust' | 'debris'): void {
    if (this.reduced) return;
    const count = kind === 'dust' ? 26 : 22;
    const debris = kind === 'debris';
    for (let i = 0; i < count; i++) {
      if (this.motes.length >= this.moteCap) this.motes.shift();
      const angle = Math.random() * Math.PI * 2;
      const speed = (debris ? 1.4 : 0.9) + Math.random() * (debris ? 2.1 : 1.5);
      this.motes.push({
        x: x + (Math.random() - 0.5) * 0.45,
        y: y + 0.15 + Math.random() * 0.25,
        z: z + (Math.random() - 0.5) * 0.45,
        vx: Math.cos(angle) * speed,
        vy: (debris ? 1.7 : 1.15) + Math.random() * (debris ? 2.1 : 1.5),
        vz: Math.sin(angle) * speed,
        life: 0,
        max: 0.42 + Math.random() * 0.28,
        r: debris ? 0.48 + Math.random() * 0.16 : 0.9,
        g: debris ? 0.36 + Math.random() * 0.08 : 0.8,
        b: debris ? 0.24 : 0.58,
      });
    }
    const mesh = this.ringPool.find((entry) => !entry.visible);
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.set(debris ? 0x9a7048 : 0xe7d3b0);
    mat.opacity = 0.5;
    mesh.position.set(x, y + 0.12, z);
    mesh.scale.setScalar(0.28);
    mesh.visible = true;
    this.liveRings.push({ mesh, t: 0, life: debris ? 0.52 : 0.44, spread: debris ? 2.3 : 2.7 });
  }

  private updateBuildFeel(dt: number): void {
    for (const view of this.views.values()) {
      if (view.pop >= 1) continue;
      view.pop = Math.min(1, view.pop + dt / 0.7);
      view.root.scale.setScalar(view.pop >= 1 ? 1 : Math.max(0.001, easeOutBack(view.pop)));
    }
    for (let i = this.graves.length - 1; i >= 0; i--) {
      const grave = this.graves[i];
      grave.t += dt;
      const k = Math.min(1, grave.t / 0.64);
      const sink = k * k;
      grave.view.root.scale.set(1 + sink * 0.24, Math.max(0.05, 1 - sink), 1 + sink * 0.24);
      grave.view.root.position.y = grave.groundY - sink * 0.95;
      grave.view.root.rotation.z = grave.view.baseRotZ + sink * 0.72;
      grave.view.root.rotation.x = grave.view.baseRotX + sink * 0.2;
      if (k >= 1) {
        this.finishGrave(grave);
        this.graves.splice(i, 1);
      }
    }
    this.updateMotes(dt);
    this.updateRings(dt);
  }

  private beginCollapse(view: View): void {
    this.picks = this.picks.filter((pick) => pick !== view.pick);
    if (this.reduced) {
      this.finishGrave({ view, t: 1, groundY: view.groundY });
      return;
    }
    this.puff(view.root.position.x, view.groundY, view.root.position.z, 'debris');
    this.graves.push({ view, t: 0, groundY: view.groundY });
  }

  private finishGrave(grave: Grave): void {
    this.scene.remove(grave.view.root);
    this.picks = this.picks.filter((pick) => pick !== grave.view.pick);
    disposeTree(grave.view.root);
  }

  private updateMotes(dt: number): void {
    const next: Mote[] = [];
    for (const mote of this.motes) {
      mote.life += dt;
      if (mote.life >= mote.max) continue;
      mote.vy -= dt * 3.4;
      mote.x += mote.vx * dt;
      mote.y += mote.vy * dt;
      mote.z += mote.vz * dt;
      const drag = Math.max(0, 1 - dt * 1.5);
      mote.vx *= drag;
      mote.vz *= drag;
      next.push(mote);
    }
    this.motes = next;
    for (let i = 0; i < this.moteCap; i++) {
      const mote = this.motes[i];
      if (!mote) {
        this.motePos.setXYZ(i, 0, -80, 0);
        this.moteLife.setX(i, 0);
        continue;
      }
      const fade = 1 - mote.life / mote.max;
      this.motePos.setXYZ(i, mote.x, mote.y, mote.z);
      this.moteCol.setXYZ(i, mote.r, mote.g, mote.b);
      this.moteLife.setX(i, fade);
    }
    this.motePos.needsUpdate = true;
    this.moteCol.needsUpdate = true;
    this.moteLife.needsUpdate = true;
  }

  private updateRings(dt: number): void {
    for (let i = this.liveRings.length - 1; i >= 0; i--) {
      const ring = this.liveRings[i];
      ring.t += dt;
      const k = ring.t / ring.life;
      if (k >= 1) {
        ring.mesh.visible = false;
        this.liveRings.splice(i, 1);
        continue;
      }
      ring.mesh.scale.setScalar(0.3 + k * ring.spread);
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.5;
    }
  }

  private removeView(id: number): void {
    const view = this.views.get(id);
    if (!view) return;
    this.scene.remove(view.root);
    this.picks = this.picks.filter((pick) => pick !== view.pick);
    disposeTree(view.root);
    this.views.delete(id);
  }

  private createMesh(building: Building, w: number, h: number): THREE.Group {
    const sx = w * CELL * 0.9;
    const sz = h * CELL * 0.9;
    switch (building.kind) {
      case 'hall':
        return this.makeHall(sx, sz, building.id);
      case 'house':
        return this.makeHouse(sx, sz, building.id);
      case 'farm':
        return this.makeFarm(sx, sz, building.id);
      case 'mill':
        return this.makeMill(building.id);
      case 'wall':
        return this.makeWall(building.id);
      case 'woodcamp':
        return this.makeWoodcamp(building.id);
      case 'quarry':
        return this.makeQuarry(building.id);
      default:
        return this.makeRoad();
    }
  }

  private makeRoad(): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.9, 0.08, CELL * 0.9), mat(0x6e5840, 1));
    mesh.position.y = 0.06;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    g.add(mesh);
    return g;
  }

  private makeHouse(sx: number, sz: number, id: number): THREE.Group {
    const g = new THREE.Group();
    const plaster = shade(0xd9c7a8, id, 0.08);
    const timber = mat(0x4a3428, 0.78);
    const thatch = shade(0xc48a3f, id + 3, 0.08);
    const stone = mat(0x8b877f, 0.92);
    const base = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.32, sz), stone);
    base.position.y = 0.16;
    base.castShadow = base.receiveShadow = true;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.86, 1.15, sz * 0.86), plaster);
    walls.position.y = 0.86;
    walls.castShadow = walls.receiveShadow = true;
    const beamA = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.15, sz * 0.9), timber);
    const beamB = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.9, 0.08, 0.08), timber);
    beamA.position.y = 0.86;
    beamB.position.set(0, 1.05, sz * 0.4);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.7, 0.08), timber);
    door.position.set(0, 0.55, sz * 0.45);
    const winMat = new THREE.MeshStandardMaterial({ color: '#f3d7a4', emissive: '#ff9a3c', emissiveIntensity: 0, roughness: 0.45 });
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.08), winMat);
    win.position.set(sx * 0.22, 1.02, sz * 0.44);
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.55, 0.26), stone);
    chim.position.set(-sx * 0.22, 2.05, -sz * 0.12);
    chim.castShadow = true;
    g.add(base, walls, beamA, beamB, door, win, chim, gable(sx * 0.98, sz * 1.02, 0.85, 1.4, thatch));
    g.userData.windows = [winMat];
    g.userData.chimney = new THREE.Vector3(-sx * 0.22, 2.35, -sz * 0.12);
    g.userData.banners = [];
    return g;
  }

  private makeHall(sx: number, sz: number, id: number): THREE.Group {
    const g = this.makeHouse(sx, sz, id);
    const bannerMat = mat(0x8c2f2f, 0.7);
    const banners: THREE.Object3D[] = [];
    for (const side of [-1, 1]) {
      const pole = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 5), mat(0x4a3428));
      post.position.y = 1.2;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.48), bannerMat);
      cloth.position.set(0.4 * side, 1.85, 0);
      pole.add(post, cloth);
      pole.position.set(side * sx * 0.42, 0, sz * 0.35);
      g.add(pole);
      banners.push(cloth);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.05, 0.1), mat(0x3b2a22));
    door.position.set(0, 0.7, sz * 0.46);
    g.add(door);
    g.userData.banners = banners;
    return g;
  }

  private makeFarm(sx: number, sz: number, id: number): THREE.Group {
    const g = new THREE.Group();
    const soil = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.12, sz), mat(0x5d412c, 1));
    soil.position.y = 0.06;
    soil.receiveShadow = true;
    g.add(soil);
    const furrowMat = mat(0x3f2c1d, 1);
    for (let i = -2; i <= 2; i++) {
      const furrow = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.9, 0.05, 0.08), furrowMat);
      furrow.position.set(0, 0.12, (i / 5) * sz * 0.7);
      g.add(furrow);
    }
    const wheat = new THREE.InstancedMesh(new THREE.ConeGeometry(0.07, 0.55, 4), this.wheatMat, 28);
    wheat.castShadow = false;
    let n = 0;
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -2; iz <= 2; iz++) {
        if (n >= 28) break;
        this.dummy.position.set((ix / 5) * sx * 0.75, 0.28, (iz / 5) * sz * 0.7);
        this.dummy.rotation.set(0, id + n, 0);
        this.dummy.scale.set(1, 0.7, 1);
        this.dummy.updateMatrix();
        wheat.setMatrixAt(n, this.dummy.matrix);
        n++;
      }
    }
    wheat.count = n;
    wheat.instanceMatrix.needsUpdate = true;
    g.add(wheat);
    const hearthStone = mat(0x6e6860, 0.95);
    const hearth = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.14, 6), hearthStone);
    hearth.position.set(sx * 0.28, 0.14, -sz * 0.28);
    g.add(hearth);
    g.userData.wheat = wheat;
    g.userData.windows = [];
    g.userData.banners = [];
    g.userData.chimney = new THREE.Vector3(sx * 0.28, 0.42, -sz * 0.28);
    return g;
  }

  private stampWheat(wheat: THREE.InstancedMesh, growth: number): void {
    const scale = 0.25 + Math.max(0, Math.min(1, growth)) * 0.95;
    for (let i = 0; i < wheat.count; i++) {
      wheat.getMatrixAt(i, this.dummy.matrix);
      this.dummy.matrix.decompose(this.dummy.position, this.dummy.quaternion, this.dummy.scale);
      this.dummy.scale.y = scale;
      this.dummy.updateMatrix();
      wheat.setMatrixAt(i, this.dummy.matrix);
    }
    wheat.instanceMatrix.needsUpdate = true;
  }

  private makeMill(id: number): THREE.Group {
    const g = new THREE.Group();
    const stone = shade(0x9a938a, id, 0.04);
    const timber = mat(0x5a4032, 0.8);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.3, 1.7, 8), stone);
    base.position.y = 0.85;
    base.castShadow = base.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.45, 1.15, 8), shade(0xb98345, id, 0.05));
    roof.position.y = 2.15;
    roof.castShadow = true;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 1.1), timber);
    cap.position.set(0, 1.55, 0.9);
    const blades = new THREE.Group();
    const sail = mat(0xe7d7b4, 0.75);
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group();
      arm.rotation.z = (i * Math.PI) / 2;
      const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.85, 0.05), sail);
      cloth.position.y = 1.05;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.05, 0.06), timber);
      rib.position.y = 1.05;
      arm.add(rib, cloth);
      blades.add(arm);
    }
    blades.position.set(0, 1.6, 1.35);
    const winMat = new THREE.MeshStandardMaterial({ color: '#f3d7a4', emissive: '#ff9a3c', emissiveIntensity: 0, roughness: 0.4 });
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.08), winMat);
    win.position.set(0.4, 1.15, 1.22);
    const flue = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.38, 6), stone);
    flue.position.set(-0.32, 2.55, -0.15);
    g.add(base, roof, cap, blades, win, flue);
    g.userData.blades = blades;
    g.userData.windows = [winMat];
    g.userData.banners = [];
    g.userData.chimney = new THREE.Vector3(-0.32, 2.78, -0.15);
    return g;
  }

  private makeWall(id: number): THREE.Group {
    const g = new THREE.Group();
    const wood = shade(0x6b4e34, id, 0.08);
    for (let i = 0; i < 4; i++) {
      const h = 1.25 + (i % 2) * 0.18;
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h, 5), wood);
      log.position.set(-0.55 + i * 0.36, h / 2, (i % 2) * 0.08 - 0.04);
      log.rotation.z = (i - 1.5) * 0.03;
      log.castShadow = true;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 5), wood);
      tip.position.set(log.position.x, h + 0.08, log.position.z);
      g.add(log, tip);
    }
    const brace = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.08), mat(0x4a3428));
    brace.position.y = 0.7;
    g.add(brace);
    g.userData.windows = [];
    g.userData.banners = [];
    return g;
  }

  private makeWoodcamp(id: number): THREE.Group {
    const g = new THREE.Group();
    const timber = shade(0x6a4a30, id, 0.06);
    const hut = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 1.35), timber);
    hut.position.y = 0.5;
    hut.castShadow = true;
    g.add(hut, gable(1.7, 1.5, 0.55, 0.95, shade(0x8a6238, id, 0.05)));
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 5), timber);
      log.rotation.z = Math.PI / 2;
      log.position.set(1.15, 0.18 + i * 0.16, 0.1);
      log.castShadow = true;
      g.add(log);
    }
    const stack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.22), mat(0x5c564e, 0.92));
    stack.position.set(-0.4, 1.55, -0.15);
    g.add(stack);
    g.userData.windows = [];
    g.userData.banners = [];
    g.userData.chimney = new THREE.Vector3(-0.4, 1.8, -0.15);
    return g;
  }

  private makeQuarry(id: number): THREE.Group {
    const g = new THREE.Group();
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.18, 7), mat(0x3e3a36, 1));
    pit.position.y = 0.08;
    pit.receiveShadow = true;
    g.add(pit);
    const rockMat = shade(0x8d8880, id, 0.05);
    for (let i = 0; i < 4; i++) {
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28 + (i % 2) * 0.1, 0), rockMat);
      rock.position.set(Math.cos(i) * 0.7, 0.22, Math.sin(i * 1.7) * 0.55);
      rock.castShadow = true;
      g.add(rock);
    }
    const postMat = mat(0x5a4032);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 5), postMat);
      post.position.set(side * 0.85, 0.75, -0.7);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.08), postMat);
    beam.position.set(0, 1.5, -0.7);
    const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.12, 6), mat(0x4a4038, 0.9));
    brazier.position.set(0.55, 0.16, 0.35);
    g.add(beam, brazier);
    g.userData.windows = [];
    g.userData.banners = [];
    g.userData.chimney = new THREE.Vector3(0.55, 0.4, 0.35);
    return g;
  }

  private syncPeople(state: GameState): void {
    const alive = new Set(state.villagers.map((v) => v.id));
    for (const [id, mesh] of this.people) {
      if (alive.has(id)) continue;
      this.scene.remove(mesh);
      disposeTree(mesh);
      this.people.delete(id);
    }
    for (const villager of state.villagers) {
      let mesh = this.people.get(villager.id);
      if (!mesh) {
        mesh = makePerson(TUNICS[villager.id % TUNICS.length], false);
        this.people.set(villager.id, mesh);
        this.scene.add(mesh);
      }
      const y = sampleHeight(villager.x, villager.z, this.seed);
      const bob = villager.mode === 'walk' || villager.mode === 'flee' ? Math.abs(Math.sin(villager.phase)) * 0.06 : 0;
      mesh.position.set(villager.x, y + bob, villager.z);
      mesh.rotation.y = villager.facing;
      const swing =
        villager.mode === 'walk' || villager.mode === 'flee'
          ? Math.sin(villager.phase) * 0.7
          : villager.mode === 'work'
            ? Math.sin(villager.phase) * 0.45
            : 0;
      mesh.userData.hipL.rotation.x = swing;
      mesh.userData.hipR.rotation.x = -swing;
      mesh.userData.arm.rotation.x = villager.mode === 'work' ? Math.sin(villager.phase * 1.3) * 0.8 : -swing * 0.4;
    }
  }

  private syncRaiders(state: GameState): void {
    const alive = new Set(state.raiders.map((r) => r.id));
    for (const [id, mesh] of this.raiderMeshes) {
      if (alive.has(id)) continue;
      this.scene.remove(mesh);
      disposeTree(mesh);
      this.raiderMeshes.delete(id);
    }
    for (const raider of state.raiders) {
      let mesh = this.raiderMeshes.get(raider.id);
      if (!mesh) {
        mesh = makePerson(0x2a2424, true);
        mesh.scale.setScalar(1.08);
        this.raiderMeshes.set(raider.id, mesh);
        this.scene.add(mesh);
      }
      const y = sampleHeight(raider.x, raider.z, this.seed);
      mesh.position.set(raider.x, y + Math.abs(Math.sin(raider.phase)) * 0.05, raider.z);
      mesh.rotation.y = raider.facing;
      const swing = Math.sin(raider.phase) * 0.75;
      mesh.userData.hipL.rotation.x = swing;
      mesh.userData.hipR.rotation.x = -swing;
      mesh.userData.arm.rotation.x = 0.8;
    }
  }

  showGhost(kind: Kind, rot: number, gx: number, gz: number, ok: boolean): void {
    (this.pendingGhost as { kind: Kind; rot: number; gx: number; gz: number; ok: boolean } | null) = { kind, rot, gx, gz, ok };
  }

  clearGhost(): void {
    this.pendingGhost = null;
  }

  private pendingGhost: { kind: Kind; rot: number; gx: number; gz: number; ok: boolean } | null = null;

  private syncSelection(state: GameState): void {
    const ghost = this.pendingGhost;
    if (!ghost) this.ghost.visible = false;
    else {
      const key = `${ghost.kind}:${ghost.rot}:${ghost.gx}:${ghost.gz}:${ghost.ok}`;
      if (key !== this.ghostKey) {
        this.ghostKey = key;
        for (const child of [...this.ghost.children]) {
          this.ghost.remove(child);
          disposeTree(child);
        }
        const cells = cellsFor(ghost.kind, ghost.gx, ghost.gz, ghost.rot);
        const material = new THREE.MeshBasicMaterial({
          color: ghost.ok ? '#d6ec9a' : '#e07a62',
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        });
        for (const cell of cells) {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.92, 0.15, CELL * 0.92), material);
          const p = cellCenter(cell.gx, cell.gz);
          mesh.position.set(p.x, sampleHeight(p.x, p.z, this.seed) + 0.2, p.z);
          this.ghost.add(mesh);
        }
      }
      const pulse = 0.28 + Math.sin(this.uTime.value * 6) * 0.08;
      for (const child of this.ghost.children) {
        const mesh = child as THREE.Mesh;
        (mesh.material as THREE.MeshBasicMaterial).opacity = pulse;
      }
      this.ghost.visible = true;
    }

    if (state.selectedId == null) {
      this.selectRing.visible = false;
      return;
    }
    const building = state.buildings.find((b) => b.id === state.selectedId);
    if (!building) {
      this.selectRing.visible = false;
      return;
    }
    const { w, h } = dims(building.kind, building.rot);
    const c = footprintCenter(building.gx, building.gz, w, h);
    this.selectRing.position.set(c.x, sampleHeight(c.x, c.z, this.seed) + 0.22, c.z);
    this.selectRing.scale.set(w * 1.15, h * 1.15, 1);
    this.selectRing.visible = true;
  }

  private syncShots(state: GameState): void {
    if (!state.shots.length) {
      this.shotLines.visible = false;
      return;
    }
    const positions = new Float32Array(state.shots.length * 2 * 3);
    state.shots.forEach((shot, i) => {
      const y1 = sampleHeight(shot.x1, shot.z1, this.seed) + 2.2;
      const y2 = sampleHeight(shot.x2, shot.z2, this.seed) + 0.9;
      positions.set([shot.x1, y1, shot.z1, shot.x2, y2, shot.z2], i * 6);
    });
    this.shotLines.geometry.dispose();
    this.shotLines.geometry = new THREE.BufferGeometry();
    this.shotLines.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.shotLines.visible = true;
  }

  private flockFocus(state: GameState): { x: number; y: number; z: number } {
    const hall = state.hall();
    const { w, h } = dims(hall.kind, hall.rot);
    const center = footprintCenter(hall.gx, hall.gz, w, h);
    return { x: center.x, y: sampleHeight(center.x, center.z, this.seed), z: center.z };
  }

  private smokeSources(state: GameState): SmokeSource[] {
    const popping = [...this.views.values()].some((view) => view.pop < 1);
    if (!popping && this.smokeCacheRev === state.navRev && this.smokeCacheCount === state.buildings.length) return this.smokeCache;
    const out: SmokeSource[] = [];
    for (const building of state.buildings) {
      const tone = smokeTone(building.kind);
      if (!tone) continue;
      const view = this.views.get(building.id);
      if (!view?.chimney) continue;
      view.root.updateWorldMatrix(true, false);
      this.smokeScratch.copy(view.chimney);
      view.root.localToWorld(this.smokeScratch);
      out.push({ x: this.smokeScratch.x, y: this.smokeScratch.y, z: this.smokeScratch.z, tone });
    }
    this.smokeCache = out;
    this.smokeCacheRev = state.navRev;
    this.smokeCacheCount = state.buildings.length;
    return out;
  }

  private updateFireflies(tod: number, rawDt: number): void {
    const night = tod < 0.28 || tod > 0.72 ? 1 : 0;
    (this.fireflies.material as THREE.PointsMaterial).opacity = night * 0.85;
    const pos = this.fireflies.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getY(i) + Math.sin(this.uTime.value * 2 + i) * rawDt * 0.25);
    }
    pos.needsUpdate = true;
  }

  private updateSky(tod: number, season: Season): void {
    const elev = sunElevation(tod);
    const day = smooth((elev + 0.08) / 0.38);
    const dusk =
      Math.exp(-(((tod - 0.75) / 0.055) ** 2)) + Math.exp(-(((tod - 0.25) / 0.055) ** 2));
    const zenith = new THREE.Color(season === 'winter' ? '#6e88ad' : '#6ea2d6').lerp(new THREE.Color('#10182c'), 1 - day);
    const horizonDay = new THREE.Color('#f2d2a6');
    const horizonNight = new THREE.Color('#1b2744');
    const horizon = horizonDay.clone().lerp(horizonNight, 1 - day);
    horizon.lerp(new THREE.Color('#ff9a62'), Math.min(1, dusk) * day);
    const nadir = new THREE.Color('#6e5338').lerp(new THREE.Color('#14110e'), 1 - day);
    (this.skyMat.uniforms.uZenith.value as THREE.Color).copy(zenith);
    (this.skyMat.uniforms.uHorizon.value as THREE.Color).copy(horizon);
    (this.skyMat.uniforms.uNadir.value as THREE.Color).copy(nadir);
    const fogColor = horizon.clone().lerp(new THREE.Color('#cbb89a'), 0.35);
    (this.scene.fog as THREE.FogExp2).color.copy(fogColor);
    (this.scene.background as THREE.Color).copy(horizon);
    this.starMat.opacity = (1 - day) * 0.95;
    const az = tod * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(elev) * Math.cos(az), Math.max(0.18, Math.sin(elev)), Math.cos(elev) * Math.sin(az)).normalize();
    const target = this.controls.target;
    this.sunLight.position.copy(target).add(dir.clone().multiplyScalar(32));
    this.sunLight.intensity = 0.55 + day * 3.15;
    this.sunLight.color.set('#fff4dc').lerp(new THREE.Color('#ffb07a'), Math.min(1, dusk));
    this.hemi.intensity = 0.72 + day * 0.55;
    this.fill.position.set(target.x - 18, target.y + 10, target.z - 12);
    this.fill.intensity = 0.55 + (1 - day) * 0.4;
    this.renderer.toneMappingExposure = 1.05 + day * 0.22;
    this.sunOrb.position.copy(target).add(dir.clone().multiplyScalar(150));
    this.sunOrb.visible = elev > -0.05;
    this.moonOrb.position.copy(target).add(dir.clone().multiplyScalar(-140));
    this.moonOrb.visible = elev < 0.15;
  }
}
