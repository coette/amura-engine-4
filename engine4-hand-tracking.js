import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker
} from "./vendor/mediapipe/vision_bundle.mjs";
import {
  buildHybridWristFrame,
  buildWristFrame,
  createHybridWristState,
  formatFrameVector,
  imageSpaceLandmarks,
  resetHybridWristState,
  wristFrameMetrics
} from "./wrist-frame.js?v=11.2";
import {
  hideWristWatch,
  holdWristWatch,
  updateWristWatch
} from "./wrist-watch.js?v=11.2";
import { WristFrameStabilizer } from "./wrist-stabilizer.js?v=11.2";
import { initTuner, tuning } from "./tuner.js?v=11.2";
import { focalFromDiagonalFov, solveMetricWristPose } from "./wrist-pose.js?v=11.2";

const video = document.getElementById("cameraVideo");
const canvas = document.getElementById("trackingCanvas");
const context = canvas.getContext("2d");
const trackingHud = document.getElementById("trackingHud");
const trackingLabel = document.getElementById("trackingLabel");
const guidesButton = document.getElementById("guidesButton");
const guidesValue = document.getElementById("guidesValue");
const rotationModeButtons = Array.from(document.querySelectorAll("[data-rotation-mode]"));
const drawingUtils = new DrawingUtils(context);
const AXIS_COLORS = {
  x: "#ff5c6c",
  y: "#6ad46a",
  z: "#5aa9ff"
};
const STABILIZER_RESET_DELAY_MS = 1500;
const ROTATION_MODES = {
  world: "WORLD",
  image: "IMAGE 3D",
  hybrid: "HÍBRIDO"
};

let handLandmarker = null;
let initializationPromise = null;
let delegate = "—";
let cameraLive = false;
let cameraFacingMode = "environment";
let frameHandle = null;
let frameScheduler = "none";
let loopToken = 0;
let lastFallbackInferenceAt = 0;
let inferenceFrames = 0;
let inferenceWindowStart = 0;
let inferenceFps = 0;
let inferenceLatency = 0;
let stabilizedHand = "";
let lastHandSeenAt = 0;
let guidesVisible = true;
let rotationMode = "image";
let lastMetricDepth = 0;

// One Euro sobre la posición métrica. Antes iba cruda: el estabilizador sólo
// tocaba la orientación, así que bajar el corte de giro no calmaba el temblor
// de sitio. Adaptativo: quieto filtra fuerte, en movimiento suelta.
const metricPositionFilter = {
  value: null,
  velocity: { x: 0, y: 0, z: 0 },
  lastTimestamp: 0,
  reset() { this.value = null; this.velocity = { x: 0, y: 0, z: 0 }; this.lastTimestamp = 0; }
};

function smoothMetricPosition(positionMm, timestamp) {
  const filter = metricPositionFilter;
  if (!filter.value) {
    filter.value = { x: positionMm.x, y: positionMm.y, z: positionMm.z };
    filter.lastTimestamp = timestamp;
    return filter.value;
  }

  const delta = Math.min(0.1, Math.max(1 / 120, (timestamp - filter.lastTimestamp) / 1000));
  filter.lastTimestamp = timestamp;

  const axes = ["x", "y", "z"];
  const speeds = axes.map((axis) => (positionMm[axis] - filter.value[axis]) / delta);
  axes.forEach((axis, index) => {
    filter.velocity[axis] += (speeds[index] - filter.velocity[axis]) * 0.35;
  });

  const speed = Math.hypot(filter.velocity.x, filter.velocity.y, filter.velocity.z);
  // Mismos mandos que el giro: el usuario ajusta uno y se mueven los dos.
  const cutoff = tuning.orientationCutoff + tuning.orientationBeta * (speed / 220);
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 0.05));
  const alpha = 1 / (1 + tau / delta);

  axes.forEach((axis) => {
    filter.value[axis] += (positionMm[axis] - filter.value[axis]) * alpha;
  });
  return filter.value;
}

// La traslación métrica y el giro elegido forman una sola pose. Antes, al
// desactivar el filtro, el reloj saltaba a otro sistema XYZ distinto.
function applyActiveFrame(pose, activeFrame, timestamp, smoothPosition) {
  const positionMm = smoothPosition
    ? smoothMetricPosition(pose.positionMm, timestamp)
    : pose.positionMm;
  if (!activeFrame || !activeFrame.xAxis) return Object.assign({}, pose, { positionMm });

  const toThree = (axis) => ({ x: axis.x, y: -axis.y, z: -axis.z });
  return {
    ...pose,
    positionMm,
    xAxis: toThree(activeFrame.xAxis),
    yAxis: toThree(activeFrame.yAxis),
    zAxis: toThree(activeFrame.zAxis),
    armAxis: toThree(activeFrame.yAxis)
  };
}
const wristStabilizer = new WristFrameStabilizer();
const hybridWristState = createHybridWristState();

window.AmuraTrackingDiagnostics = {
  "MediaPipe": "en espera",
  "Delegate": "—",
  "Mano detectada": "no",
  "Landmarks": "0",
  "Etiqueta MediaPipe": "—",
  "Mano física": "—",
  "Confianza lateralidad": "—",
  "Entrada MediaPipe": "sin espejo",
  "Mapeo lateralidad": "directo",
  "Vista vídeo": "normal (trasera)",
  "Marco XYZ": "—",
  "Fuente marco": "—",
  "Modo giro": ROTATION_MODES[rotationMode],
  "Origen muñeca": "—",
  "X 9→3": "—",
  "Y 12→6": "—",
  "Z normal": "—",
  "Giro X pantalla": "—",
  "Giro Y muñeca": "—",
  "Giro WORLD": "—",
  "Giro IMAGE 3D": "—",
  "Giro HÍBRIDO": "—",
  "Referencia híbrida": "—",
  "Inclinación Z": "—",
  "Sentido Z dorsal": "—",
  "Estabilización XYZ": "One Euro sobre cuaternión",
  "Pose": "traslación métrica aproximada + giro activo",
  "Referencia visual": "landmarks y XYZ crudos",
  "Alpha orientación": "—",
  "Alpha origen": "—",
  "Alpha escala": "—",
  "Velocidad angular": "—",
  "Corrección salto 180°": "—",
  "Three.js": "en espera",
  "Objeto 3D": "A1-Irontide-AR-pretty-mobile.glb",
  "Orientación objeto": "X 9→3 · Y 12→6 · Z fondo→cristal",
  "Corrección GLB": "ninguna · tríada exportada",
  "Reloj visible": "no",
  "Unidades rig": "GLB m → rig mm → pantalla px",
  "Escala física": "40 mm de geometría · distancia estimada",
  "Oclusión reloj": "desactivada (prueba)",
  "Bucle inferencia": "—",
  "FPS inferencia": "—",
  "Latencia inferencia": "—"
};

function updateDiagnostics(values) {
  Object.assign(window.AmuraTrackingDiagnostics, values);
}

function setTrackingState(state, label) {
  document.body.setAttribute("data-tracking", state);
  trackingLabel.textContent = label;
  trackingHud.hidden = !cameraLive;
}

function resizeCanvasToVideo() {
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;

  if (width && height && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
}

function clearLandmarks() {
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function physicalHandFromMediaPipe(categoryName) {
  const rawHand = String(categoryName || "").toLowerCase();

  if (rawHand === "left") return "left";
  if (rawHand === "right") return "right";
  return "unknown";
}

function spanishHandLabel(hand) {
  if (hand === "left") return "IZQUIERDA";
  if (hand === "right") return "DERECHA";
  return "SIN CLASIFICAR";
}

function resetHandednessDiagnostics() {
  updateDiagnostics({
    "Etiqueta MediaPipe": "—",
    "Mano física": "—",
    "Confianza lateralidad": "—"
  });
}

function resetWristFrameDiagnostics(status) {
  updateDiagnostics({
    "Marco XYZ": status || "—",
    "Fuente marco": "—",
    "Modo giro": ROTATION_MODES[rotationMode],
    "Origen muñeca": "—",
    "X 9→3": "—",
    "Y 12→6": "—",
    "Z normal": "—",
    "Giro X pantalla": "—",
    "Giro Y muñeca": "—",
    "Giro WORLD": "—",
    "Giro IMAGE 3D": "—",
    "Giro HÍBRIDO": "—",
    "Referencia híbrida": "—",
    "Inclinación Z": "—",
    "Sentido Z dorsal": "—",
    "Alpha orientación": "—",
    "Alpha origen": "—",
    "Alpha escala": "—",
    "Velocidad angular": "—",
    "Corrección salto 180°": "—"
  });
}

function setRotationMode(mode) {
  if (!ROTATION_MODES[mode]) return;
  rotationMode = mode;
  rotationModeButtons.forEach((button) => {
    const active = button.dataset.rotationMode === rotationMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  updateDiagnostics({
    "Modo giro": ROTATION_MODES[rotationMode],
    "Orientación objeto": ROTATION_MODES[rotationMode] + " · X9→3/Y12→6"
  });
}

rotationModeButtons.forEach((button) => {
  button.addEventListener("click", () => setRotationMode(button.dataset.rotationMode));
});
setRotationMode("image");
initTuner((key) => {
  if (key === "orientationCutoff" || key === "orientationBeta") {
    wristStabilizer.options.orientationMinCutoff = tuning.orientationCutoff;
    wristStabilizer.options.orientationBeta = tuning.orientationBeta;
  }
});

function watchDepthLabel() {
  return lastMetricDepth ? Math.round(lastMetricDepth) + " mm" : "—";
}

function updateWatchDiagnostics(state) {
  if (!state) return;

  updateDiagnostics({
    "Three.js": state.status === "listo"
      ? "r" + state.revision + " · listo"
      : state.error || state.status,
    "Reloj visible": state.visible ? "sí" : "no",
    "Distancia a la muñeca": state.depthMm
      ? Math.round(state.depthMm) + " mm"
      : watchDepthLabel(),
    "Anchura palma estimada": state.palmWidthMm
      ? state.palmWidthMm.toFixed(1) + " mm"
      : "—",
    "Error reproyección": state.reprojectionErrorPx
      ? state.reprojectionErrorPx.toFixed(1) + " px"
      : "—",
    "Contacto GLB": state.contact || "—",
    "Asset": state.asset || "—"
  });
}

function setGuidesVisible(visible) {
  guidesVisible = Boolean(visible);
  guidesButton.setAttribute("aria-pressed", guidesVisible ? "true" : "false");
  guidesButton.classList.toggle("primary-control", guidesVisible);
  guidesValue.textContent = guidesVisible ? "OCULTAR" : "MOSTRAR";
  updateDiagnostics({
    "Referencia visual": guidesVisible
      ? "landmarks / XYZ del modo activo"
      : "guías ocultas (botón GUÍAS)"
  });
  if (!guidesVisible) clearLandmarks();
}

guidesButton.addEventListener("click", () => {
  setGuidesVisible(!guidesVisible);
});
setGuidesVisible(true);

function drawAxisLabel(text, x, y, color) {
  context.save();
  context.translate(x, y);
  if (cameraFacingMode === "user") context.scale(-1, 1);
  context.font = "700 16px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";

  const width = context.measureText(text).width + 12;
  context.fillStyle = "rgba(13, 10, 22, 0.88)";
  context.fillRect(-width / 2, -12, width, 24);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.strokeRect(-width / 2, -12, width, 24);
  context.fillStyle = color;
  context.fillText(text, 0, 1);
  context.restore();
}

function drawProjectedAxis(origin, axis, length, color, positiveLabel, negativeLabel) {
  const projection = Math.hypot(axis.x, axis.y);
  if (projection < 0.08) return;

  const positive = {
    x: origin.x + axis.x * length,
    y: origin.y + axis.y * length
  };
  const negative = {
    x: origin.x - axis.x * length * 0.58,
    y: origin.y - axis.y * length * 0.58
  };
  const angle = Math.atan2(positive.y - origin.y, positive.x - origin.x);
  const arrowSize = 11;

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 5;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(0, 0, 0, 0.65)";
  context.shadowBlur = 5;
  context.beginPath();
  context.moveTo(negative.x, negative.y);
  context.lineTo(positive.x, positive.y);
  context.stroke();
  context.beginPath();
  context.moveTo(positive.x, positive.y);
  context.lineTo(
    positive.x - arrowSize * Math.cos(angle - Math.PI / 6),
    positive.y - arrowSize * Math.sin(angle - Math.PI / 6)
  );
  context.lineTo(
    positive.x - arrowSize * Math.cos(angle + Math.PI / 6),
    positive.y - arrowSize * Math.sin(angle + Math.PI / 6)
  );
  context.closePath();
  context.fill();
  context.restore();

  drawAxisLabel(positiveLabel, positive.x, positive.y, color);
  if (negativeLabel) drawAxisLabel(negativeLabel, negative.x, negative.y, color);
}

function drawZNormalMarker(origin, zAxis) {
  const radius = 19;
  const towardCamera = zAxis.z < 0;
  const stateColor = towardCamera ? "#00e5ff" : "#ff9f43";

  context.save();
  context.fillStyle = "rgba(13, 10, 22, 0.8)";
  context.beginPath();
  context.arc(origin.x, origin.y, radius + 4, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = stateColor;
  context.fillStyle = stateColor;
  context.lineWidth = 5;
  context.beginPath();
  context.arc(origin.x, origin.y, radius, 0, Math.PI * 2);
  context.stroke();

  if (towardCamera) {
    context.beginPath();
    context.arc(origin.x, origin.y, 7, 0, Math.PI * 2);
    context.fill();
  } else {
    const crossSize = 9;
    context.beginPath();
    context.moveTo(origin.x - crossSize, origin.y - crossSize);
    context.lineTo(origin.x + crossSize, origin.y + crossSize);
    context.moveTo(origin.x + crossSize, origin.y - crossSize);
    context.lineTo(origin.x - crossSize, origin.y + crossSize);
    context.stroke();
  }
  context.restore();

  drawAxisLabel(
    towardCamera ? "Z·CÁMARA" : "Z·OPUESTA",
    origin.x,
    origin.y + 39,
    stateColor
  );
}

function drawWristFrame(normalizedLandmarks, frame, stabilizedOrigin, stabilizedPalmWidth) {
  if (!frame || !normalizedLandmarks[0] || !normalizedLandmarks[5] || !normalizedLandmarks[17]) {
    return;
  }

  const originLandmark = stabilizedOrigin || normalizedLandmarks[0];
  const origin = {
    x: originLandmark.x * canvas.width,
    y: originLandmark.y * canvas.height
  };
  const rawPalmWidth = Math.hypot(
    (normalizedLandmarks[5].x - normalizedLandmarks[17].x) * canvas.width,
    (normalizedLandmarks[5].y - normalizedLandmarks[17].y) * canvas.height
  );
  const palmWidth = Number.isFinite(stabilizedPalmWidth)
    ? stabilizedPalmWidth
    : rawPalmWidth;
  const axisLength = Math.min(145, Math.max(58, palmWidth * 0.82));

  drawProjectedAxis(origin, frame.xAxis, axisLength, AXIS_COLORS.x, "X·3", "9");
  drawProjectedAxis(origin, frame.yAxis, axisLength, AXIS_COLORS.y, "Y·6", "12");
  drawProjectedAxis(origin, frame.zAxis, axisLength * 0.85, AXIS_COLORS.z, "Z", "");
  drawZNormalMarker(origin, frame.zAxis);
}

function angleLabel(frame) {
  const metrics = wristFrameMetrics(frame);
  return metrics ? metrics.rollY.toFixed(1) + "°" : "—";
}

function updateWristFrameDiagnostics(
  frame,
  source,
  normalizedOrigin,
  stabilization,
  comparison
) {
  const metrics = wristFrameMetrics(frame);
  if (!frame || !metrics) {
    resetWristFrameDiagnostics("insuficiente");
    return;
  }

  updateDiagnostics({
    "Marco XYZ": "válido",
    "Fuente marco": source,
    "Modo giro": ROTATION_MODES[rotationMode],
    "Origen muñeca": normalizedOrigin
      ? [normalizedOrigin.x, normalizedOrigin.y, normalizedOrigin.z]
        .map((value) => Number(value).toFixed(3)).join(", ")
      : "—",
    "X 9→3": formatFrameVector(frame.xAxis),
    "Y 12→6": formatFrameVector(frame.yAxis),
    "Z normal": formatFrameVector(frame.zAxis),
    "Giro X pantalla": metrics.rotation.toFixed(1) + "°",
    "Giro Y muñeca": metrics.rollY.toFixed(1) + "°",
    "Giro WORLD": angleLabel(comparison && comparison.worldFrame),
    "Giro IMAGE 3D": angleLabel(comparison && comparison.imageFrame),
    "Giro HÍBRIDO": comparison && comparison.hybridResult
      ? comparison.hybridResult.rollDegrees.toFixed(1) + "°"
      : "—",
    "Referencia híbrida": comparison && comparison.hybridResult
      ? comparison.hybridResult.referenceRatio.toFixed(3)
      : "—",
    "Inclinación Z": metrics.tilt.toFixed(1) + "°",
    "Sentido Z dorsal": metrics.zDirection,
    "Alpha orientación": stabilization
      ? stabilization.orientationAlpha.toFixed(3)
      : "—",
    "Alpha origen": stabilization
      ? stabilization.positionAlpha.toFixed(3)
      : "—",
    "Alpha escala": stabilization
      ? stabilization.scaleAlpha.toFixed(3)
      : "—",
    "Velocidad angular": stabilization
      ? stabilization.angularSpeedDegrees.toFixed(1) + " °/s"
      : "—",
    "Corrección salto 180°": stabilization
      ? (stabilization.axisFlipCorrected ? "sí" : "no")
      : "—"
  });
}

async function createLandmarker(fileset, requestedDelegate) {
  const baseOptions = {
    modelAssetPath: "./models/hand_landmarker.task"
  };

  if (requestedDelegate) {
    baseOptions.delegate = requestedDelegate;
  }

  return HandLandmarker.createFromOptions(fileset, {
    baseOptions,
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
}

async function initializeTracking() {
  if (handLandmarker) return handLandmarker;
  if (initializationPromise) return initializationPromise;

  setTrackingState("loading", "CARGANDO MEDIAPIPE");
  updateDiagnostics({
    "MediaPipe": "cargando",
    "Delegate": "—"
  });

  initializationPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");

    try {
      handLandmarker = await createLandmarker(fileset, "GPU");
      delegate = "GPU";
    } catch (gpuError) {
      console.warn("MediaPipe GPU no disponible; se utilizará CPU.", gpuError);
      handLandmarker = await createLandmarker(fileset, "CPU");
      delegate = "CPU";
    }

    updateDiagnostics({
      "MediaPipe": "listo",
      "Delegate": delegate
    });
    return handLandmarker;
  })().catch((error) => {
    console.error("No se ha podido iniciar MediaPipe Hand Landmarker.", error);
    initializationPromise = null;
    setTrackingState("error", "ERROR DE MEDIAPIPE");
    updateDiagnostics({
      "MediaPipe": "error",
      "Delegate": "—",
      "Mano detectada": "no",
      "Landmarks": "0"
    });
    throw error;
  });

  return initializationPromise;
}

function drawResult(result, timestamp) {
  const hands = result && result.landmarks ? result.landmarks : [];
  if (!hands.length) {
    const heldState = holdWristWatch();
    setTrackingState("searching", "TRACKING PERDIDO · POSE CONGELADA");
    updateDiagnostics({
      "Mano detectada": "no",
      "Landmarks": "0",
      "Reloj visible": heldState.visible ? "sí (última pose)" : "no"
    });
    resetHandednessDiagnostics();
    resetWristFrameDiagnostics("sin mano");
    if (lastHandSeenAt && timestamp - lastHandSeenAt > STABILIZER_RESET_DELAY_MS) {
      stabilizedHand = "";
      lastHandSeenAt = 0;
      resetHybridWristState(hybridWristState);
  wristStabilizer.reset();
  metricPositionFilter.reset();
    }
    return;
  }

  clearLandmarks();

  const landmarks = hands[0];
  const handednessGroups = result.handedness || result.handednesses || [];
  const handedness = handednessGroups[0] && handednessGroups[0][0];
  const rawHand = handedness ? handedness.categoryName : "";
  const detectedPhysicalHand = physicalHandFromMediaPipe(rawHand);
  if (!stabilizedHand && detectedPhysicalHand !== "unknown") {
    stabilizedHand = detectedPhysicalHand;
  }
  const physicalHand = stabilizedHand || detectedPhysicalHand;
  const confidence = handedness && Number.isFinite(handedness.score)
    ? handedness.score
    : null;
  const confidencePercent = confidence === null
    ? "—"
    : (confidence * 100).toFixed(1) + " %";
  const worldHands = result.worldLandmarks || [];
  const hasWorldLandmarks = Boolean(worldHands[0] && worldHands[0].length >= 18);
  const imagePoints = imageSpaceLandmarks(landmarks, canvas.width, canvas.height);
  const worldPoints = hasWorldLandmarks ? worldHands[0] : null;
  const worldFrame = hasWorldLandmarks
    ? buildWristFrame(worldPoints, physicalHand)
    : null;
  const imageFrame = buildWristFrame(imagePoints, physicalHand);
  const hybridResult = buildHybridWristFrame(
    imagePoints,
    worldPoints,
    physicalHand,
    hybridWristState,
    Boolean(tuning.flexionFix)
  );
  const frames = {
    world: worldFrame || imageFrame,
    image: imageFrame || worldFrame,
    hybrid: hybridResult ? hybridResult.frame : (imageFrame || worldFrame)
  };
  const frameSources = {
    world: worldFrame ? "worldLandmarks · crudo" : "IMAGE 3D · fallback",
    image: "landmarks normalizados · aspecto corregido",
    hybrid: "2D + profundidad + continuidad · crudo"
  };
  const wristFrame = frames[rotationMode];
  const frameSource = frameSources[rotationMode];
  const rawPalmWidth = Math.hypot(
    (landmarks[5].x - landmarks[17].x) * canvas.width,
    (landmarks[5].y - landmarks[17].y) * canvas.height
  );
  lastHandSeenAt = timestamp;

  // El estabilizador ya existía en el ZIP pero no estaba conectado a nada:
  // el HUD decía "sin filtro" y lo era. Ahora pasa por él, con interruptor.
  let renderFrame = wristFrame;
  let renderOrigin = landmarks[0];
  let stabilization = null;
  if (tuning.smoothing && wristFrame) {
    wristStabilizer.options.orientationMinCutoff = tuning.orientationCutoff;
    wristStabilizer.options.orientationBeta = tuning.orientationBeta;
    const smoothed = wristStabilizer.update(
      wristFrame,
      landmarks[0],
      rawPalmWidth,
      timestamp
    );
    if (smoothed) {
      renderFrame = smoothed.frame;
      renderOrigin = smoothed.screenOrigin;
      stabilization = smoothed.diagnostics;
    }
  } else {
    wristStabilizer.reset();
  metricPositionFilter.reset();
  }

  // ── Pose métrica ──────────────────────────────────────────────────────
  // El vídeo se muestra en "cover", así que sólo se ve una parte del cuadro.
  // La focal efectiva en píxeles de pantalla es la del vídeo por ese factor;
  // de ahí sale el campo de visión que debe tener la cámara de three.
  const displayWidth = Math.max(1, window.innerWidth);
  const displayHeight = Math.max(1, window.innerHeight);
  const coverScale = Math.max(
    displayWidth / canvas.width,
    displayHeight / canvas.height
  );
  const videoFocal = focalFromDiagonalFov(
    canvas.width,
    canvas.height,
    tuning.fovDiagonal
  );
  const displayFocal = videoFocal * coverScale;
  const fovYDegrees = 2 * Math.atan(displayHeight / (2 * displayFocal)) * 180 / Math.PI;

  const metricPose = hasWorldLandmarks
    ? solveMetricWristPose({
        worldPoints,
        imagePoints: landmarks,
        physicalHand,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        focal: videoFocal
      })
    : null;

  let watchState;
  if (metricPose) {
    // WORLD, IMAGE 3D o HÍBRIDO gobiernan siempre el reloj. El filtro solo
    // decide si ese mismo marco y la traslación pasan suavizados o crudos.
    const posed = applyActiveFrame(
      metricPose,
      renderFrame,
      timestamp,
      Boolean(tuning.smoothing)
    );
    watchState = updateWristWatch({
      pose: posed,
      fovYDegrees,
      viewportWidth: displayWidth,
      viewportHeight: displayHeight
    });
    lastMetricDepth = metricPose.depthMm;
  } else {
    watchState = holdWristWatch();
    lastMetricDepth = 0;
  }
  updateWatchDiagnostics(watchState);
  if (guidesVisible) {
    drawingUtils.drawConnectors(
      landmarks,
      HandLandmarker.HAND_CONNECTIONS,
      { color: "#a992ff", lineWidth: 4 }
    );
    drawingUtils.drawLandmarks(landmarks, {
      color: "#6ad46a",
      fillColor: "#0d0a16",
      lineWidth: 2,
      radius: 4
    });
    drawingUtils.drawLandmarks([landmarks[0]], {
      color: "#d4b76a",
      fillColor: "#0d0a16",
      lineWidth: 3,
      radius: 7
    });
    drawWristFrame(
      landmarks,
      renderFrame,
      renderOrigin,
      rawPalmWidth
    );
  }
  updateWristFrameDiagnostics(
    renderFrame,
    frameSource,
    renderOrigin,
    stabilization,
    { worldFrame, imageFrame, hybridResult }
  );

  const hudConfidence = confidence === null
    ? ""
    : " · " + Math.round(confidence * 100) + "%";
  setTrackingState(
    "detected",
    "MANO " + spanishHandLabel(physicalHand) + " · " +
      ROTATION_MODES[rotationMode] + hudConfidence
  );
  updateDiagnostics({
    "Mano detectada": "sí",
    "Landmarks": String(landmarks.length),
    "Etiqueta MediaPipe": rawHand || "—",
    "Mano física": spanishHandLabel(physicalHand).toLowerCase(),
    "Confianza lateralidad": confidencePercent
  });
}

function updateInferenceStats(now, startedAt) {
  inferenceLatency = performance.now() - startedAt;
  inferenceFrames += 1;

  if (!inferenceWindowStart) inferenceWindowStart = now;
  const elapsed = now - inferenceWindowStart;

  if (elapsed >= 1000) {
    inferenceFps = inferenceFrames * 1000 / elapsed;
    inferenceFrames = 0;
    inferenceWindowStart = now;
  }

  updateDiagnostics({
    "FPS inferencia": inferenceFps ? inferenceFps.toFixed(1) : "calculando",
    "Latencia inferencia": inferenceLatency.toFixed(1) + " ms"
  });
}

function stopLoop() {
  loopToken += 1;

  if (frameHandle !== null) {
    if (frameScheduler === "video" && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(frameHandle);
    } else if (frameScheduler === "animation") {
      cancelAnimationFrame(frameHandle);
    }
  }

  frameHandle = null;
  frameScheduler = "none";
  lastFallbackInferenceAt = 0;
  inferenceFrames = 0;
  inferenceWindowStart = 0;
  inferenceFps = 0;
  stabilizedHand = "";
  lastHandSeenAt = 0;
  resetHybridWristState(hybridWristState);
  wristStabilizer.reset();
  metricPositionFilter.reset();
  hideWristWatch();
  clearLandmarks();
  updateDiagnostics({
    "Mano detectada": "no",
    "Landmarks": "0",
    "Reloj visible": "no",
    "Bucle inferencia": "—",
    "FPS inferencia": "—",
    "Latencia inferencia": "—"
  });
  resetHandednessDiagnostics();
  resetWristFrameDiagnostics();
}

function startLoop() {
  stopLoop();
  const token = loopToken;
  const canFollowVideoFrames = typeof video.requestVideoFrameCallback === "function";

  frameScheduler = canFollowVideoFrames ? "video" : "animation";
  updateDiagnostics({
    "Bucle inferencia": canFollowVideoFrames ? "fotograma de vídeo" : "fallback ≤ 30 FPS"
  });

  function processFrame(now) {
    if (
      handLandmarker &&
      video.readyState >= 2 &&
      video.videoWidth > 0
    ) {
      resizeCanvasToVideo();

      try {
        const startedAt = performance.now();
        const result = handLandmarker.detectForVideo(video, now);
        drawResult(result, now);
        updateInferenceStats(now, startedAt);
      } catch (error) {
        console.error("Error durante la inferencia de mano.", error);
        setTrackingState("error", "ERROR DE TRACKING");
        updateDiagnostics({ "MediaPipe": "error de inferencia" });
        stopLoop();
        return false;
      }
    }

    return true;
  }

  if (canFollowVideoFrames) {
    function videoTick(now) {
      if (token !== loopToken || !cameraLive) return;
      if (!processFrame(now)) return;

      frameHandle = video.requestVideoFrameCallback(videoTick);
    }

    frameHandle = video.requestVideoFrameCallback(videoTick);
    return;
  }

  function animationTick(now) {
    if (token !== loopToken || !cameraLive) return;

    if (!lastFallbackInferenceAt || now - lastFallbackInferenceAt >= 1000 / 30) {
      lastFallbackInferenceAt = now;
      if (!processFrame(now)) return;
    }

    frameHandle = requestAnimationFrame(animationTick);
  }

  frameHandle = requestAnimationFrame(animationTick);
}

async function handleCameraState(state) {
  cameraLive = Boolean(state && state.status === "live");
  cameraFacingMode = state && state.facingMode
    ? state.facingMode
    : cameraFacingMode;
  updateDiagnostics({
    "Vista vídeo": cameraFacingMode === "user"
      ? "espejada (frontal)"
      : "normal (trasera)"
  });
  trackingHud.hidden = !cameraLive;

  if (!cameraLive) {
    stopLoop();
    document.body.setAttribute("data-tracking", handLandmarker ? "ready" : "idle");
    return;
  }

  try {
    await initializeTracking();
    if (!cameraLive) return;
    setTrackingState("searching", "BUSCANDO MANO");
    startLoop();
  } catch (error) {
    /* El estado de error ya se muestra en pantalla y en diagnóstico. */
  }
}

window.addEventListener("amura-camera-state", (event) => {
  handleCameraState(event.detail);
});

window.addEventListener("pagehide", () => {
  stopLoop();
});

handleCameraState(window.AmuraCameraState);
