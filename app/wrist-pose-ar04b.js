import { buildWristFrame } from "./wrist-frame.js?v=11.2";

/**
 * AMURA · AR-04B · PROFUNDIDAD ESTABLE
 *
 * Los datos de AR-04A demostraron el fallo real: al girar la muñeca las siete
 * estimaciones dejan de estar de acuerdo. En una toma buena se agrupan; en la
 * toma problemática algunas parejas saltan a 600–1300 mm mientras otras siguen
 * cerca de 270–400 mm.
 *
 * Regla AR-04B:
 * - la distancia sólo se actualiza si varias parejas coinciden entre sí;
 * - si el conjunto se dispersa por escorzo/giro, se congela la última distancia
 *   fiable en vez de dejar que el reloj encoja;
 * - si el móvil se acerca/aleja de verdad y las parejas cambian juntas, la
 *   distancia sí se actualiza;
 * - la medida aceptada pasa por un filtro temporal adaptativo.
 *
 * No se toca orientación, P0, AR-03 ni el corredor azul.
 */

const EPSILON = 1e-9;
const PAIRS = [
  [0, 9],
  [0, 5],
  [0, 17],
  [5, 17],
  [5, 9],
  [9, 13],
  [13, 17]
];

const MIN_VALID_PAIRS = 4;
const MIN_INLIER_PAIRS = 4;
const MAX_RELATIVE_MAD = 0.12;
const INLIER_BAND_RATIO = 0.14;
const INLIER_BAND_MIN_MM = 28;
const DEPTH_MIN_MM = 120;
const DEPTH_MAX_MM = 1800;
const FILTER_STALE_MS = 900;
const DIAGNOSTIC_SAMPLE_MS = 220;

let metricHud = null;
let lastDiagnosticSampleAt = 0;
let filteredDepthMm = null;
let lastFilterTimestamp = 0;
let lastAcceptedDepthMm = null;
let lastAcceptedAt = 0;

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function len(a) {
  return Math.hypot(a.x, a.y, a.z);
}

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

export function focalFromFov(imageHeight, fovYDegrees) {
  const fov = (Number(fovYDegrees) || 60) * Math.PI / 180;
  return (imageHeight * 0.5) / Math.tan(fov * 0.5);
}

export function focalFromDiagonalFov(imageWidth, imageHeight, fovDegrees) {
  const diagonal = Math.hypot(imageWidth, imageHeight);
  const fov = (Number(fovDegrees) || 73) * Math.PI / 180;
  return (diagonal * 0.5) / Math.tan(fov * 0.5);
}

export function metricWristBasis(worldPoints, physicalHand) {
  if (!Array.isArray(worldPoints) || worldPoints.length < 18) return null;
  const p0 = worldPoints[0];
  const p5 = worldPoints[5];
  const p17 = worldPoints[17];
  if (!p0 || !p5 || !p17) return null;

  const mid = {
    x: (p5.x + p17.x) * 0.5,
    y: (p5.y + p17.y) * 0.5,
    z: (p5.z + p17.z) * 0.5
  };
  const longitudinal = sub(mid, p0);
  const longitudinalLength = len(longitudinal);
  if (longitudinalLength < EPSILON) return null;
  const xAxis = {
    x: longitudinal.x / longitudinalLength,
    y: longitudinal.y / longitudinalLength,
    z: longitudinal.z / longitudinalLength
  };

  const transverse = physicalHand === "right"
    ? sub(p17, p5)
    : sub(p5, p17);
  const dotXY = transverse.x * xAxis.x + transverse.y * xAxis.y + transverse.z * xAxis.z;
  const yRaw = {
    x: transverse.x - xAxis.x * dotXY,
    y: transverse.y - xAxis.y * dotXY,
    z: transverse.z - xAxis.z * dotXY
  };
  const yLength = len(yRaw);
  if (yLength < EPSILON) return null;
  const yAxis = {
    x: yRaw.x / yLength,
    y: yRaw.y / yLength,
    z: yRaw.z / yLength
  };
  const zRaw = {
    x: xAxis.y * yAxis.z - xAxis.z * yAxis.y,
    y: xAxis.z * yAxis.x - xAxis.x * yAxis.z,
    z: xAxis.x * yAxis.y - xAxis.y * yAxis.x
  };
  const zLength = len(zRaw);
  if (zLength < EPSILON) return null;
  const zAxis = {
    x: zRaw.x / zLength,
    y: zRaw.y / zLength,
    z: zRaw.z / zLength
  };

  return { xAxis, yAxis, zAxis, armAxis: xAxis };
}

function pairDepthRows(worldPoints, imagePoints, focal, imageWidth, imageHeight) {
  const rows = [];

  for (const [a, b] of PAIRS) {
    const wa = worldPoints[a];
    const wb = worldPoints[b];
    const ia = imagePoints[a];
    const ib = imagePoints[b];
    if (!wa || !wb || !ia || !ib) continue;

    const projectedMm = Math.hypot(
      (wa.x - wb.x) * 1000,
      (wa.y - wb.y) * 1000
    );
    const pixelDistance = Math.hypot(
      (ia.x - ib.x) * imageWidth,
      (ia.y - ib.y) * imageHeight
    );

    let depthMm = null;
    if (projectedMm >= 3 && pixelDistance >= 6) {
      const depth = focal * projectedMm / pixelDistance;
      if (Number.isFinite(depth) && depth >= DEPTH_MIN_MM && depth <= DEPTH_MAX_MM) {
        depthMm = depth;
      }
    }

    rows.push({ pair: `${a}-${b}`, depthMm, inlier: false });
  }

  return rows;
}

function robustDepthConsensus(rows) {
  const validRows = rows.filter((row) => Number.isFinite(row.depthMm));
  if (validRows.length < MIN_VALID_PAIRS) {
    return {
      accepted: false,
      candidateMm: null,
      medianMm: null,
      relativeMad: Infinity,
      inlierCount: 0,
      validCount: validRows.length,
      confidence: 0,
      reason: "pocas parejas"
    };
  }

  const depths = validRows.map((row) => row.depthMm);
  const center = median(depths);
  const deviations = depths.map((depth) => Math.abs(depth - center));
  const mad = median(deviations);
  const relativeMad = mad / Math.max(center, 1);
  const band = Math.max(INLIER_BAND_MIN_MM, center * INLIER_BAND_RATIO);

  const inlierRows = validRows.filter((row) => Math.abs(row.depthMm - center) <= band);
  for (const row of inlierRows) row.inlier = true;

  const candidateMm = inlierRows.length
    ? median(inlierRows.map((row) => row.depthMm))
    : null;

  const accepted = Boolean(
    Number.isFinite(candidateMm) &&
    inlierRows.length >= MIN_INLIER_PAIRS &&
    relativeMad <= MAX_RELATIVE_MAD
  );

  const dispersionConfidence = clamp(1 - relativeMad / MAX_RELATIVE_MAD, 0, 1);
  const countConfidence = clamp(
    (inlierRows.length - MIN_INLIER_PAIRS + 1) /
      (PAIRS.length - MIN_INLIER_PAIRS + 1),
    0,
    1
  );
  const confidence = clamp(0.25 + dispersionConfidence * 0.55 + countConfidence * 0.20, 0, 1);

  return {
    accepted,
    candidateMm,
    medianMm: center,
    relativeMad,
    inlierCount: inlierRows.length,
    validCount: validRows.length,
    confidence,
    reason: accepted ? "consenso" : "medidas dispersas"
  };
}

function filterAcceptedDepth(targetMm, confidence, now) {
  if (
    !Number.isFinite(filteredDepthMm) ||
    !lastFilterTimestamp ||
    now - lastFilterTimestamp > FILTER_STALE_MS
  ) {
    filteredDepthMm = targetMm;
    lastFilterTimestamp = now;
    return filteredDepthMm;
  }

  const dt = clamp((now - lastFilterTimestamp) / 1000, 1 / 120, 0.12);
  lastFilterTimestamp = now;

  const speed = Math.abs(targetMm - filteredDepthMm) / dt;
  // Más confianza => menos filtro. Movimiento real coherente => responde más rápido.
  const cutoff = 0.65 + confidence * 1.8 + Math.min(speed / 350, 3.0);
  const tau = 1 / (2 * Math.PI * Math.max(0.05, cutoff));
  const alpha = 1 / (1 + tau / dt);

  filteredDepthMm += (targetMm - filteredDepthMm) * alpha;
  return filteredDepthMm;
}

function chooseDepth(consensus, now) {
  if (consensus.accepted && Number.isFinite(consensus.candidateMm)) {
    const output = filterAcceptedDepth(consensus.candidateMm, consensus.confidence, now);
    lastAcceptedDepthMm = consensus.candidateMm;
    lastAcceptedAt = now;
    return { depthMm: output, frozen: false };
  }

  // Si la pose vuelve incoherentes las parejas, NO actualizamos distancia.
  if (Number.isFinite(filteredDepthMm)) {
    return { depthMm: filteredDepthMm, frozen: true };
  }

  // Arranque excepcional: hasta conseguir consenso, usamos la mediana disponible
  // para no dejar el reloj invisible. En cuanto haya consenso se sustituye.
  if (Number.isFinite(consensus.medianMm)) {
    filteredDepthMm = consensus.medianMm;
    lastFilterTimestamp = now;
    return { depthMm: filteredDepthMm, frozen: true };
  }

  return { depthMm: null, frozen: true };
}

function ensureMetricHud() {
  if (metricHud || typeof document === "undefined") return metricHud;
  const root = document.querySelector(".camera-lab") || document.body;
  if (!root) return null;

  metricHud = document.createElement("div");
  metricHud.id = "metricDepthHud";
  metricHud.setAttribute("aria-live", "polite");
  Object.assign(metricHud.style, {
    position: "absolute",
    top: "64px",
    left: "10px",
    zIndex: "12",
    minWidth: "176px",
    maxWidth: "235px",
    padding: "8px 9px",
    borderRadius: "10px",
    background: "rgba(0,0,0,.72)",
    color: "white",
    font: "600 10px/1.28 ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.01em",
    pointerEvents: "none",
    whiteSpace: "pre"
  });
  metricHud.textContent = "AR-04B · esperando mano";
  root.appendChild(metricHud);
  return metricHud;
}

function formatDepth(value) {
  return Number.isFinite(value) ? `${Math.round(value)}mm` : "—";
}

function publishDiagnostics(consensus, chosen, rows) {
  const now = performance.now();
  if (now - lastDiagnosticSampleAt < DIAGNOSTIC_SAMPLE_MS) return;
  lastDiagnosticSampleAt = now;

  const hud = ensureMetricHud();
  if (hud) {
    const state = chosen.frozen ? "CONGELADA" : "ACTUALIZA";
    const madPercent = Number.isFinite(consensus.relativeMad)
      ? (consensus.relativeMad * 100).toFixed(1) + "%"
      : "—";
    const lines = [
      `AR-04B  PROF ${Math.round(chosen.depthMm)} mm`,
      `${state} · ${consensus.inlierCount}/${consensus.validCount} · MAD ${madPercent}`,
      "par    medida"
    ];
    for (const row of rows) {
      lines.push(`${row.inlier ? "*" : " "}${row.pair.padEnd(5)} ${formatDepth(row.depthMm).padStart(6)}`);
    }
    hud.textContent = lines.join("\n");
    hud.style.borderColor = chosen.frozen
      ? "rgba(255,183,77,.85)"
      : "rgba(105,240,174,.85)";
  }

  if (window.AmuraTrackingDiagnostics) {
    window.AmuraTrackingDiagnostics["AR-04B profundidad"] = `${Math.round(chosen.depthMm)} mm`;
    window.AmuraTrackingDiagnostics["AR-04B estado"] = chosen.frozen
      ? "δ profundidad congelada por dispersión"
      : "profundidad actualizada por consenso";
    window.AmuraTrackingDiagnostics["AR-04B consenso"] =
      `${consensus.inlierCount}/${consensus.validCount} · MAD ` +
      (Number.isFinite(consensus.relativeMad)
        ? (consensus.relativeMad * 100).toFixed(1) + "%"
        : "—");
    window.AmuraTrackingDiagnostics["AR-04B última fiable"] = lastAcceptedAt
      ? `${Math.round(lastAcceptedDepthMm)} mm · ${Math.round((now - lastAcceptedAt) / 100) / 10}s`
      : "—";
  }
}

export function solveMetricWristPose(options) {
  const worldPoints = options.worldPoints;
  const imagePoints = options.imagePoints;
  const physicalHand = options.physicalHand;
  const imageWidth = Math.max(1, Number(options.imageWidth) || 1);
  const imageHeight = Math.max(1, Number(options.imageHeight) || 1);
  const focal = Math.max(1, Number(options.focal) || 1);

  if (!Array.isArray(worldPoints) || worldPoints.length < 18) return null;
  if (!Array.isArray(imagePoints) || imagePoints.length < 18) return null;
  if (!imagePoints[0]) return null;

  const rows = pairDepthRows(worldPoints, imagePoints, focal, imageWidth, imageHeight);
  const consensus = robustDepthConsensus(rows);
  const now = performance.now();
  const chosen = chooseDepth(consensus, now);
  const depthMm = chosen.depthMm;
  if (!Number.isFinite(depthMm)) return null;

  publishDiagnostics(consensus, chosen, rows);

  const p0 = imagePoints[0];
  const u = p0.x * imageWidth;
  const v = p0.y * imageHeight;
  const cx = imageWidth * 0.5;
  const cy = imageHeight * 0.5;

  const positionMm = {
    x: (u - cx) * depthMm / focal,
    y: -(v - cy) * depthMm / focal,
    z: -depthMm
  };

  const basis = metricWristBasis(worldPoints, physicalHand);
  if (!basis) return null;
  const toThree = (axis) => ({ x: axis.x, y: -axis.y, z: -axis.z });

  const palmWidthMm = len(sub(worldPoints[17], worldPoints[5])) * 1000;

  return {
    positionMm,
    depthMm,
    palmWidthMm,
    depthConsensus: consensus,
    depthFrozen: chosen.frozen,
    reprojectionErrorPx: 0,
    xAxis: toThree(basis.xAxis),
    yAxis: toThree(basis.yAxis),
    zAxis: toThree(basis.zAxis),
    armAxis: toThree(basis.xAxis),
    focal
  };
}
