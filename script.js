'use strict';

/* =====================================================================
 *  Entraîneur de visée CS2 — script.js
 *  Three.js (lib/three.min.js) + localStorage, sans étape de build.
 * ===================================================================== */

/* ---------------------------------------------------------------------
 *  Constantes
 * ------------------------------------------------------------------- */
const STORAGE_SETTINGS = 'cs2aim.settings.v1';
const STORAGE_HISTORY = 'cs2aim.history.v1';
const HISTORY_MAX = 500;

const CS2 = {
  YAW: 0.022,        // degrés par unité de mouvement, à sensibilité 1 (m_yaw = m_pitch)
  FOV: 74,           // FOV vertical (≈ 90° horizontal en 4:3, ≈ 106° en 16:9)
  EYE: 1.62,         // hauteur des yeux (m)
  PLAYER_R: 0.3,     // rayon de collision (m)
  RUN: 5.0           // vitesse de déplacement (m/s)
};

const SCORE = { head: 100, body: 25 };
const BODY_HITS_TO_KILL = 3;
const AUTO_INTERVAL = 60 / 600;   // 600 tirs / minute
const SEMI_INTERVAL = 0.12;       // cadence maximale en coup par coup
const COUNTDOWN_SECONDS = 3;
const DEG = Math.PI / 180;

const DEFAULTS = {
  mode: 'fixed', minutes: 1, seconds: 0, speed: 5,
  displayTime: 1.5, weapon: 'semi', dpi: 800, sens: 1
};

const MODE_LABEL = {
  fixed: 'Cibles fixes',
  moving: 'Cibles mobiles',
  movement: 'Déplacement',
  movement_moving: 'Déplacement + cibles mobiles'
};
const hasWalking = (mode) => mode === 'movement' || mode === 'movement_moving';   // le joueur se déplace (Z Q S D)
const hasMovingTargets = (mode) => mode === 'moving' || mode === 'movement_moving'; // les cibles se déplacent latéralement
const WEAPON_LABEL = { semi: 'Pistolet · coup par coup', auto: 'Mitraillette · rafale' };

/* Schéma de recul fixe (inspiré d'une rafale de fusil CS2).
 * Chaque entrée = [déplacement vers la droite (°), déplacement vers le haut (°)]
 * appliqué après chaque tir : d'abord vers le haut, puis écarts latéraux. */
const SPRAY = [
  [0.00, 0.50], [0.02, 0.62], [0.04, 0.74], [0.06, 0.80], [0.10, 0.80], [0.12, 0.78],
  [-0.35, 0.70], [-0.45, 0.60], [-0.50, 0.50], [-0.45, 0.40], [-0.35, 0.32],
  [-0.10, 0.28], [0.15, 0.25], [0.35, 0.22], [0.50, 0.20], [0.50, 0.18],
  [0.40, 0.18], [0.25, 0.16], [0.00, 0.16], [-0.30, 0.15], [-0.50, 0.14], [-0.60, 0.14],
  [-0.50, 0.12], [-0.30, 0.12], [0.10, 0.10], [0.40, 0.10], [0.60, 0.10], [0.50, 0.10],
  [0.30, 0.10], [0.10, 0.10]
];
const SEMI_KICK = 0.4;      // recul d'un tir en coup par coup (°)
const SEMI_KICK_MAX = 4;    // cumul maximal en tirs rapprochés (°)

/* ---------------------------------------------------------------------
 *  Utilitaires
 * ------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const nf = (v, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

function fmtDuration(total) {
  total = Math.round(total);
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

/* Distance (cm) pour un tour complet à DPI et sensibilité donnés. */
function cmPer360(dpi, sens) {
  const counts = 360 / (CS2.YAW * sens);
  return (counts / dpi) * 2.54;
}

/* Vitesse -> rythme / vitesse de déplacement. */
const spawnGap = (speed) => lerp(1.2, 0.1, (speed - 1) / 9);      // secondes entre deux apparitions
const moveSpeed = (speed) => lerp(1.0, 6.0, (speed - 1) / 9);     // m/s (cibles mobiles)

/* ---------------------------------------------------------------------
 *  Réglages (menu)
 * ------------------------------------------------------------------- */
const ui = {
  menu: $('menu'), history: $('history'), hud: $('hud'),
  durMin: $('durMin'), durSec: $('durSec'), speed: $('speed'), speedVal: $('speedVal'),
  displayTime: $('displayTime'), dpi: $('dpi'), sens: $('sens'), cm360: $('cm360'),
  durHint: $('durHint'), modeHint: $('modeHint'), speedHint: $('speedHint'), weaponHint: $('weaponHint'),
  startError: $('startError')
};

function radioValue(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}
function setRadio(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = (r.value === value); });
}

/* Lit le formulaire et renvoie des valeurs valides (sans toucher aux champs). */
function readSettings() {
  const num = (el, def) => { const v = parseFloat(String(el.value).replace(',', '.')); return Number.isFinite(v) ? v : def; };
  const mode = radioValue('mode') || DEFAULTS.mode;
  const weapon = radioValue('weapon') || DEFAULTS.weapon;
  let total = Math.round(Math.max(0, num(ui.durMin, 0)) * 60 + Math.max(0, num(ui.durSec, 0)));
  total = clamp(total, 5, 7200);
  return {
    mode: MODE_LABEL[mode] ? mode : DEFAULTS.mode,
    weapon: WEAPON_LABEL[weapon] ? weapon : DEFAULTS.weapon,
    duration: total,
    speed: clamp(Math.round(num(ui.speed, DEFAULTS.speed)), 1, 10),
    displayTime: clamp(Math.round(num(ui.displayTime, DEFAULTS.displayTime) * 10) / 10, 0.3, 10),
    dpi: clamp(Math.round(num(ui.dpi, DEFAULTS.dpi)), 100, 32000),
    sens: clamp(Math.round(num(ui.sens, DEFAULTS.sens) * 100) / 100, 0.01, 30)
  };
}

function writeSettings(s) {
  setRadio('mode', s.mode);
  setRadio('weapon', s.weapon);
  ui.durMin.value = Math.floor(s.duration / 60);
  ui.durSec.value = s.duration % 60;
  ui.speed.value = s.speed;
  ui.displayTime.value = s.displayTime;
  ui.dpi.value = s.dpi;
  ui.sens.value = s.sens;
}

function loadSettings() {
  const saved = storageGet(STORAGE_SETTINGS, null) || {};
  const merged = Object.assign({}, DEFAULTS, saved);
  // anciennes clés éventuelles / valeurs absentes
  if (!Number.isFinite(saved.duration)) {
    merged.duration = clamp(Math.round(merged.minutes * 60 + merged.seconds), 5, 7200);
  }
  return merged;
}

function refreshMenuInfo() {
  const s = readSettings();
  ui.speedVal.textContent = s.speed;
  ui.cm360.textContent = `${nf(cmPer360(s.dpi, s.sens), 1)} cm`;
  ui.durHint.textContent = `Durée totale : ${fmtDuration(s.duration)} (minimum 5 s)`;
  ui.modeHint.textContent = {
    fixed: 'Une cible à la fois, à une position aléatoire. La vitesse règle le rythme d\'apparition.',
    moving: 'Les silhouettes se déplacent latéralement. La vitesse règle leur vitesse de déplacement.',
    movement: 'Vous êtes devant un angle de mur : sortez de l\'angle avec Z Q S D (WASD en QWERTY) puis visez les cibles fixes qui apparaissent. La vitesse règle le rythme d\'apparition.',
    movement_moving: 'Comme « Déplacement », mais les cibles qui apparaissent derrière l\'angle se déplacent latéralement. La vitesse règle leur vitesse de déplacement.'
  }[s.mode];
  ui.speedHint.textContent = hasMovingTargets(s.mode)
    ? `Déplacement latéral d'environ ${nf(moveSpeed(s.speed), 1)} m/s.`
    : `Nouvelle cible environ ${nf(spawnGap(s.speed), 1)} s après la précédente.`;
  ui.weaponHint.textContent = s.weapon === 'auto'
    ? 'Mitraillette : tir continu (~600 tirs/min) tant que le bouton est enfoncé. La visée monte : tirez la souris vers le bas pour compenser.'
    : 'Pistolet : un tir à chaque clic, avec un léger recul.';
}

function commitSettings() {
  const s = readSettings();
  writeSettings(s);
  storageSet(STORAGE_SETTINGS, s);
  refreshMenuInfo();
  return s;
}

/* ---------------------------------------------------------------------
 *  Moteur 3D
 * ------------------------------------------------------------------- */
const canvas = $('scene');
let renderer = null;
let webglError = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
} catch (e) {
  webglError = 'WebGL n\'est pas disponible dans ce navigateur : impossible d\'afficher la scène 3D.';
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141b);
scene.fog = new THREE.Fog(0x10141b, 32, 70);

const camera = new THREE.PerspectiveCamera(CS2.FOV, window.innerWidth / window.innerHeight, 0.05, 120);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xc4d2ff, 0x2c3038, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(6, 12, 8);
scene.add(sun);
if (renderer) renderer.autoClear = false;   // la scène, puis les armes par-dessus (2 passes)

/* ---------------------------------------------------------------------
 *  Armes en vue à la première personne (pistolet / mitraillette)
 * ------------------------------------------------------------------- */
const weaponScene = new THREE.Scene();
weaponScene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f4a, 0.9));
const weaponLight = new THREE.DirectionalLight(0xffffff, 0.55);
weaponLight.position.set(-1, 2, 1);
weaponScene.add(weaponLight);
const weaponCam = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 5);

const VM = { pistol: null, smg: null, active: null, kick: 0, flashT: 0 };
const vmBoxGeo = new THREE.BoxGeometry(1, 1, 1);
const SKIN = 0xd2a27c, SLEEVE = 0x39463a;

function buildViewmodel(kind) {
  const g = new THREE.Group();
  const box = (w, h, d, x, y, z, color, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(vmBoxGeo, new THREE.MeshLambertMaterial({ color }));
    m.scale.set(w, h, d); m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
    g.add(m);
    return m;
  };
  let muzzleZ, base;
  if (kind === 'pistol') {
    box(0.040, 0.045, 0.22, 0, 0.020, -0.06, 0x2d3239);          // culasse
    box(0.038, 0.030, 0.18, 0, -0.012, -0.04, 0x1c1f24);         // carcasse
    box(0.022, 0.022, 0.03, 0, 0.020, -0.185, 0x0d0e10);         // bouche du canon
    box(0.040, 0.105, 0.055, 0, -0.075, 0.035, 0x15171a, 0.25);  // crosse
    box(0.070, 0.075, 0.080, 0.012, -0.070, 0.050, SKIN);        // main
    box(0.075, 0.085, 0.420, 0.040, -0.115, 0.290, SLEEVE, 0.12, -0.08);  // avant-bras
    box(0.020, 0.008, 0.200, 0, 0.0445, -0.06, 0x555d69);          // dessus de culasse
    box(0.010, 0.014, 0.012, 0, 0.050, -0.165, 0xe8e8e8);          // guidon
    box(0.036, 0.006, 0.075, 0, -0.035, -0.015, 0x0d0e10);         // pontet
    muzzleZ = -0.20; base = new THREE.Vector3(0.095, -0.105, -0.40);
  } else {
    box(0.052, 0.070, 0.340, 0, 0.010, -0.080, 0x2a2d33);        // corps
    box(0.030, 0.016, 0.220, 0, 0.056, -0.060, 0x3a3f48);        // rail
    box(0.026, 0.026, 0.150, 0, 0.026, -0.325, 0x14161a);        // canon
    box(0.034, 0.150, 0.052, 0, -0.095, -0.020, 0x1b1d21, -0.10);// chargeur
    box(0.040, 0.105, 0.050, 0, -0.080, 0.105, 0x15171a, 0.25);  // poignée
    box(0.042, 0.050, 0.060, 0, 0.000, 0.120, 0x23262b);         // crosse (repliée)
    box(0.072, 0.078, 0.085, 0.012, -0.075, 0.115, SKIN);        // main
    box(0.078, 0.088, 0.420, 0.042, -0.120, 0.330, SLEEVE, 0.12, -0.08);  // avant-bras
    box(0.012, 0.014, 0.014, 0, 0.060, -0.395, 0xe8e8e8);          // guidon
    box(0.026, 0.020, 0.060, 0, 0.056, 0.060, 0x15171a);           // viseur arrière
    muzzleZ = -0.405; base = new THREE.Vector3(0.085, -0.12, -0.44);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.024, muzzleZ);
  g.add(muzzle);
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(0.03, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  flash.position.copy(muzzle.position);
  flash.visible = false;
  g.add(flash);
  g.position.copy(base);
  return { group: g, muzzle, flash, base };
}

function setViewmodel(weapon) {
  if (!VM.pistol) { VM.pistol = buildViewmodel('pistol'); VM.smg = buildViewmodel('smg'); }
  [VM.pistol, VM.smg].forEach((v) => { if (v.group.parent) weaponScene.remove(v.group); });
  VM.active = weapon === 'auto' ? VM.smg : VM.pistol;
  weaponScene.add(VM.active.group);
  VM.kick = 0; VM.flashT = 0; VM.active.flash.visible = false;
}

function updateViewmodel(dt) {
  const v = VM.active;
  if (!v) return;
  VM.kick *= Math.exp(-16 * dt);
  v.group.position.set(v.base.x, v.base.y + VM.kick * 0.012, v.base.z + VM.kick * 0.045);
  v.group.rotation.set(VM.kick * 0.09, 0.025, 0);
  if (VM.flashT > 0) { VM.flashT -= dt; if (VM.flashT <= 0) v.flash.visible = false; }
}

function viewmodelFired(auto) {
  const v = VM.active;
  if (!v) return;
  VM.kick = Math.min(1.3, VM.kick + (auto ? 0.55 : 1));
  VM.flashT = 0.045;
  v.flash.visible = true;
  v.flash.scale.setScalar(0.8 + Math.random() * 0.7);
}

const _mz = new THREE.Vector3();
function muzzleWorldPosition() {
  weaponScene.updateMatrixWorld(true);
  VM.active.muzzle.getWorldPosition(_mz);     // repère de la caméra d'arme (identique à celui de la vue)
  return camera.localToWorld(_mz.clone());
}

function renderAll() {
  renderer.setClearColor(0x10141b, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(weaponScene, weaponCam);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (renderer) renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  weaponCam.aspect = w / h;
  weaponCam.updateProjectionMatrix();
  if (renderer && (G.state === 'playing' || G.state === 'countdown' || G.state === 'paused')) renderAll();
  if (ui.history.classList.contains('active')) renderHistory();
}

/* ----- Arène ----- */
function gridTexture(base, line, rx, ry) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = line; g.lineWidth = 3; g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  return t;
}

const arenas = {};

function buildArena(mode) {
  if (arenas[mode]) return arenas[mode];
  const group = new THREE.Group();
  const occluders = [];   // meshes qui arrêtent les balles
  const colliders = [];   // boîtes AABB (XZ) pour les collisions du joueur

  const addBox = (w, h, d, x, y, z, mat, { occ = true, col = true } = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    group.add(m);
    if (occ) occluders.push(m);
    if (col) colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    return m;
  };

  // sol
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 46),
    new THREE.MeshLambertMaterial({ map: gridTexture('#232a36', '#3a4458', 17, 23) })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -17);
  group.add(floor);
  occluders.push(floor);

  // murs de l'arène
  const wallMat = new THREE.MeshLambertMaterial({ map: gridTexture('#2a3140', '#434e66', 17, 3) });
  addBox(34, 8, 0.5, 0, 4, -40.25, wallMat);          // fond
  addBox(34, 8, 0.5, 0, 4, 6.25, wallMat);            // derrière le joueur
  addBox(0.5, 8, 46.5, -16.25, 4, -17, wallMat);      // gauche
  addBox(0.5, 8, 46.5, 16.25, 4, -17, wallMat);       // droite

  if (hasWalking(mode)) {
    // Mur central : deux angles, à gauche (x = -3) et à droite (x = +3)
    const mat = new THREE.MeshLambertMaterial({ map: gridTexture('#4a5468', '#7b88a6', 3, 2) });
    addBox(6, 4, 0.4, 0, 2, -2.2, mat);
    const edge = new THREE.MeshBasicMaterial({ color: 0xf5a623 });
    addBox(0.08, 4, 0.44, -3.04, 2, -2.2, edge, { col: false });
    addBox(0.08, 4, 0.44, 3.04, 2, -2.2, edge, { col: false });
  }

  if (mode === 'movement_moving') {
    // 6 murs de hauteurs différentes entre l'angle et la zone des cibles (couvertures, plus d'immersion).
    // Les cibles apparaissent à z <= -9 : elles restent derrière ces murs, sans les traverser.
    const palette = [
      new THREE.MeshLambertMaterial({ map: gridTexture('#3f4757', '#6b7894', 2, 2) }),
      new THREE.MeshLambertMaterial({ map: gridTexture('#4d4a44', '#80796c', 2, 2) })
    ];
    const walls = [   // [x, z, largeur, hauteur]
      [-5.5, -6.2, 2.4, 2.6],
      [-9.0, -7.2, 2.8, 1.3],
      [-13.0, -6.0, 2.2, 3.6],
      [5.5, -6.2, 2.4, 1.8],
      [9.0, -7.0, 2.6, 3.0],
      [13.0, -7.4, 2.2, 2.2]
    ];
    walls.forEach(([x, z, w, h], i) => addBox(w, h, 0.5, x, h / 2, z, palette[i % 2]));
  }

  arenas[mode] = { group, occluders, colliders };
  return arenas[mode];
}

/* ----- Silhouettes ----- */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  head: new THREE.SphereGeometry(0.13, 20, 14),
  shadow: new THREE.CircleGeometry(0.42, 20),
  spark: new THREE.BoxGeometry(0.06, 0.06, 0.06)
};
const COLORS = { body: 0xe0592a, head: 0xf2c14e, flashBody: 0xffffff, flashHead: 0xff2a2a };

function makeTarget() {
  const bodyMat = new THREE.MeshLambertMaterial({ color: COLORS.body, transparent: true });
  const headMat = new THREE.MeshLambertMaterial({ color: COLORS.head, transparent: true });
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
  const group = new THREE.Group();
  const meshes = [];

  const part = (w, h, d, x, y, z, zone) => {
    const m = new THREE.Mesh(GEO.box, bodyMat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.userData.zone = zone;
    group.add(m); meshes.push(m);
  };
  part(0.17, 0.85, 0.22, -0.11, 0.425, 0, 'body');   // jambe gauche
  part(0.17, 0.85, 0.22, 0.11, 0.425, 0, 'body');    // jambe droite
  part(0.50, 0.62, 0.28, 0, 1.16, 0, 'body');        // torse
  part(0.11, 0.58, 0.14, -0.31, 1.15, 0, 'body');    // bras gauche
  part(0.11, 0.58, 0.14, 0.31, 1.15, 0, 'body');     // bras droit
  part(0.10, 0.10, 0.10, 0, 1.52, 0, 'body');        // cou

  const head = new THREE.Mesh(GEO.head, headMat);
  head.position.set(0, 1.62, 0);
  head.userData.zone = 'head';
  group.add(head); meshes.push(head);

  const shadow = new THREE.Mesh(GEO.shadow, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  group.add(shadow);

  const t = {
    group, meshes, bodyMat, headMat, shadowMat,
    mats: [[bodyMat, 1], [headMat, 1], [shadowMat, 0.35]],
    hp: BODY_HITS_TO_KILL, alive: true, born: 0, life: 1.5,
    x: 0, z: -15, vx: 0, bound: 8, dirTimer: 0, flash: 0, flashZone: null
  };
  meshes.forEach((m) => { m.userData.target = t; });
  return t;
}

function setTargetOpacity(t, k) {
  t.mats.forEach(([m, base]) => { m.opacity = base * k; });
}
function disposeTarget(t) {
  scene.remove(t.group);
  t.mats.forEach(([m]) => m.dispose());
}

/* ---------------------------------------------------------------------
 *  État du jeu
 * ------------------------------------------------------------------- */
const G = {
  state: 'menu',          // menu | countdown | playing | paused | ended
  prevState: null,
  settings: null,
  arena: null,
  locked: false,
  rawInput: false,

  t: 0,                   // temps de jeu écoulé (s)
  countdown: 0,
  player: { x: 0, z: 0, vx: 0, vz: 0 },
  view: { yaw: 0, pitch: 0 },                 // visée du joueur (°)
  recoil: { tgtR: 0, tgtU: 0, curR: 0, curU: 0, idx: 0 },
  keys: { f: false, b: false, l: false, r: false },

  holding: false,
  cooldown: 0,
  sinceShot: 99,

  targets: [],
  fx: [],
  spawnTimer: 0,
  lastSide: 1,

  stats: null,
  lastHud: {}
};

function newStats() {
  return { score: 0, shots: 0, head: 0, body: 0, kills: 0, missed: 0, ttk: [] };
}

/* ---------------------------------------------------------------------
 *  Caméra / visée
 * ------------------------------------------------------------------- */
function updateCamera() {
  const r = G.recoil;
  const pitch = clamp(G.view.pitch + r.curU, -89, 89);
  const yaw = G.view.yaw - r.curR;
  camera.position.set(G.player.x, CS2.EYE, G.player.z);
  camera.rotation.set(pitch * DEG, yaw * DEG, 0, 'YXZ');
  camera.updateMatrixWorld(true);
}

function onMouseMove(e) {
  if (!G.locked || (G.state !== 'playing' && G.state !== 'countdown')) return;
  let dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(dx) > 1500 || Math.abs(dy) > 1500) return;   // saut parasite à l'acquisition du verrouillage
  const k = CS2.YAW * G.settings.sens;                       // °/unité, identique sur les deux axes
  G.view.yaw -= dx * k;
  G.view.pitch = clamp(G.view.pitch - dy * k, -89, 89);
}

/* ---------------------------------------------------------------------
 *  Verrouillage de la souris
 * ------------------------------------------------------------------- */
async function lockPointer() {
  // 1) tentative en mouvement brut (sans accélération système)
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.then === 'function') await p; else await new Promise((r) => setTimeout(r, 250));
    G.rawInput = true;
    return true;
  } catch (e) {
    if (!e || e.name !== 'NotSupportedError') return false;
  }
  // 2) repli : mode normal
  try {
    const p = canvas.requestPointerLock();
    if (p && typeof p.then === 'function') await p; else await new Promise((r) => setTimeout(r, 250));
    G.rawInput = false;
    return true;
  } catch (e) {
    return false;
  }
}

document.addEventListener('pointerlockchange', () => {
  G.locked = document.pointerLockElement === canvas;
  if (!G.locked && (G.state === 'playing' || G.state === 'countdown')) pauseGame();
});

/* ---------------------------------------------------------------------
 *  Cycle de séance
 * ------------------------------------------------------------------- */
function showScreen(name) {
  ui.menu.classList.toggle('active', name === 'menu');
  ui.history.classList.toggle('active', name === 'history');
  ui.hud.classList.toggle('hidden', name !== 'game');
  $('pause').classList.remove('active');
  $('end').classList.remove('active');
  if (name === 'history') renderHistory();
}

function clearWorld() {
  G.targets.forEach(disposeTarget);
  G.targets = [];
  G.fx.forEach((f) => { if (f.cleanup) f.cleanup(); });
  G.fx = [];
}

async function startSession() {
  if (webglError) { ui.startError.textContent = webglError; ui.startError.hidden = false; return; }
  const s = commitSettings();
  ui.startError.hidden = true;
  initAudio();
  setViewmodel(s.weapon);

  clearWorld();
  if (G.arena) scene.remove(G.arena.group);
  G.arena = buildArena(s.mode);
  scene.add(G.arena.group);

  G.settings = s;
  G.t = 0;
  G.countdown = COUNTDOWN_SECONDS;
  G.player = { x: 0, z: 0, vx: 0, vz: 0 };
  G.view = { yaw: 0, pitch: 0 };
  G.recoil = { tgtR: 0, tgtU: 0, curR: 0, curU: 0, idx: 0 };
  G.keys = { f: false, b: false, l: false, r: false };
  G.holding = false; G.cooldown = 0; G.sinceShot = 99;
  G.spawnTimer = 0.4;
  G.lastSide = Math.random() < 0.5 ? -1 : 1;
  G.stats = newStats();
  G.lastHud = {};
  G.state = 'countdown';
  G.prevState = null;

  showScreen('game');
  $('keysHint').classList.toggle('hidden', !hasWalking(s.mode));
  $('countdown').textContent = '';
  updateHud(true);
  updateCamera();
  if (renderer) renderAll();

  const ok = await lockPointer();
  if (!ok || document.pointerLockElement !== canvas) {
    G.state = 'menu';
    showScreen('menu');
    ui.startError.textContent = 'Le navigateur a refusé de verrouiller la souris. Cliquez à nouveau sur « Commencer » (un court délai est parfois imposé après Échap).';
    ui.startError.hidden = false;
  }
}

function pauseGame() {
  if (G.state !== 'playing' && G.state !== 'countdown') return;
  G.prevState = G.state;
  G.state = 'paused';
  G.holding = false;
  G.keys = { f: false, b: false, l: false, r: false };
  if (document.pointerLockElement) document.exitPointerLock();
  $('pauseMsg').hidden = true;
  $('rawInfo').textContent = G.rawInput
    ? 'Mouvement brut de la souris activé (sans accélération système).'
    : 'Mouvement brut non pris en charge : mode normal du navigateur.';
  $('pause').classList.add('active');
}

async function resumeGame() {
  if (G.state !== 'paused') return;
  initAudio();
  const ok = await lockPointer();
  if (ok && document.pointerLockElement === canvas) {
    $('pause').classList.remove('active');
    G.state = G.prevState || 'playing';
  } else {
    const m = $('pauseMsg');
    m.textContent = 'Le navigateur a refusé le verrouillage de la souris. Patientez une seconde puis cliquez à nouveau sur « Reprendre ».';
    m.hidden = false;
  }
}

function quitToMenu() {
  G.state = 'menu';
  G.holding = false;
  if (document.pointerLockElement) document.exitPointerLock();
  clearWorld();
  showScreen('menu');
}

function finishSession() {
  G.state = 'ended';
  G.holding = false;
  if (document.pointerLockElement) document.exitPointerLock();
  const rec = buildRecord();
  const list = loadHistory();
  list.push(rec);
  saveHistory(list.slice(-HISTORY_MAX));
  showEnd(rec);
}

function buildRecord() {
  const s = G.settings, st = G.stats;
  const hits = st.head + st.body;
  const avg = st.ttk.length ? st.ttk.reduce((a, b) => a + b, 0) / st.ttk.length : null;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    mode: s.mode, duration: s.duration, speed: s.speed, weapon: s.weapon, displayTime: s.displayTime,
    score: st.score, shots: st.shots, hits,
    accuracy: st.shots ? (hits / st.shots) * 100 : 0,
    head: st.head, body: st.body,
    hsPct: st.kills ? (st.head / st.kills) * 100 : 0,     // % de cibles éliminées d'une balle dans la tête
    kills: st.kills, missed: st.missed,
    avgTtk: avg
  };
}

function statPairs(r) {
  return [
    ['Mode', MODE_LABEL[r.mode] || r.mode],
    ['Durée', fmtDuration(r.duration)],
    ['Vitesse / arme', `${r.speed}/10 · ${WEAPON_LABEL[r.weapon] || r.weapon}`],
    ['Tirs', nf(r.shots)],
    ['Précision', `${nf(r.accuracy, 1)} %`],
    ['Tirs à la tête', nf(r.head)],
    ['Tirs au corps', nf(r.body)],
    ['% headshots', `${nf(r.hsPct, 1)} %`],
    ['Cibles éliminées', nf(r.kills)],
    ['Cibles ratées', nf(r.missed)],
    ['Temps moyen / cible', r.avgTtk == null ? '—' : `${nf(r.avgTtk, 2)} s`]
  ];
}

function showEnd(rec) {
  showScreen('menu');           // réinitialise les fenêtres, puis on masque le menu
  ui.menu.classList.remove('active');
  ui.hud.classList.add('hidden');
  $('endScore').textContent = nf(rec.score);
  $('endSub').textContent = `${MODE_LABEL[rec.mode]} · ${new Date(rec.date).toLocaleString('fr-FR')}`;
  const dl = $('endStats');
  dl.textContent = '';
  statPairs(rec).forEach(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd); dl.appendChild(d);
  });
  $('end').classList.add('active');
}

/* ---------------------------------------------------------------------
 *  Tir et recul
 * ------------------------------------------------------------------- */
const raycaster = new THREE.Raycaster();
raycaster.far = 120;
const CENTER = new THREE.Vector2(0, 0);

/* ----- Son du tir (synthétisé avec Web Audio : aucun fichier audio) ----- */
let audioCtx = null;
let noiseBuf = null;

function initAudio() {          // à appeler lors d'un clic (le navigateur l'exige)
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      noiseBuf = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * 0.25), audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { audioCtx = null; }
}

function playShot() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const master = audioCtx.createGain();
  master.gain.value = 0.35;
  master.connect(audioCtx.destination);

  // claquement : bruit filtré, très court
  const n = audioCtx.createBufferSource();
  n.buffer = noiseBuf;
  const hp = audioCtx.createBiquadFilter();
  hp.type = 'bandpass'; hp.frequency.value = 1800; hp.Q.value = 0.6;
  const ng = audioCtx.createGain();
  ng.gain.setValueAtTime(1, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  n.connect(hp); hp.connect(ng); ng.connect(master);
  n.start(t); n.stop(t + 0.14);

  // détonation grave
  const o = audioCtx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(170, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
  const og = audioCtx.createGain();
  og.gain.setValueAtTime(0.9, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  o.connect(og); og.connect(master);
  o.start(t); o.stop(t + 0.16);
}

function fire() {
  if (G.state !== 'playing') return;
  const st = G.stats;
  st.shots++;
  G.sinceShot = 0;
  playShot();

  // La balle part exactement dans l'axe de la caméra (visée + recul courant)
  updateCamera();
  scene.updateMatrixWorld(true);
  raycaster.setFromCamera(CENTER, camera);
  const objs = G.arena.occluders.slice();
  G.targets.forEach((t) => { if (t.alive) objs.push(...t.meshes); });
  const hit = raycaster.intersectObjects(objs, false)[0];
  const tgt = hit && hit.object.userData.target;
  const end = hit ? hit.point.clone() : raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, 60);
  const impact = hit ? (tgt ? hit.object.userData.zone : 'wall') : null;
  viewmodelFired(G.settings.weapon === 'auto');
  spawnTracer(muzzleWorldPosition(), end, impact);
  if (tgt) onHit(hit.object.userData.zone, hit.object.userData.target);

  applyRecoil();
}

function applyRecoil() {
  const r = G.recoil;
  if (G.settings.weapon === 'auto') {
    let right, up;
    if (r.idx < SPRAY.length) { [right, up] = SPRAY[r.idx]; }
    else { right = (Math.floor(r.idx / 4) % 2 ? 0.3 : -0.3); up = 0.03; }
    r.idx++;
    r.tgtR += right;
    r.tgtU += up;
  } else {
    r.tgtU = Math.min(SEMI_KICK_MAX, r.tgtU + SEMI_KICK);
  }
}

function updateRecoil(dt) {
  const r = G.recoil;
  G.sinceShot += dt;
  const hold = G.settings.weapon === 'auto' ? 0.2 : 0.3;
  if (G.sinceShot > hold) {              // bouton relâché : le recul se réinitialise
    r.idx = 0;
    const d = Math.exp(-9 * dt);
    r.tgtR *= d; r.tgtU *= d;
    if (Math.abs(r.tgtR) < 0.002) r.tgtR = 0;
    if (Math.abs(r.tgtU) < 0.002) r.tgtU = 0;
  }
  const f = 1 - Math.exp(-45 * dt);      // petit lissage visuel du coup de recul uniquement
  r.curR += (r.tgtR - r.curR) * f;
  r.curU += (r.tgtU - r.curU) * f;
}

/* ---------------------------------------------------------------------
 *  Impacts, cibles et effets
 * ------------------------------------------------------------------- */
function onHit(zone, t) {
  const st = G.stats;
  if (zone === 'head') {
    st.head++;
    st.score += SCORE.head;
    t.flash = 0.12; t.flashZone = 'head';
    feedback('head');
    killTarget(t, 'head');
  } else {
    st.body++;
    st.score += SCORE.body;
    t.hp--;
    t.flash = 0.1; t.flashZone = 'body';
    feedback('body');
    if (t.hp <= 0) killTarget(t, 'body');
  }
  updateHud();
}

function killTarget(t, zone) {
  t.alive = false;
  G.stats.kills++;
  G.stats.ttk.push(Math.max(0, G.t - t.born));
  if (zone === 'head') {
    t.headMat.emissive.setHex(COLORS.flashHead);
    burst(t);
    G.fx.push({ kind: 'shrink', t: 0, dur: 0.14, target: t });
  } else {
    t.bodyMat.emissive.setHex(COLORS.flashBody);
    G.fx.push({ kind: 'fall', t: 0, dur: 0.35, target: t });
  }
}

function missTarget(t) {
  t.alive = false;
  G.stats.missed++;
  G.fx.push({ kind: 'fade', t: 0, dur: 0.18, target: t });
  updateHud();
  pulse('hudMiss');
}

function burst(t) {
  const mat = new THREE.MeshBasicMaterial({ color: COLORS.flashHead, transparent: true });
  const parts = [];
  const origin = new THREE.Vector3(t.x, 1.62 * t.group.scale.y, t.z);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(GEO.spark, mat);
    m.position.copy(origin);
    scene.add(m);
    parts.push({ m, v: new THREE.Vector3(rand(-1.6, 1.6), rand(0.8, 3), rand(-1.6, 1.6)) });
  }
  G.fx.push({
    kind: 'burst', t: 0, dur: 0.45, parts, mat,
    cleanup() { parts.forEach((p) => scene.remove(p.m)); mat.dispose(); }
  });
}

/* ----- Balles lumineuses : points qui filent vers l'impact, puis point d'impact ----- */
const DOT_GEO = new THREE.SphereGeometry(1, 8, 6);
const dotMat = (color) => new THREE.MeshBasicMaterial({
  color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
});
const DOT_MAT = { tracer: dotMat(0xffe9a0), head: dotMat(0xff3b3b), body: dotMat(0xffffff), wall: dotMat(0xffd45e) };
const TRAIL = 4;

function spawnTracer(from, to, impact) {
  const dist = from.distanceTo(to);
  const dots = [];
  for (let k = 0; k < TRAIL; k++) {
    const m = new THREE.Mesh(DOT_GEO, DOT_MAT.tracer);
    m.position.copy(from);
    scene.add(m);
    dots.push(m);
  }
  G.fx.push({
    kind: 'tracer', t: 0, dur: clamp(dist / 170, 0.05, 0.4), from, to, dist, dots, impact,
    cleanup() { dots.forEach((d) => scene.remove(d)); }
  });
}

function spawnImpact(at, kind) {
  const m = new THREE.Mesh(DOT_GEO, DOT_MAT[kind] || DOT_MAT.wall);
  m.position.copy(at);
  scene.add(m);
  G.fx.push({ kind: 'impact', t: 0, dur: kind === 'head' ? 0.4 : 0.28, at, m, big: kind === 'head' ? 1.7 : 1,
    cleanup() { scene.remove(m); } });
}

function updateFx(dt) {
  for (let i = G.fx.length - 1; i >= 0; i--) {
    const f = G.fx[i];
    f.t += dt;
    const p = clamp(f.t / f.dur, 0, 1);
    if (f.kind === 'fall') {
      f.target.group.rotation.x = -p * 1.3;
      setTargetOpacity(f.target, 1 - p);
    } else if (f.kind === 'shrink') {
      f.target.group.scale.setScalar(1 - p * 0.6);
      setTargetOpacity(f.target, 1 - p);
    } else if (f.kind === 'fade') {
      setTargetOpacity(f.target, 1 - p);
    } else if (f.kind === 'tracer') {
      const dir = f.to.clone().sub(f.from).divideScalar(Math.max(f.dist, 1e-6));
      f.dots.forEach((d, k) => {
        const travelled = Math.max(0, Math.min(f.dist, p * f.dist - k * 0.7));
        d.position.copy(f.from).addScaledVector(dir, travelled);
        const dc = d.position.distanceTo(camera.position);
        d.scale.setScalar(Math.max(0.012, dc * 0.0042 * (1 - k * 0.2)));   // taille quasi constante à l'écran
      });
      if (p >= 1 && f.impact) spawnImpact(f.to, f.impact);
    } else if (f.kind === 'impact') {
      const dc = f.at.distanceTo(camera.position);
      f.m.scale.setScalar(Math.max(0.03, dc * 0.009 * f.big) * (1 - p * 0.8));
    } else if (f.kind === 'burst') {
      f.parts.forEach((q) => {
        q.v.y -= 9 * dt;
        q.m.position.addScaledVector(q.v, dt);
      });
      f.mat.opacity = 1 - p;
    }
    if (p >= 1) {
      if (f.target) disposeTarget(f.target);
      if (f.cleanup) f.cleanup();
      G.fx.splice(i, 1);
    }
  }
}

/* ----- Retour visuel (interface) ----- */
function feedback(zone) {
  const hm = $('hitmarker');
  hm.classList.remove('head', 'body');
  void hm.offsetWidth;                      // relance l'animation
  hm.classList.add(zone);

  const fl = document.createElement('div');
  fl.className = `floater ${zone}`;
  fl.textContent = zone === 'head' ? 'HEADSHOT +100' : '+25';
  $('floaters').appendChild(fl);
  setTimeout(() => fl.remove(), 750);

  pulse('hudScore');
  pulse(zone === 'head' ? 'hudHead' : 'hudBody');
}
function pulse(id) {
  const el = $(id);
  el.classList.remove('pulse');
  void el.offsetWidth;
  el.classList.add('pulse');
}

/* ---------------------------------------------------------------------
 *  Apparition et mouvement des cibles
 * ------------------------------------------------------------------- */
function spawnTarget() {
  const s = G.settings;
  const t = makeTarget();
  t.life = s.displayTime;
  t.born = G.t;

  if (s.mode === 'fixed') {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    for (let i = 0; i < 14; i++) {
      const az = rand(-42, 42) * DEG, d = rand(9, 24);
      t.x = Math.sin(az) * d; t.z = -Math.cos(az) * d;
      const dir = new THREE.Vector3(t.x - G.player.x, 1.4 - CS2.EYE, t.z - G.player.z).normalize();
      if (fwd.dot(dir) < Math.cos(10 * DEG)) break;       // évite d'apparaître sous le réticule
    }
  } else if (s.mode === 'moving') {
    t.z = -rand(12, 22);
    t.bound = Math.abs(t.z) * 0.5;
    t.x = rand(-t.bound, t.bound);
    t.vx = (Math.random() < 0.5 ? -1 : 1) * moveSpeed(s.speed);
    t.dirTimer = rand(0.6, 1.6);
  } else {
    // Déplacement : cible cachée derrière le mur, à gauche ou à droite de l'angle
    const side = Math.random() < 0.65 ? -G.lastSide : G.lastSide;
    G.lastSide = side;
    t.x = side * rand(5, 11);
    t.z = -rand(9, 18);
    if (s.mode === 'movement_moving') {          // ... et qui se déplace latéralement
      t.bound = 12;
      t.vx = (Math.random() < 0.5 ? -1 : 1) * moveSpeed(s.speed);
      t.dirTimer = rand(0.6, 1.6);
    }
  }
  t.group.position.set(t.x, 0, t.z);
  setTargetOpacity(t, 0);
  scene.add(t.group);
  G.targets.push(t);
}

function updateTargets(dt) {
  const s = G.settings;
  const maxActive = s.mode === 'moving' ? 2 : 1;
  const active = G.targets.filter((t) => t.alive).length;

  if (active < maxActive) {
    G.spawnTimer -= dt;
    if (G.spawnTimer <= 0) {
      spawnTarget();
      G.spawnTimer = s.mode === 'movement_moving' ? 0.5 : spawnGap(s.speed);
    }
  }

  for (let i = G.targets.length - 1; i >= 0; i--) {
    const t = G.targets[i];
    if (!t.alive) continue;      // retirée par son effet de disparition
    const age = G.t - t.born;

    if (hasMovingTargets(s.mode)) {
      t.x += t.vx * dt;
      if (t.x > t.bound) { t.x = t.bound; t.vx = -Math.abs(t.vx); }
      if (t.x < -t.bound) { t.x = -t.bound; t.vx = Math.abs(t.vx); }
      t.dirTimer -= dt;
      if (t.dirTimer <= 0) {
        if (Math.random() < 0.7) t.vx = -t.vx;
        t.dirTimer = rand(0.6, 1.6);
      }
      t.group.position.x = t.x;
    }

    // la silhouette fait face au joueur
    t.group.rotation.y = Math.atan2(G.player.x - t.x, G.player.z - t.z);
    if (age < 0.1) setTargetOpacity(t, Math.min(1, age / 0.08));   // apparition en fondu (la hitbox ne change pas)

    if (t.flash > 0) {
      t.flash -= dt;
      if (t.flash <= 0) { t.bodyMat.emissive.setHex(0); t.headMat.emissive.setHex(0); }
      else if (t.flashZone === 'head') t.headMat.emissive.setHex(COLORS.flashHead);
      else t.bodyMat.emissive.setHex(0x888888);
    }

    if (age >= t.life) missTarget(t);
  }
}

/* ---------------------------------------------------------------------
 *  Déplacement du joueur (mode « Déplacement »)
 * ------------------------------------------------------------------- */
function collides(x, z) {
  const r = CS2.PLAYER_R;
  for (const c of G.arena.colliders) {
    if (x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) return true;
  }
  return false;
}

function updatePlayer(dt) {
  const p = G.player, k = G.keys;
  const fwd = (k.f ? 1 : 0) - (k.b ? 1 : 0);
  const str = (k.r ? 1 : 0) - (k.l ? 1 : 0);
  const yaw = G.view.yaw * DEG;
  // vecteurs avant / droite dans le plan horizontal
  let wx = -Math.sin(yaw) * fwd + Math.cos(yaw) * str;
  let wz = -Math.cos(yaw) * fwd - Math.sin(yaw) * str;
  const len = Math.hypot(wx, wz);
  if (len > 0) { wx = (wx / len) * CS2.RUN; wz = (wz / len) * CS2.RUN; }

  const a = 1 - Math.exp(-18 * dt);       // accélération / arrêt rapides, façon CS
  p.vx += (wx - p.vx) * a;
  p.vz += (wz - p.vz) * a;
  if (Math.abs(p.vx) < 0.01) p.vx = 0;
  if (Math.abs(p.vz) < 0.01) p.vz = 0;

  // déplacement par petits pas et par axe : pas de traversée de mur, glissement le long des murs
  const steps = Math.max(1, Math.ceil(dt / 0.01));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const nx = p.x + p.vx * h;
    if (!collides(nx, p.z)) p.x = nx; else p.vx = 0;
    const nz = p.z + p.vz * h;
    if (!collides(p.x, nz)) p.z = nz; else p.vz = 0;
  }
}

/* ---------------------------------------------------------------------
 *  Interface en jeu
 * ------------------------------------------------------------------- */
function updateHud(force) {
  const st = G.stats;
  if (!st) return;
  const remaining = G.settings ? Math.max(0, G.settings.duration - (G.state === 'countdown' ? 0 : G.t)) : 0;
  const vals = {
    hudTime: fmtClock(remaining), hudScore: String(st.score),
    hudHead: String(st.head), hudBody: String(st.body), hudMiss: String(st.missed)
  };
  for (const id in vals) {
    if (force || G.lastHud[id] !== vals[id]) { $(id).textContent = vals[id]; G.lastHud[id] = vals[id]; }
  }
  $('hudTime').classList.toggle('low', remaining <= 10 && G.state === 'playing');
}

/* ---------------------------------------------------------------------
 *  Boucle principale
 * ------------------------------------------------------------------- */
let lastTs = 0;

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
  lastTs = ts;

  if (G.state === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown);
    $('countdown').textContent = n > 0 ? String(n) : '';
    if (G.countdown <= 0) { G.state = 'playing'; $('countdown').textContent = ''; }
    updateRecoil(dt);
    updateViewmodel(dt);
  } else if (G.state === 'playing') {
    update(dt);
  }

  if (renderer && (G.state === 'countdown' || G.state === 'playing')) {
    updateCamera();
    renderAll();
  }
}

function update(dt) {
  G.t += dt;
  if (hasWalking(G.settings.mode)) updatePlayer(dt);
  updateRecoil(dt);

  // cadence automatique en rafale
  G.cooldown -= dt;
  if (G.settings.weapon === 'auto' && G.holding) {
    if (G.cooldown < -AUTO_INTERVAL) G.cooldown = 0;
    while (G.cooldown <= 0 && G.state === 'playing') {
      fire();
      G.cooldown += AUTO_INTERVAL;
    }
  } else if (G.cooldown < 0) {
    G.cooldown = 0;
  }

  updateViewmodel(dt);
  updateCamera();
  updateTargets(dt);
  updateFx(dt);
  updateHud();

  if (G.t >= G.settings.duration) finishSession();
}

/* ---------------------------------------------------------------------
 *  Entrées
 * ------------------------------------------------------------------- */
document.addEventListener('mousemove', onMouseMove);

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !G.locked || G.state !== 'playing') return;
  G.holding = true;
  if (G.cooldown <= 0) {
    fire();
    G.cooldown = G.settings.weapon === 'auto' ? AUTO_INTERVAL : SEMI_INTERVAL;
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) G.holding = false; });
document.addEventListener('contextmenu', (e) => { if (G.state !== 'menu' && G.state !== 'ended') e.preventDefault(); });

const KEYMAP = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r'
};   // codes physiques : sur un clavier AZERTY, ce sont bien Z Q S D

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (G.state === 'playing' || G.state === 'countdown') { e.preventDefault(); pauseGame(); }
    return;
  }
  const dir = KEYMAP[e.code];
  if (dir && (G.state === 'playing' || G.state === 'countdown')) {
    e.preventDefault();
    if (hasWalking(G.settings.mode)) G.keys[dir] = true;
  }
});
document.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.code];
  if (dir) G.keys[dir] = false;
});
window.addEventListener('blur', () => { G.holding = false; G.keys = { f: false, b: false, l: false, r: false }; });

/* ---------------------------------------------------------------------
 *  Historique
 * ------------------------------------------------------------------- */
function loadHistory() {
  const h = storageGet(STORAGE_HISTORY, []);
  return Array.isArray(h) ? h.filter((r) => r && typeof r === 'object') : [];
}
function saveHistory(list) { storageSet(STORAGE_HISTORY, list); }

const histState = { filter: 'all', pendingDelete: null, pendingClear: false, charts: {} };

function renderHistory() {
  const all = loadHistory();
  const rows = all
    .filter((r) => histState.filter === 'all' || r.mode === histState.filter)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  $('histCount').textContent = all.length
    ? `${rows.length} séance${rows.length > 1 ? 's' : ''} affichée${rows.length > 1 ? 's' : ''} sur ${all.length}`
    : 'Aucune séance pour le moment';
  $('histEmpty').hidden = rows.length > 0;
  $('histEmpty').textContent = all.length
    ? 'Aucune séance pour ce mode.'
    : 'Aucune séance enregistrée pour le moment. Lancez une séance depuis le menu.';

  renderClearArea(all.length);
  renderTable(rows.slice().reverse());

  const lbl = (r) => new Date(r.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  drawChart('chartScore', rows.map((r) => ({ v: r.score, label: lbl(r), tip: `${nf(r.score)} pts` })), '#f5a623');
  drawChart('chartTime', rows.map((r) => ({
    v: r.avgTtk == null ? null : r.avgTtk, label: lbl(r),
    tip: r.avgTtk == null ? 'aucune élimination' : `${nf(r.avgTtk, 2)} s`
  })), '#4dc3ff', (v) => nf(v, 2));
}

function renderClearArea(count) {
  const box = $('clearArea');
  box.textContent = '';
  if (!count) return;
  if (!histState.pendingClear) {
    const b = document.createElement('button');
    b.id = 'clearBtn'; b.className = 'btn danger'; b.type = 'button'; b.textContent = 'Tout supprimer';
    b.addEventListener('click', () => { histState.pendingClear = true; histState.pendingDelete = null; renderHistory(); });
    box.appendChild(b);
    return;
  }
  const t = document.createElement('span');
  t.className = 'confirm-text';
  t.textContent = `Supprimer définitivement les ${count} séance${count > 1 ? 's' : ''} ?`;
  const yes = document.createElement('button');
  yes.className = 'btn confirm'; yes.type = 'button'; yes.textContent = 'Oui, tout supprimer';
  yes.addEventListener('click', () => { saveHistory([]); histState.pendingClear = false; renderHistory(); });
  const no = document.createElement('button');
  no.className = 'btn'; no.type = 'button'; no.textContent = 'Annuler';
  no.addEventListener('click', () => { histState.pendingClear = false; renderHistory(); });
  box.append(t, yes, no);
}

function renderTable(rows) {
  const body = $('histBody');
  body.textContent = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
      return td;
    };
    cell(new Date(r.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));
    cell(MODE_LABEL[r.mode] || r.mode);
    cell(fmtDuration(r.duration || 0));
    cell(`${r.speed}/10`);
    cell(WEAPON_LABEL[r.weapon] || r.weapon);
    cell(nf(r.score || 0), 'num score');
    cell(nf(r.shots || 0), 'num');
    cell(`${nf(r.accuracy || 0, 1)} %`, 'num');
    cell(nf(r.head || 0), 'num');
    cell(nf(r.body || 0), 'num');
    cell(`${nf(r.hsPct || 0, 1)} %`, 'num');
    cell(nf(r.kills || 0), 'num');
    cell(nf(r.missed || 0), 'num');
    cell(r.avgTtk == null ? '—' : `${nf(r.avgTtk, 2)} s`, 'num');

    const td = document.createElement('td');
    td.className = 'num';
    if (histState.pendingDelete === r.id) {
      const wrap = document.createElement('span');
      wrap.className = 'confirm-inline';
      const yes = document.createElement('button');
      yes.className = 'btn small confirm'; yes.type = 'button'; yes.textContent = 'Supprimer';
      yes.addEventListener('click', () => {
        saveHistory(loadHistory().filter((x) => x.id !== r.id));
        histState.pendingDelete = null;
        renderHistory();
      });
      const no = document.createElement('button');
      no.className = 'btn small'; no.type = 'button'; no.textContent = 'Annuler';
      no.addEventListener('click', () => { histState.pendingDelete = null; renderHistory(); });
      wrap.append(yes, no);
      td.appendChild(wrap);
    } else {
      const del = document.createElement('button');
      del.className = 'btn small danger'; del.type = 'button'; del.textContent = '✕ Supprimer';
      del.setAttribute('aria-label', 'Supprimer cette séance');
      del.addEventListener('click', () => { histState.pendingDelete = r.id; histState.pendingClear = false; renderHistory(); });
      td.appendChild(del);
    }
    tr.appendChild(td);
    body.appendChild(tr);
  });
}

/* ----- Courbes (canvas 2D) ----- */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function drawChart(id, points, color, fmtY = (v) => nf(v), hoverIdx = -1) {
  const cv = $(id);
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 190;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '12px system-ui, sans-serif';

  const L = 52, R = 16, T = 14, B = 28;
  const pw = W - L - R, ph = H - T - B;
  const vals = points.map((p) => p.v).filter((v) => v != null);

  if (!vals.length) {
    g.fillStyle = '#8d96a8'; g.textAlign = 'center';
    g.fillText('Pas encore de données', W / 2, H / 2);
    histState.charts[id] = { pts: [] };
    return;
  }

  const max = niceMax(Math.max(...vals) * 1.05);
  const y = (v) => T + ph - (v / max) * ph;
  const n = points.length;
  const x = (i) => (n === 1 ? L + pw / 2 : L + (i / (n - 1)) * pw);

  // grille + axe Y
  g.strokeStyle = '#2b3140'; g.fillStyle = '#8d96a8'; g.lineWidth = 1; g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = Math.round(y(v)) + 0.5;
    g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
    g.fillText(fmtY(v), L - 8, yy + 4);
  }
  // axe X (dates)
  g.textAlign = 'center';
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 70))));
  for (let i = 0; i < n; i += step) g.fillText(points[i].label, x(i), H - 8);

  // courbe
  g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  let pen = false;
  points.forEach((p, i) => {
    if (p.v == null) { pen = false; return; }
    if (!pen) { g.moveTo(x(i), y(p.v)); pen = true; } else g.lineTo(x(i), y(p.v));
  });
  g.stroke();

  const pts = [];
  g.fillStyle = color;
  points.forEach((p, i) => {
    if (p.v == null) return;
    const px = x(i), py = y(p.v);
    pts.push({ i, px, py });
    g.beginPath(); g.arc(px, py, i === hoverIdx ? 5.5 : 3.5, 0, Math.PI * 2); g.fill();
  });
  histState.charts[id] = { pts, points, color, fmtY };

  // info-bulle
  if (hoverIdx >= 0) {
    const p = points[hoverIdx], q = pts.find((e) => e.i === hoverIdx);
    if (p && q) {
      const text = `${p.label} · ${p.tip}`;
      const tw = g.measureText(text).width + 16;
      const bx = clamp(q.px - tw / 2, 4, W - tw - 4), by = q.py > 50 ? q.py - 34 : q.py + 12;
      g.fillStyle = '#0b0e13'; g.strokeStyle = color;
      g.beginPath(); g.roundRect ? g.roundRect(bx, by, tw, 22, 6) : g.rect(bx, by, tw, 22);
      g.fill(); g.stroke();
      g.fillStyle = '#e6e9ef'; g.textAlign = 'left';
      g.fillText(text, bx + 8, by + 15);
    }
  }
}

function setupChartHover(id) {
  const cv = $(id);
  cv.addEventListener('mousemove', (e) => {
    const c = histState.charts[id];
    if (!c || !c.pts.length) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null;
    c.pts.forEach((p) => { if (!best || Math.abs(p.px - mx) < Math.abs(best.px - mx)) best = p; });
    drawChart(id, c.points, c.color, c.fmtY, best.i);
  });
  cv.addEventListener('mouseleave', () => {
    const c = histState.charts[id];
    if (c && c.pts.length) drawChart(id, c.points, c.color, c.fmtY, -1);
  });
}

/* ---------------------------------------------------------------------
 *  Câblage de l'interface
 * ------------------------------------------------------------------- */
function init() {
  writeSettings(loadSettings());
  refreshMenuInfo();

  const live = ['durMin', 'durSec', 'displayTime', 'dpi', 'sens', 'speed'];
  live.forEach((id) => {
    $(id).addEventListener('input', refreshMenuInfo);
    $(id).addEventListener('change', commitSettings);
  });
  document.querySelectorAll('input[name="mode"], input[name="weapon"]').forEach((r) => r.addEventListener('change', commitSettings));

  $('startBtn').addEventListener('click', startSession);
  $('historyBtn').addEventListener('click', () => { commitSettings(); showScreen('history'); });
  $('histBack').addEventListener('click', () => showScreen('menu'));
  $('histFilter').addEventListener('change', (e) => {
    histState.filter = e.target.value; histState.pendingDelete = null; renderHistory();
  });
  setupChartHover('chartScore');
  setupChartHover('chartTime');

  $('resumeBtn').addEventListener('click', resumeGame);
  $('quitBtn').addEventListener('click', quitToMenu);
  $('againBtn').addEventListener('click', startSession);
  $('endMenuBtn').addEventListener('click', () => showScreen('menu'));
  $('endHistBtn').addEventListener('click', () => showScreen('history'));

  window.addEventListener('resize', onResize);
  onResize();
  if (webglError) { ui.startError.textContent = webglError; ui.startError.hidden = false; }
  requestAnimationFrame((ts) => { lastTs = ts; requestAnimationFrame(frame); });
}

init();
