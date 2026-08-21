import {
  ACESFilmicToneMapping,
  AmbientLight,
  CapsuleGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/three/addons/loaders/DRACOLoader.js";

const REVISION = "R18.0.0";
const MODEL_URL = "./models/A1-Irontide-AR-pretty-mobile.glb?v=r18.0.0";
const MODEL_CONFIG_URL = "./models/A1-Irontide-AR-pretty-mobile.json?v=r18.0.0";
const MODEL_Z_OFFSET_RADIANS = 0;
const MODEL_X_OFFSET_RADIANS = Math.PI;
const CALIBRATION_MS = 500;
const MIN_CALIBRATION_SAMPLES = 6;
const AXIS_FRESH_MS = 650;
const RECOVERY_BLEND_MS = 420;
const WRIST_WIDTH_MM = 62;
const WRIST_THICKNESS_MM = 44;
const WRIST_LENGTH_MM = 150;

const DEFAULT_MODEL_CONFIG = {
  asset: "A1-Irontide-AR-pretty-mobile.glb",
  scaleToMillimeters: 1000,
  rootNode: "AMURA_AR_ROOT",
  contactNode: "AMURA_CASEBACK_CONTACT"
};

const canvas = document.getElementById("threeCanvas");
const maskCanvas = document.getElementById("maskCanvas");
const video = document.getElementById("cameraVideo");
const readyButton = document.getElementById("maskReadyButton");
const resetButton = document.getElementById("maskResetButton");

const scene = new Scene();
const camera = new PerspectiveCamera(50, 1, 1, 20000);
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);
scene.background = null;

scene.add(new HemisphereLight(0xe8efff, 0x24182f, 2.25));
scene.add(new AmbientLight(0xffffff, 0.85));
const keyLight = new DirectionalLight(0xffffff, 3.2);
keyLight.position.set(-280, 420, 780);
scene.add(keyLight);
const rimLight = new DirectionalLight(0xa992ff, 1.8);
rimLight.position.set(420, -160, 520);
scene.add(rimLight);

const orientationMatrix = new Matrix4();
const qScreen = new Quaternion();
const zAxis = new Vector3(0, 0, 1);
const tmpX = new Vector3();
const tmpY = new Vector3();
const tmpZ = new Vector3();
const targetPosition = new Vector3();
const contactWorldPosition = new Vector3();

let renderer = null;
let wristRig = null;
let watchAnchor = null;
let watchModel = null;
let wristOccluder = null;
let wristMaterial = null;
let modelConfig = DEFAULT_MODEL_CONFIG;
let contactOffsetInAnchor = new Vector3();
let modelStatus = "en espera";
let modelError = "";
let modelPromise = null;
let viewportWidth = 0;
let viewportHeight = 0;
let lastFovYDegrees = 50;
let lastDepthMm = 0;
let lastPalmWidthMm = 0;
let lastReprojectionErrorPx = 0;

let wristMode = 1;
let appliedWristMode = -1;

let calibrationArmed = false;
let calibrationStartedAt = 0;
let depthSamples = [];
let longitudinalSamplesMm = [];
let fixedDepthMm = 0;
let p0LongitudinalOffsetMm = 0;
let calibratedOnce = false;

let lastMpBaseQuaternion = null;
let lastMpHandAngle = null;
let hasRigPose = false;
let cloudWasBad = false;
let recoveryUntil = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function wrapAngle(radians) {
  let a = radians;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function parseVector(value) {
  if (!value || value === "—") return null;
  const n = String(value).split(",").map((v) => Number(v.trim()));
  if (n.length < 2 || !Number.isFinite(n[0]) || !Number.isFinite(n[1])) return null;
  return { x: n[0], y: n[1], z: Number.isFinite(n[2]) ? n[2] : 0 };
}

function currentP0() {
  const d = window.AmuraTrackingDiagnostics || {};
  if (d["Mano detectada"] !== "sí") return null;
  return parseVector(d["Origen muñeca"]);
}

function currentAxis() {
  const metrics = window.AmuraR16AxisMetrics;
  const final = metrics && metrics.final;
  if (!final || !final.start || !final.end || !final.midpoint) return null;
  const now = performance.now();
  if (!Number.isFinite(metrics.updatedAt) || now - metrics.updatedAt > AXIS_FRESH_MS) return null;
  const dx = final.end.x - final.start.x;
  const dy = final.end.y - final.start.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 12) return null;
  return {
    midpoint: { x: final.midpoint.x, y: final.midpoint.y },
    elbowDir: { x: dx / length, y: dy / length },
    updatedAt: metrics.updatedAt
  };
}

function centersShapeOk(points) {
  if (!points || points.length < 5) return false;
  const mean = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length
  };
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const a = 0.5 * Math.atan2(2 * xy, xx - yy);
  const d = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -d.y, y: d.x };
  const along = points.map((p) => (p.x - mean.x) * d.x + (p.y - mean.y) * d.y);
  const cross = points.map((p) => Math.abs((p.x - mean.x) * n.x + (p.y - mean.y) * n.y));
  const span = Math.max(...along) - Math.min(...along);
  const rms = Math.sqrt(cross.reduce((s, v) => s + v * v, 0) / cross.length);
  return Number.isFinite(span) && span >= 28 && rms / span <= 0.24;
}

function cloudHealthy(axis = currentAxis()) {
  if (!axis) return false;
  const rescue = window.AmuraR17Rescue && window.AmuraR17Rescue.state;
  if (rescue && (
    rescue.badCount > 0 ||
    rescue.frozen ||
    rescue.waitingForP0 ||
    rescue.rescuing
  )) return false;

  const lab = window.AmuraForearmMaskLab;
  if (!lab || typeof lab.snapshot !== "function") return false;
  let snapshot = null;
  try { snapshot = lab.snapshot(); } catch (_) { return false; }
  if (!snapshot || !snapshot.calibrated) return false;

  const cm = snapshot.currentMetrics;
  if (!cm) return false;
  const coverage = Number(cm.coverage);
  if (!Number.isFinite(coverage) || coverage < 0.02 || coverage > 1.15) return false;
  if (!Number.isFinite(cm.axisCenters) || cm.axisCenters < 3) return false;
  if (video && video.videoWidth && Number.isFinite(cm.widthPx)) {
    const fraction = cm.widthPx / video.videoWidth;
    if (fraction < 0.015 || fraction > 0.60) return false;
  }

  const r16 = window.AmuraR16AxisMetrics;
  if (!r16 || !centersShapeOk(r16.baseCenters || [])) return false;
  return true;
}

function layoutFor(viewW, viewH) {
  const maskW = maskCanvas && maskCanvas.width ? maskCanvas.width : 0;
  const maskH = maskCanvas && maskCanvas.height ? maskCanvas.height : 0;
  if (!maskW || !maskH || !viewW || !viewH) return null;
  const scale = Math.max(viewW / maskW, viewH / maskH);
  return {
    maskW,
    maskH,
    scale,
    cropX: (maskW * scale - viewW) * 0.5,
    cropY: (maskH * scale - viewH) * 0.5
  };
}

function displayFocal(viewH, fovYDegrees) {
  const fov = clamp(Number(fovYDegrees) || 50, 10, 150) * Math.PI / 180;
  return viewH / (2 * Math.tan(fov * 0.5));
}

function axisHandAngle(axis) {
  const handX = -axis.elbowDir.x;
  const handY = axis.elbowDir.y;
  return Math.atan2(handY, handX);
}

function alignedMpQuaternion(pose, axis) {
  if (!pose || !pose.xAxis || !pose.yAxis || !pose.zAxis || !axis) return null;

  tmpX.set(pose.xAxis.x, pose.xAxis.y, pose.xAxis.z).normalize();
  tmpY.set(pose.yAxis.x, pose.yAxis.y, pose.yAxis.z).normalize();
  tmpZ.set(pose.zAxis.x, pose.zAxis.y, pose.zAxis.z).normalize();

  const projected = Math.hypot(tmpX.x, tmpX.y);
  if (!Number.isFinite(projected) || projected < 0.06) return null;

  const currentAngle = Math.atan2(tmpX.y, tmpX.x);
  const desiredAngle = axisHandAngle(axis);
  const delta = wrapAngle(desiredAngle - currentAngle);

  qScreen.setFromAxisAngle(zAxis, delta);
  tmpX.applyQuaternion(qScreen).normalize();
  tmpY.applyQuaternion(qScreen).normalize();
  tmpZ.applyQuaternion(qScreen).normalize();

  orientationMatrix.makeBasis(tmpX, tmpY, tmpZ);
  const q = new Quaternion().setFromRotationMatrix(orientationMatrix).normalize();
  return { quaternion: q, handAngle: desiredAngle };
}

function heldQuaternionForAxis(axis) {
  if (!lastMpBaseQuaternion || !Number.isFinite(lastMpHandAngle) || !axis) return null;
  const desiredAngle = axisHandAngle(axis);
  const delta = wrapAngle(desiredAngle - lastMpHandAngle);
  const q = new Quaternion().setFromAxisAngle(zAxis, delta);
  q.multiply(lastMpBaseQuaternion);
  return q.normalize();
}

function targetFromAxis(axis, viewW, viewH, fovYDegrees) {
  if (!axis || !fixedDepthMm) return null;
  const layout = layoutFor(viewW, viewH);
  if (!layout) return null;
  const focal = displayFocal(viewH, fovYDegrees);
  if (!Number.isFinite(focal) || focal <= 0) return null;

  const mmPerMaskPixel = layout.scale * fixedDepthMm / focal;
  if (!Number.isFinite(mmPerMaskPixel) || mmPerMaskPixel <= 0) return null;

  const tPixels = p0LongitudinalOffsetMm / mmPerMaskPixel;
  const maskPoint = {
    x: axis.midpoint.x + axis.elbowDir.x * tPixels,
    y: axis.midpoint.y + axis.elbowDir.y * tPixels
  };

  let displayX = maskPoint.x * layout.scale - layout.cropX;
  const displayY = maskPoint.y * layout.scale - layout.cropY;
  if (document.body.dataset.facing === "user") {
    displayX = viewW - displayX;
  }

  targetPosition.set(
    (displayX - viewW * 0.5) * fixedDepthMm / focal,
    -(displayY - viewH * 0.5) * fixedDepthMm / focal,
    -fixedDepthMm
  );
  return targetPosition;
}

function depthCandidate(pose) {
  const d = Number(pose && pose.depthMm);
  if (Number.isFinite(d) && d >= 120 && d <= 1800) return d;
  const z = Math.abs(Number(pose && pose.positionMm && pose.positionMm.z));
  return Number.isFinite(z) && z >= 120 && z <= 1800 ? z : 0;
}

function longitudinalOffsetSampleMm(axis, depth, viewW, viewH, fovYDegrees) {
  const p0 = currentP0();
  const layout = layoutFor(viewW, viewH);
  if (!p0 || !layout || !axis || !depth) return null;

  const p0Mask = {
    x: p0.x * layout.maskW,
    y: p0.y * layout.maskH
  };
  const deltaPx =
    (p0Mask.x - axis.midpoint.x) * axis.elbowDir.x +
    (p0Mask.y - axis.midpoint.y) * axis.elbowDir.y;

  const focal = displayFocal(viewH, fovYDegrees);
  const mmPerMaskPixel = layout.scale * depth / focal;
  const mm = deltaPx * mmPerMaskPixel;
  return Number.isFinite(mm) && Math.abs(mm) < 300 ? mm : null;
}

function setRigStatus(text) {
  const el = document.getElementById("r18RigState");
  if (el) el.textContent = text;
}

function resetCalibration() {
  calibrationArmed = false;
  calibrationStartedAt = 0;
  depthSamples = [];
  longitudinalSamplesMm = [];
  fixedDepthMm = 0;
  p0LongitudinalOffsetMm = 0;
  calibratedOnce = false;
  hasRigPose = false;
  lastMpBaseQuaternion = null;
  lastMpHandAngle = null;
  cloudWasBad = false;
  recoveryUntil = 0;
  if (wristRig) wristRig.visible = false;
  setRigStatus("R18 · PULSA LISTO");
}

function armCalibration() {
  calibrationArmed = true;
  calibrationStartedAt = 0;
  depthSamples = [];
  longitudinalSamplesMm = [];
  hasRigPose = false;
  setRigStatus("R18 · ESPERANDO NUBE VÁLIDA");
}

function sampleCalibration(options, pose, axis) {
  if (!calibrationArmed || !cloudHealthy(axis)) return false;
  const viewW = Number(options && options.viewportWidth) || 0;
  const viewH = Number(options && options.viewportHeight) || 0;
  const fovY = Number(options && options.fovYDegrees) || 50;
  const depth = depthCandidate(pose);
  if (!viewW || !viewH || !depth) return false;

  const offsetMm = longitudinalOffsetSampleMm(axis, depth, viewW, viewH, fovY);
  if (!Number.isFinite(offsetMm)) return false;

  const now = performance.now();
  if (!calibrationStartedAt) calibrationStartedAt = now;
  depthSamples.push(depth);
  longitudinalSamplesMm.push(offsetMm);
  setRigStatus(`R18 · CALIBRANDO Z ${Math.min(99, Math.round((now - calibrationStartedAt) / CALIBRATION_MS * 100))}%`);

  if (
    now - calibrationStartedAt < CALIBRATION_MS ||
    depthSamples.length < MIN_CALIBRATION_SAMPLES ||
    longitudinalSamplesMm.length < MIN_CALIBRATION_SAMPLES
  ) return false;

  fixedDepthMm = median(depthSamples);
  p0LongitudinalOffsetMm = median(longitudinalSamplesMm);
  calibrationArmed = false;
  calibratedOnce = true;
  hasRigPose = false;
  setRigStatus(`R18 · RIG LISTO · Z ${Math.round(fixedDepthMm)} mm`);
  return true;
}

async function loadModelConfig() {
  try {
    const response = await fetch(MODEL_CONFIG_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const loaded = await response.json();
    modelConfig = Object.assign({}, DEFAULT_MODEL_CONFIG, loaded);
  } catch (error) {
    console.warn("R18: configuración GLB integrada.", error);
    modelConfig = DEFAULT_MODEL_CONFIG;
  }
  return modelConfig;
}

function updateWristAppearance() {
  if (!wristOccluder || !wristMaterial) return;
  wristOccluder.visible = wristMode !== 0;

  if (wristMode !== appliedWristMode) {
    if (wristMode === 1) {
      wristMaterial.colorWrite = true;
      wristMaterial.transparent = true;
      wristMaterial.opacity = 0.30;
      wristMaterial.depthWrite = false;
    } else if (wristMode === 2) {
      wristMaterial.colorWrite = true;
      wristMaterial.transparent = false;
      wristMaterial.opacity = 1;
      wristMaterial.depthWrite = true;
    } else if (wristMode === 3) {
      wristMaterial.colorWrite = false;
      wristMaterial.transparent = false;
      wristMaterial.opacity = 1;
      wristMaterial.depthWrite = true;
    }
    wristMaterial.depthTest = true;
    wristMaterial.needsUpdate = true;
    appliedWristMode = wristMode;
  }

  if (watchModel) watchModel.visible = true;
}

function createRig() {
  wristRig = new Group();
  wristRig.name = "AMURA_R18_WRIST_WATCH_RIG";
  wristRig.visible = false;

  watchAnchor = new Group();
  watchAnchor.name = "AMURA_R18_WATCH_ANCHOR";
  watchAnchor.add(watchModel);
  wristRig.add(watchAnchor);

  const geometry = new CapsuleGeometry(1, 2, 8, 20);
  wristMaterial = new MeshBasicMaterial({
    color: 0x8d6cff,
    transparent: true,
    opacity: 0.30,
    depthTest: true,
    depthWrite: false
  });
  wristOccluder = new Mesh(geometry, wristMaterial);
  wristOccluder.name = "AMURA_R18_WRIST_OCCLUDER";
  wristOccluder.renderOrder = -1000;
  wristOccluder.scale.set(
    WRIST_WIDTH_MM / 2,
    WRIST_LENGTH_MM / 4,
    WRIST_THICKNESS_MM / 2
  );
  wristOccluder.position.set(0, 0, WRIST_THICKNESS_MM / 2);
  wristOccluder.rotation.set(0, 0, Math.PI / 2);
  wristRig.add(wristOccluder);

  scene.add(wristRig);
  updateWristAppearance();
}

function loadWatch() {
  if (watchModel) return Promise.resolve(watchModel);
  if (modelPromise) return modelPromise;
  modelStatus = "cargando";

  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("./vendor/three/draco/");
  dracoLoader.setDecoderConfig({ type: "wasm" });
  loader.setDRACOLoader(dracoLoader);

  modelPromise = Promise.all([
    loadModelConfig(),
    loader.loadAsync(MODEL_URL)
  ]).then(([config, gltf]) => {
    watchModel = gltf.scene;
    watchModel.name = "A1_IRONTIDE_R18";
    watchModel.scale.setScalar(Number(config.scaleToMillimeters) || 1000);
    watchModel.rotateZ(MODEL_Z_OFFSET_RADIANS);
    watchModel.rotateX(MODEL_X_OFFSET_RADIANS);

    createRig();

    wristRig.updateMatrixWorld(true);
    const rootNode = watchModel.getObjectByName(config.rootNode);
    const contactNode = watchModel.getObjectByName(config.contactNode);
    if (contactNode) {
      contactNode.getWorldPosition(contactWorldPosition);
      contactOffsetInAnchor = watchAnchor.worldToLocal(contactWorldPosition.clone());
    } else {
      contactOffsetInAnchor.set(0, 0, 0);
    }
    watchAnchor.position.copy(contactOffsetInAnchor).multiplyScalar(-1);

    modelStatus = "listo";
    modelError = "";
    dracoLoader.dispose();
    setRigStatus(calibratedOnce ? "R18 · RIG LISTO" : "R18 · PULSA LISTO");
    return watchModel;
  }).catch((error) => {
    modelStatus = "error";
    modelError = error && error.message ? error.message : "No se pudo cargar el GLB";
    console.error("R18: error cargando reloj.", error);
    throw error;
  });

  return modelPromise;
}

function resizeRenderer(width, height) {
  if (!renderer) return;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === viewportWidth && h === viewportHeight) return;
  viewportWidth = w;
  viewportHeight = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function ensureRenderer(width, height) {
  if (renderer) {
    resizeRenderer(width, height);
    return true;
  }
  if (!canvas) return false;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      premultipliedAlpha: true
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    resizeRenderer(width, height);
    loadWatch().catch(() => {});
    return true;
  } catch (error) {
    modelStatus = "error";
    modelError = error && error.message ? error.message : "WebGL no disponible";
    console.error("R18: WebGL no disponible.", error);
    return false;
  }
}

function setCameraFov(fovYDegrees) {
  const fov = Number(fovYDegrees) || 50;
  lastFovYDegrees = fov;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

function applyTarget(position, quaternion, now) {
  if (!wristRig || !position) return;
  const recovery = now < recoveryUntil;
  const posAlpha = recovery ? 0.16 : 0.46;
  const rotAlpha = recovery ? 0.14 : 0.42;

  if (!hasRigPose) {
    wristRig.position.copy(position);
    if (quaternion) wristRig.quaternion.copy(quaternion);
    hasRigPose = true;
  } else {
    wristRig.position.lerp(position, posAlpha);
    if (quaternion) wristRig.quaternion.slerp(quaternion, rotAlpha);
  }
}

function updateFromCloud(axis, quaternion) {
  if (!calibratedOnce || !wristRig || !axis || !cloudHealthy(axis)) return false;
  const now = performance.now();
  if (cloudWasBad) {
    cloudWasBad = false;
    recoveryUntil = now + RECOVERY_BLEND_MS;
  }
  const position = targetFromAxis(
    axis,
    viewportWidth || window.innerWidth,
    viewportHeight || window.innerHeight,
    lastFovYDegrees
  );
  if (!position) return false;
  applyTarget(position, quaternion, now);
  wristRig.visible = true;
  return true;
}

function markCloudBad() {
  cloudWasBad = true;
  if (wristRig && calibratedOnce) wristRig.visible = true;
}

function render() {
  if (!renderer) return;
  updateWristAppearance();
  renderer.render(scene, camera);
}

function state(visible) {
  return {
    status: modelStatus,
    visible,
    depthMm: fixedDepthMm || lastDepthMm,
    palmWidthMm: lastPalmWidthMm,
    reprojectionErrorPx: lastReprojectionErrorPx,
    revision: REVISION,
    asset: modelConfig.asset || DEFAULT_MODEL_CONFIG.asset,
    contact: "R18 · eje naranja + AMURA_CASEBACK_CONTACT",
    units: "R18 · rig rígido muñeca + reloj · Z fija",
    error: modelError
  };
}

export function updateWristWatch(options) {
  const viewW = Number(options && options.viewportWidth) || window.innerWidth || 0;
  const viewH = Number(options && options.viewportHeight) || window.innerHeight || 0;
  const pose = options && options.pose;

  if (!ensureRenderer(viewW, viewH)) return state(false);
  setCameraFov(Number(options && options.fovYDegrees) || lastFovYDegrees);
  if (!wristRig || !pose) {
    render();
    return state(Boolean(wristRig && wristRig.visible));
  }

  lastDepthMm = depthCandidate(pose) || lastDepthMm;
  lastPalmWidthMm = Number(pose.palmWidthMm) || lastPalmWidthMm;
  lastReprojectionErrorPx = Number(pose.reprojectionErrorPx) || 0;

  const axis = currentAxis();
  if (calibrationArmed) sampleCalibration(options, pose, axis);

  if (!calibratedOnce) {
    wristRig.visible = false;
    render();
    return state(false);
  }

  if (!cloudHealthy(axis)) {
    markCloudBad();
    render();
    return state(Boolean(wristRig.visible));
  }

  const aligned = alignedMpQuaternion(pose, axis);
  let q = null;
  if (aligned) {
    lastMpBaseQuaternion = aligned.quaternion.clone();
    lastMpHandAngle = aligned.handAngle;
    q = aligned.quaternion;
  } else {
    q = heldQuaternionForAxis(axis);
  }

  updateFromCloud(axis, q);
  render();
  return state(Boolean(wristRig.visible));
}

export function holdWristWatch() {
  const viewW = viewportWidth || window.innerWidth || 0;
  const viewH = viewportHeight || window.innerHeight || 0;
  if (!ensureRenderer(viewW, viewH)) return state(false);
  if (!wristRig || !calibratedOnce) {
    render();
    return state(false);
  }

  const axis = currentAxis();
  if (!cloudHealthy(axis)) {
    markCloudBad();
    render();
    return state(Boolean(wristRig.visible));
  }

  const q = heldQuaternionForAxis(axis);
  updateFromCloud(axis, q);
  render();
  return state(Boolean(wristRig.visible));
}

export function hideWristWatch() {
  if (wristRig) wristRig.visible = false;
  render();
}

function ensureModeUi() {
  if (document.getElementById("r18WristModes")) return;

  const style = document.createElement("style");
  style.id = "r18WristModeStyle";
  style.textContent = `
    #r18RigState{
      position:absolute;left:10px;right:10px;
      bottom:calc(env(safe-area-inset-bottom,0px) + 132px);
      z-index:100041;text-align:center;pointer-events:none;
      color:#fff;font:800 10px/1.2 Arial,sans-serif;letter-spacing:.04em;
      text-shadow:0 1px 4px #000;
    }
    #r18WristModes{
      position:absolute;left:10px;right:10px;
      bottom:calc(env(safe-area-inset-bottom,0px) + 78px);
      z-index:100042;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;
    }
    #r18WristModes button{
      min-height:44px;padding:0 5px;border:1px solid rgba(255,255,255,.38);
      border-radius:999px;background:rgba(5,10,17,.86);color:rgba(255,255,255,.72);
      font:800 10px/1 Arial,sans-serif;letter-spacing:.03em;
      -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
    }
    #r18WristModes button.on{
      background:rgba(0,133,164,.92);color:#fff;border-color:rgba(255,255,255,.82);
    }
    body[data-status="idle"] #r18WristModes,
    body[data-status="requesting"] #r18WristModes,
    body[data-status="idle"] #r18RigState,
    body[data-status="requesting"] #r18RigState,
    body[data-amura-mode="bank"] #r18WristModes,
    body[data-amura-mode="bank"] #r18RigState{display:none!important}
  `;
  document.head.appendChild(style);

  const stateEl = document.createElement("div");
  stateEl.id = "r18RigState";
  stateEl.textContent = "R18 · PULSA LISTO";

  const root = document.createElement("div");
  root.id = "r18WristModes";
  const labels = ["OCULTA", "TRANSP.", "SÓLIDA", "OCLUSIÓN"];
  labels.forEach((label, mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.wristMode = String(mode);
    button.textContent = label;
    button.classList.toggle("on", mode === wristMode);
    button.addEventListener("click", () => {
      wristMode = mode;
      root.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("on", Number(b.dataset.wristMode) === wristMode);
      });
      updateWristAppearance();
      render();
    });
    root.appendChild(button);
  });

  const parent = document.querySelector(".camera-lab") || document.body;
  parent.appendChild(stateEl);
  parent.appendChild(root);
}

readyButton && readyButton.addEventListener("click", (event) => {
  if (event.isTrusted || !calibratedOnce) armCalibration();
});

resetButton && resetButton.addEventListener("click", (event) => {
  if (event.isTrusted) resetCalibration();
});

window.addEventListener("amura-camera-state", (event) => {
  const live = event.detail && event.detail.status === "live";
  if (!live) {
    if (wristRig) wristRig.visible = false;
    calibrationArmed = false;
    calibrationStartedAt = 0;
    depthSamples = [];
    longitudinalSamplesMm = [];
    calibratedOnce = false;
    fixedDepthMm = 0;
    p0LongitudinalOffsetMm = 0;
    hasRigPose = false;
    lastMpBaseQuaternion = null;
    lastMpHandAngle = null;
    setRigStatus("R18 · PULSA LISTO");
    render();
  }
});

ensureModeUi();
ensureRenderer(window.innerWidth || 1, window.innerHeight || 1);
loadWatch().catch(() => {});

window.AmuraR18Rig = {
  revision: REVISION,
  get state() {
    return {
      calibrated: calibratedOnce,
      fixedDepthMm,
      p0LongitudinalOffsetMm,
      wristMode,
      cloudWasBad,
      modelStatus
    };
  }
};
