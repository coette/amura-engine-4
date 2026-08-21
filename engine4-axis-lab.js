import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  WebGLRenderer
} from "./vendor/three/three.module.js";

const REVISION = "R1.7";
const DEFAULT_LENGTH_MM = 180;
const WATCH_SHIFT_MM = -24;

let wristYmm = 0;
let wristZmm = 0;
let offsetYmm = 0;
let offsetZmm = 0;
let watchState = 0;
let paused = false;
let pauseRaf = 0;

let trackingRig = null;
let assembly = null;
let wristMesh = null;
let watchAnchor = null;
let virtualAxis = null;
let lastRenderer = null;
let lastScene = null;
let lastCamera = null;
const watchBasePosition = new Vector3();
const video = document.getElementById("cameraVideo");

function readDimensions(showError = false) {
  const yInput = document.getElementById("wristDimY");
  const zInput = document.getElementById("wristDimZ");
  const error = document.getElementById("wristDimError");
  const y = Number(String(yInput?.value || "").replace(",", "."));
  const z = Number(String(zInput?.value || "").replace(",", "."));
  const valid = Number.isFinite(y) && Number.isFinite(z) && y >= 20 && y <= 120 && z >= 20 && z <= 120;

  if (!valid) {
    if (showError && error) error.textContent = "INTRODUCE Y Y Z EN MILÍMETROS ANTES DE ABRIR CÁMARA O BANCO";
    return false;
  }

  wristYmm = y;
  wristZmm = z;
  if (error) error.textContent = `MUÑECA VIRTUAL · Y ${y.toFixed(1)} mm · Z ${z.toFixed(1)} mm`;
  applyAssemblyGeometry();
  updateLabValues();
  return true;
}

function applyAssemblyGeometry() {
  if (!wristMesh || !assembly || !wristYmm || !wristZmm) return;

  // La muñeca conserva el contacto del reloj en su superficie local z=0.
  // El ensamblaje completo se desplaza -Z/2 para que su eje geométrico
  // (violeta) quede exactamente en el origen del rig, es decir, sobre
  // el eje naranja cuando los sliders Y/Z están a cero.
  wristMesh.scale.x = wristYmm / 2;
  wristMesh.scale.z = wristZmm / 2;
  wristMesh.position.z = wristZmm / 2;

  if (virtualAxis) virtualAxis.position.set(0, 0, wristZmm / 2);

  assembly.position.set(
    0,
    offsetYmm,
    offsetZmm - wristZmm / 2
  );
}

function applyWatchState() {
  if (!watchAnchor) return;
  watchAnchor.position.copy(watchBasePosition);
  if (watchState === 1) watchAnchor.position.x += WATCH_SHIFT_MM;
  watchAnchor.visible = watchState !== 2;
}

function ensureVirtualAxis() {
  if (!assembly || virtualAxis) return;
  const geometry = new CylinderGeometry(1.15, 1.15, DEFAULT_LENGTH_MM, 12);
  const material = new MeshBasicMaterial({
    color: 0xc03cff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95
  });
  virtualAxis = new Mesh(geometry, material);
  virtualAxis.name = "AMURA_ENGINE4_VIRTUAL_WRIST_AXIS";
  virtualAxis.rotation.z = Math.PI / 2;
  virtualAxis.renderOrder = 100000;
  assembly.add(virtualAxis);
}

function bindRig(scene) {
  if (trackingRig?.parent) return true;
  const rig = scene?.getObjectByName?.("AMURA_R18_WRIST_WATCH_RIG");
  if (!rig) return false;
  const anchor = rig.getObjectByName?.("AMURA_R18_WATCH_ANCHOR");
  const wrist = rig.getObjectByName?.("AMURA_R18_WRIST_OCCLUDER");
  if (!anchor || !wrist) return false;

  trackingRig = rig;
  watchAnchor = anchor;
  wristMesh = wrist;
  watchBasePosition.copy(anchor.position);

  assembly = new Group();
  assembly.name = "AMURA_ENGINE4_VIRTUAL_WRIST_ASSEMBLY";
  rig.add(assembly);
  rig.remove(anchor); assembly.add(anchor);
  rig.remove(wrist); assembly.add(wrist);

  ensureVirtualAxis();
  applyAssemblyGeometry();
  applyWatchState();
  updateLabValues();
  return true;
}

const originalRender = WebGLRenderer.prototype.render;
if (!WebGLRenderer.prototype.__amuraEngine4LabR17) {
  WebGLRenderer.prototype.__amuraEngine4LabR17 = true;
  WebGLRenderer.prototype.render = function patchedEngine4Render(scene, camera) {
    if (bindRig(scene)) {
      lastRenderer = this;
      lastScene = scene;
      lastCamera = camera;
      applyAssemblyGeometry();
      applyWatchState();
    }
    return originalRender.call(this, scene, camera);
  };
}

function forceRender() {
  if (!lastRenderer || !lastScene || !lastCamera) return;
  applyAssemblyGeometry();
  applyWatchState();
  lastScene.updateMatrixWorld?.(true);
  originalRender.call(lastRenderer, lastScene, lastCamera);
}

function stopPauseRenderLoop() {
  if (pauseRaf) cancelAnimationFrame(pauseRaf);
  pauseRaf = 0;
}

function startPauseRenderLoop() {
  stopPauseRenderLoop();
  const tick = () => {
    if (!paused) {
      pauseRaf = 0;
      return;
    }
    forceRender();
    pauseRaf = requestAnimationFrame(tick);
  };
  pauseRaf = requestAnimationFrame(tick);
}

function watchLabel() {
  if (watchState === 0) return "RELOJ X = 0";
  if (watchState === 1) return "RELOJ X = -24 mm";
  return "RELOJ OCULTO";
}

function pauseLabel() {
  return paused ? "REANUDAR" : "PAUSA";
}

function updateLabValues() {
  const yValue = document.getElementById("axisOffsetYValue");
  const zValue = document.getElementById("axisOffsetZValue");
  const watchButton = document.getElementById("watchCycleButton");
  const pauseButton = document.getElementById("pauseResumeButton");
  const dims = document.getElementById("labDimensions");
  if (yValue) yValue.textContent = `${offsetYmm >= 0 ? "+" : ""}${offsetYmm.toFixed(1)} mm`;
  if (zValue) zValue.textContent = `${offsetZmm >= 0 ? "+" : ""}${offsetZmm.toFixed(1)} mm`;
  if (watchButton) watchButton.textContent = watchLabel();
  if (pauseButton) {
    pauseButton.textContent = pauseLabel();
    pauseButton.classList.toggle("paused", paused);
  }
  if (dims && wristYmm && wristZmm) dims.textContent = `MUÑECA · Y ${wristYmm.toFixed(1)} · Z ${wristZmm.toFixed(1)} mm`;
}

async function setPaused(value) {
  const next = Boolean(value);
  if (next === paused) return;

  if (next) {
    if (document.body.dataset.status !== "live" || !video) return;
    paused = true;
    window.AmuraEngine4Paused = true;
    document.body.dataset.labPaused = "true";
    try { video.pause(); } catch (_) {}
    forceRender();
    startPauseRenderLoop();
  } else {
    paused = false;
    stopPauseRenderLoop();
    window.AmuraEngine4Paused = false;
    delete document.body.dataset.labPaused;
    if (video) {
      try { await video.play(); } catch (error) { console.warn("R1.7: no se pudo reanudar vídeo", error); }
    }
  }
  updateLabValues();
}

function installUi() {
  const startButton = document.getElementById("startButton");
  const yInput = document.getElementById("wristDimY");
  const zInput = document.getElementById("wristDimZ");
  const ySlider = document.getElementById("axisOffsetY");
  const zSlider = document.getElementById("axisOffsetZ");
  const watchButton = document.getElementById("watchCycleButton");
  const pauseButton = document.getElementById("pauseResumeButton");

  yInput?.addEventListener("input", () => readDimensions(false));
  zInput?.addEventListener("input", () => readDimensions(false));

  startButton?.addEventListener("click", (event) => {
    if (readDimensions(true)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    yInput?.focus();
  }, true);

  ySlider?.addEventListener("input", () => {
    offsetYmm = Number(ySlider.value) || 0;
    applyAssemblyGeometry();
    updateLabValues();
    forceRender();
  });

  zSlider?.addEventListener("input", () => {
    offsetZmm = Number(zSlider.value) || 0;
    applyAssemblyGeometry();
    updateLabValues();
    forceRender();
  });

  watchButton?.addEventListener("click", () => {
    watchState = (watchState + 1) % 3;
    applyWatchState();
    updateLabValues();
    forceRender();
  });

  pauseButton?.addEventListener("click", () => setPaused(!paused));

  document.getElementById("axisResetButton")?.addEventListener("click", () => {
    offsetYmm = 0;
    offsetZmm = 0;
    watchState = 0;
    if (ySlider) ySlider.value = "0";
    if (zSlider) zSlider.value = "0";
    applyAssemblyGeometry();
    applyWatchState();
    updateLabValues();
    forceRender();
  });

  updateLabValues();
}

function rescueBadgeActive(text) {
  return /CONGELADO|RELOCALIZANDO|ESPERANDO P0|PERDIDO/i.test(text || "");
}

function updateRescueBadge() {
  const badge = document.getElementById("r17RescueBadge");
  if (!badge) return;
  badge.classList.toggle("engine4-rescue-active", !paused && rescueBadgeActive(badge.textContent));
}

window.addEventListener("amura-camera-state", (event) => {
  if (!event.detail || event.detail.status !== "live") {
    paused = false;
    stopPauseRenderLoop();
    window.AmuraEngine4Paused = false;
    delete document.body.dataset.labPaused;
    updateLabValues();
  }
});

window.addEventListener("pagehide", stopPauseRenderLoop);

installUi();
setInterval(updateRescueBadge, 200);
window.AmuraEngine4Paused = false;

window.AmuraEngine4AxisLab = {
  revision: REVISION,
  readDimensions,
  setPaused,
  forceRender,
  get state() {
    return {
      wristYmm,
      wristZmm,
      offsetYmm,
      offsetZmm,
      watchState,
      paused,
      watchShiftMm: watchState === 1 ? WATCH_SHIFT_MM : 0,
      rigBound: Boolean(trackingRig),
      axisBound: Boolean(virtualAxis),
      centerAxisOffsetYmm: offsetYmm,
      centerAxisOffsetZmm: offsetZmm
    };
  }
};
