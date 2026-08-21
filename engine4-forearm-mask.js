const video = document.getElementById("cameraVideo");
const trackingCanvas = document.getElementById("trackingCanvas");
const maskCanvas = document.getElementById("maskCanvas");
const maskContext = maskCanvas.getContext("2d");
const readyButton = document.getElementById("maskReadyButton");
const resetButton = document.getElementById("maskResetButton");
const photoButton = document.getElementById("maskPhotoButton");
const maskStateValue = document.getElementById("maskStateValue");
const maskCenterValue = document.getElementById("maskCenterValue");
const maskWidthValue = document.getElementById("maskWidthValue");
const maskDeltaValue = document.getElementById("maskDeltaValue");
const maskRollValue = document.getElementById("maskRollValue");
const maskCoverageValue = document.getElementById("maskCoverageValue");
const maskHint = document.getElementById("maskHint");

const analysisCanvas = document.createElement("canvas");
const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
const TARGET_ANALYSIS_WIDTH = 360;
const ANALYSIS_INTERVAL_MS = 80;
const AXIS_SLICE_FRACTIONS = [0.18, 0.32, 0.46, 0.60, 0.74];

let calibrated = false;
let calibration = null;
let previewGeometry = null;
let lastAnalysisAt = 0;
let rafHandle = 0;
let lastMetrics = null;
let currentMetrics = null;

function parseVector(value) {
  if (!value || value === "—") return null;
  const numbers = String(value).split(",").map((item) => Number(item.trim()));
  if (numbers.length < 2 || !numbers.every(Number.isFinite)) return null;
  return { x: numbers[0], y: numbers[1], z: numbers[2] || 0 };
}

function parseAngle(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalize2(x, y) {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length < 1e-5) return null;
  return { x: x / length, y: y / length };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const mix = index - lo;
  return sorted[lo] * (1 - mix) + sorted[hi] * mix;
}

function robustChannel(values, floor) {
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const sigma = Math.max(floor, median(deviations) * 1.4826);
  return { center, sigma };
}

function rgbToYCbCr(r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  };
}

function ensureCanvasSize() {
  const sourceWidth = video.videoWidth || 0;
  const sourceHeight = video.videoHeight || 0;
  if (!sourceWidth || !sourceHeight) return false;

  const width = TARGET_ANALYSIS_WIDTH;
  const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
  if (analysisCanvas.width !== width || analysisCanvas.height !== height) {
    analysisCanvas.width = width;
    analysisCanvas.height = height;
    maskCanvas.width = width;
    maskCanvas.height = height;
  }
  return true;
}

function currentP0() {
  const diagnostics = window.AmuraTrackingDiagnostics || {};
  const origin = parseVector(diagnostics["Origen muñeca"]);
  const detected = diagnostics["Mano detectada"] === "sí";
  if (!detected || !origin) return null;
  return origin;
}

function currentP0Cut(width, height, calibrationState) {
  const normalized = currentP0();
  if (normalized) {
    const point = {
      x: normalized.x * width,
      y: normalized.y * height
    };
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      calibrationState.lastP0Cut = point;
      return { point, source: "VIVO" };
    }
  }

  if (calibrationState.lastP0Cut) {
    return { point: calibrationState.lastP0Cut, source: "RETENIDO" };
  }
  return null;
}

function anchorGeometryLongitudinallyToPoint(geometry, point) {
  if (!geometry?.origin || !geometry?.elbow || !point) return geometry;
  const dx = point.x - geometry.origin.x;
  const dy = point.y - geometry.origin.y;
  const along = dx * geometry.elbow.x + dy * geometry.elbow.y;
  if (!Number.isFinite(along)) return geometry;
  return {
    ...geometry,
    origin: {
      x: geometry.origin.x + geometry.elbow.x * along,
      y: geometry.origin.y + geometry.elbow.y * along
    },
    roiStart: 0
  };
}

function currentRoll() {
  const diagnostics = window.AmuraTrackingDiagnostics || {};
  return parseAngle(diagnostics["Giro Y muñeca"]);
}

function modelFromSamples(ys, cbs, crs, floors = {}) {
  if (ys.length < 60) return null;
  return {
    y: robustChannel(ys, floors.y || 14),
    cb: robustChannel(cbs, floors.cb || 5.0),
    cr: robustChannel(crs, floors.cr || 5.0),
    sampleCount: ys.length
  };
}

function provisionalColorModel(imageData, p0) {
  const width = imageData.width;
  const height = imageData.height;
  const source = imageData.data;
  const scale = width;
  const ys = [];
  const cbs = [];
  const crs = [];

  const x0 = clamp(Math.round(p0.x - scale * 0.11), 0, width - 1);
  const x1 = clamp(Math.round(p0.x - scale * 0.018), 0, width - 1);
  const y0 = clamp(Math.round(p0.y - scale * 0.052), 0, height - 1);
  const y1 = clamp(Math.round(p0.y + scale * 0.052), 0, height - 1);

  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const index = (y * width + x) * 4;
      const color = rgbToYCbCr(source[index], source[index + 1], source[index + 2]);
      if (color.y < 18 || color.y > 245) continue;
      ys.push(color.y);
      cbs.push(color.cb);
      crs.push(color.cr);
    }
  }

  return modelFromSamples(ys, cbs, crs, { y: 18, cb: 6.5, cr: 6.5 });
}

function isSkinPixel(r, g, b, model, loose = false) {
  const color = rgbToYCbCr(r, g, b);
  if (color.y < 14 || color.y > 250) return false;

  const cb = (color.cb - model.cb.center) / model.cb.sigma;
  const cr = (color.cr - model.cr.center) / model.cr.sigma;
  const y = (color.y - model.y.center) / model.y.sigma;
  const chromaDistance = cb * cb + cr * cr;
  const luminanceDistance = Math.abs(y);

  return chromaDistance <= (loose ? 13.5 : 10.5) && luminanceDistance <= (loose ? 5.0 : 4.2);
}

function fitAxis(points, preferredDirection) {
  if (points.length < 2) return null;
  const mean = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };

  let xx = 0;
  let xy = 0;
  let yy = 0;
  points.forEach((point) => {
    const dx = point.x - mean.x;
    const dy = point.y - mean.y;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  });

  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  let direction = { x: Math.cos(angle), y: Math.sin(angle) };
  if (preferredDirection && direction.x * preferredDirection.x + direction.y * preferredDirection.y < 0) {
    direction = { x: -direction.x, y: -direction.y };
  }
  return { mean, direction, perpendicular: { x: -direction.y, y: direction.x } };
}

function pointAlong(geometry, t, u = 0) {
  return {
    x: geometry.origin.x + geometry.elbow.x * t + geometry.perpendicular.x * u,
    y: geometry.origin.y + geometry.elbow.y * t + geometry.perpendicular.y * u
  };
}

function coordinatesInGeometry(x, y, geometry) {
  const dx = x - geometry.origin.x;
  const dy = y - geometry.origin.y;
  return {
    t: dx * geometry.elbow.x + dy * geometry.elbow.y,
    u: dx * geometry.perpendicular.x + dy * geometry.perpendicular.y
  };
}

function detectPreviewGeometry(imageData) {
  const p0Normalized = currentP0();
  if (!p0Normalized) return null;

  const width = imageData.width;
  const height = imageData.height;
  const scale = width;
  const p0 = {
    x: p0Normalized.x * width,
    y: p0Normalized.y * height
  };
  const model = provisionalColorModel(imageData, p0);
  if (!model) return null;

  const source = imageData.data;
  const sliceDistances = [0.08, 0.17, 0.26, 0.35, 0.44, 0.53].map((fraction) => scale * fraction);
  const halfSlice = Math.max(4, Math.round(scale * 0.022));
  const searchHalfHeight = scale * 0.19;
  const sections = [];
  let predictedY = p0.y;

  for (const distance of sliceDistances) {
    const centerX = p0.x - distance;
    if (centerX < 2 || centerX >= width - 2) continue;
    const ys = [];
    const x0 = clamp(Math.round(centerX - halfSlice), 0, width - 1);
    const x1 = clamp(Math.round(centerX + halfSlice), 0, width - 1);
    const y0 = clamp(Math.round(predictedY - searchHalfHeight), 0, height - 1);
    const y1 = clamp(Math.round(predictedY + searchHalfHeight), 0, height - 1);

    for (let y = y0; y <= y1; y += 1) {
      let hits = 0;
      let tested = 0;
      for (let x = x0; x <= x1; x += 2) {
        const index = (y * width + x) * 4;
        tested += 1;
        if (isSkinPixel(source[index], source[index + 1], source[index + 2], model, true)) hits += 1;
      }
      if (tested > 0 && hits / tested >= 0.42) ys.push(y + 0.5);
    }

    if (ys.length < scale * 0.045) continue;
    const low = quantile(ys, 0.06);
    const high = quantile(ys, 0.94);
    const centerY = median(ys);
    if (high - low < scale * 0.055 || high - low > scale * 0.38) continue;

    sections.push({
      x: centerX,
      center: { x: centerX, y: centerY },
      top: { x: centerX, y: low },
      bottom: { x: centerX, y: high },
      width: high - low,
      distance
    });
    predictedY = centerY;
  }

  if (sections.length < 3) return null;
  const axis = fitAxis(sections.map((section) => section.center), { x: -1, y: 0 });
  if (!axis || axis.direction.x > -0.10) return null;

  const halfWidths = sections.map((section) => section.width * 0.5);
  const bodyHalfWidth = clamp(median(halfWidths), scale * 0.055, scale * 0.19);
  const farthest = Math.max(...sections.map((section) => section.distance));
  const roiEnd = clamp(farthest + scale * 0.055, scale * 0.38, scale * 0.62);
  const origin = { x: p0.x, y: p0.y };
  const elbow = axis.direction;
  const perpendicular = { x: -elbow.y, y: elbow.x };

  return {
    origin,
    elbow,
    perpendicular,
    roiStart: 0,
    roiEnd,
    roiHalfWidth: bodyHalfWidth * 1.35,
    seedStart: scale * 0.08,
    seedEnd: Math.min(roiEnd * 0.60, scale * 0.30),
    seedHalfWidth: bodyHalfWidth * 0.55,
    measureStart: scale * 0.12,
    measureEnd: Math.min(roiEnd * 0.70, scale * 0.36),
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    previewSections: sections,
    p0
  };
}

function learnColorModel(imageData, geometry) {
  const ys = [];
  const cbs = [];
  const crs = [];
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const local = coordinatesInGeometry(x + 0.5, y + 0.5, geometry);
      if (
        local.t < geometry.seedStart || local.t > geometry.seedEnd ||
        Math.abs(local.u) > geometry.seedHalfWidth
      ) continue;

      const index = (y * width + x) * 4;
      const color = rgbToYCbCr(data[index], data[index + 1], data[index + 2]);
      if (color.y < 18 || color.y > 245) continue;
      ys.push(color.y);
      cbs.push(color.cb);
      crs.push(color.cr);
    }
  }

  return modelFromSamples(ys, cbs, crs, { y: 16, cb: 5.5, cr: 5.5 });
}

function drawPreviewCorridor(geometry) {
  maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  const sections = geometry.previewSections || [];
  if (sections.length < 2) return;

  maskContext.save();
  maskContext.lineWidth = 2;
  maskContext.strokeStyle = "rgba(255,214,102,.96)";
  maskContext.setLineDash([7, 5]);

  maskContext.beginPath();
  maskContext.moveTo(geometry.p0.x, geometry.p0.y);
  sections.forEach((section) => maskContext.lineTo(section.top.x, section.top.y));
  maskContext.stroke();

  maskContext.beginPath();
  maskContext.moveTo(geometry.p0.x, geometry.p0.y);
  sections.forEach((section) => maskContext.lineTo(section.bottom.x, section.bottom.y));
  maskContext.stroke();
  maskContext.setLineDash([]);

  maskContext.strokeStyle = "rgba(255,255,255,.95)";
  maskContext.lineWidth = 2;
  maskContext.beginPath();
  maskContext.arc(geometry.p0.x, geometry.p0.y, 5, 0, Math.PI * 2);
  maskContext.stroke();

  maskContext.strokeStyle = "rgba(255,255,255,.70)";
  maskContext.lineWidth = 1.5;
  maskContext.beginPath();
  sections.forEach((section, index) => {
    if (index === 0) maskContext.moveTo(section.center.x, section.center.y);
    else maskContext.lineTo(section.center.x, section.center.y);
  });
  maskContext.stroke();
  maskContext.restore();
}

function drawTrackedGeometry(geometry, centers) {
  maskContext.save();
  const half = geometry.roiHalfWidth;
  const corners = [
    pointAlong(geometry, geometry.roiStart, -half),
    pointAlong(geometry, geometry.roiEnd, -half),
    pointAlong(geometry, geometry.roiEnd, half),
    pointAlong(geometry, geometry.roiStart, half)
  ];
  maskContext.strokeStyle = "rgba(255,255,255,.55)";
  maskContext.lineWidth = 1.5;
  maskContext.setLineDash([6, 5]);
  maskContext.beginPath();
  maskContext.moveTo(corners[0].x, corners[0].y);
  corners.slice(1).forEach((point) => maskContext.lineTo(point.x, point.y));
  maskContext.closePath();
  maskContext.stroke();
  maskContext.setLineDash([]);

  if (centers && centers.length >= 2) {
    const axis = fitAxis(centers, geometry.elbow);
    if (axis) {
      const projections = centers.map((point) => (point.x - axis.mean.x) * axis.direction.x + (point.y - axis.mean.y) * axis.direction.y);
      const minProjection = Math.min(...projections) - 18;
      const maxProjection = Math.max(...projections) + 18;
      const a = {
        x: axis.mean.x + axis.direction.x * minProjection,
        y: axis.mean.y + axis.direction.y * minProjection
      };
      const b = {
        x: axis.mean.x + axis.direction.x * maxProjection,
        y: axis.mean.y + axis.direction.y * maxProjection
      };
      maskContext.strokeStyle = "rgba(255,255,255,.98)";
      maskContext.lineWidth = 3;
      maskContext.beginPath();
      maskContext.moveTo(a.x, a.y);
      maskContext.lineTo(b.x, b.y);
      maskContext.stroke();

      maskContext.fillStyle = "rgba(255,255,255,.98)";
      centers.forEach((point) => {
        maskContext.beginPath();
        maskContext.arc(point.x, point.y, 4, 0, Math.PI * 2);
        maskContext.fill();
      });
    }
  }
  maskContext.restore();
}

function collectSliceCenters(points, geometry) {
  if (!points.length) return [];
  const halfSlice = geometry.roiEnd * 0.065;
  const centers = [];

  AXIS_SLICE_FRACTIONS.forEach((fraction) => {
    const targetT = geometry.roiEnd * fraction;
    const xs = [];
    const ys = [];
    const us = [];
    points.forEach((point) => {
      if (Math.abs(point.t - targetT) > halfSlice) return;
      xs.push(point.x);
      ys.push(point.y);
      us.push(point.u);
    });
    if (xs.length < 35) return;
    centers.push({
      x: median(xs),
      y: median(ys),
      uMedian: median(us),
      uLow: quantile(us, 0.08),
      uHigh: quantile(us, 0.92),
      targetT,
      count: xs.length
    });
  });
  return centers;
}

function updateGeometryFromCloud(geometry, centers) {
  if (centers.length < 3) return geometry;
  const axis = fitAxis(centers, geometry.elbow);
  if (!axis) return geometry;

  let direction = axis.direction;
  const angleDot = clamp(direction.x * geometry.elbow.x + direction.y * geometry.elbow.y, -1, 1);
  const angleDelta = Math.acos(angleDot);
  if (angleDelta > Math.PI / 5) return geometry;

  const orientationMix = 0.35;
  direction = normalize2(
    geometry.elbow.x * (1 - orientationMix) + direction.x * orientationMix,
    geometry.elbow.y * (1 - orientationMix) + direction.y * orientationMix
  ) || geometry.elbow;
  const perpendicular = { x: -direction.y, y: direction.x };

  const mean = {
    x: centers.reduce((sum, point) => sum + point.x, 0) / centers.length,
    y: centers.reduce((sum, point) => sum + point.y, 0) / centers.length
  };
  const fromMeanToOldOrigin = {
    x: geometry.origin.x - mean.x,
    y: geometry.origin.y - mean.y
  };
  const along = fromMeanToOldOrigin.x * direction.x + fromMeanToOldOrigin.y * direction.y;
  const projectedOrigin = {
    x: mean.x + direction.x * along,
    y: mean.y + direction.y * along
  };
  const origin = {
    x: geometry.origin.x * 0.25 + projectedOrigin.x * 0.75,
    y: geometry.origin.y * 0.25 + projectedOrigin.y * 0.75
  };

  const robustHalfWidths = centers
    .map((point) => Math.max(0, point.uHigh - point.uLow) * 0.5)
    .filter((value) => value > 2);
  const observedHalf = robustHalfWidths.length ? median(robustHalfWidths) : geometry.roiHalfWidth / 1.35;
  const desiredHalf = clamp(observedHalf * 1.55, calibration.initialHalfWidth * 0.68, calibration.initialHalfWidth * 1.55);
  const roiHalfWidth = geometry.roiHalfWidth * 0.82 + desiredHalf * 0.18;

  const scaleFactor = clamp(roiHalfWidth / calibration.initialHalfWidth, 0.76, 1.36);
  const desiredEnd = calibration.initialRoiEnd * scaleFactor;
  const roiEnd = geometry.roiEnd * 0.85 + desiredEnd * 0.15;

  return {
    ...geometry,
    origin,
    elbow: direction,
    perpendicular,
    roiEnd,
    roiHalfWidth,
    seedStart: roiEnd * calibration.seedStartFraction,
    seedEnd: roiEnd * calibration.seedEndFraction,
    seedHalfWidth: roiHalfWidth * calibration.seedHalfFraction,
    measureStart: roiEnd * calibration.measureStartFraction,
    measureEnd: roiEnd * calibration.measureEndFraction
  };
}

function segmentFrame(imageData, calibrationState) {
  let geometry = calibrationState.geometry;
  const model = calibrationState.model;
  const width = imageData.width;
  const height = imageData.height;
  const source = imageData.data;
  const overlay = maskContext.createImageData(width, height);
  const target = overlay.data;
  const points = [];
  const measureUs = [];
  let measureCount = 0;
  let bandCandidates = 0;

  const searchHalfWidth = geometry.roiHalfWidth * 1.65;
  const searchStart = geometry.roiStart - geometry.roiEnd * 0.05;
  const searchEnd = geometry.roiEnd * 1.08;
  const p0Cut = currentP0Cut(width, height, calibrationState);
  // P0 is allowed to correct only the longitudinal wrist station.
  // It never drags the cloud laterally: the transverse position remains autonomous.
  // With live P0, t=0 is therefore a 2D plane that passes through P0 every frame.
  if (p0Cut?.source === "VIVO") {
    geometry = anchorGeometryLongitudinallyToPoint(geometry, p0Cut.point);
    calibrationState.geometry = geometry;
  }
  const p0CutT = p0Cut ? coordinatesInGeometry(p0Cut.point.x, p0Cut.point.y, geometry).t : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const local = coordinatesInGeometry(x + 0.5, y + 0.5, geometry);
      if (local.t < searchStart || local.t > searchEnd || Math.abs(local.u) > searchHalfWidth) continue;
      if (Number.isFinite(p0CutT) && local.t < p0CutT) continue;

      const index = (y * width + x) * 4;
      if (!isSkinPixel(source[index], source[index + 1], source[index + 2], model, false)) continue;

      target[index] = 0;
      target[index + 1] = 229;
      target[index + 2] = 255;
      target[index + 3] = 92;
      points.push({ x: x + 0.5, y: y + 0.5, t: local.t, u: local.u });

      const inMeasureBand = local.t >= geometry.measureStart && local.t <= geometry.measureEnd;
      if (inMeasureBand) {
        measureCount += 1;
        measureUs.push(local.u);
      }
    }
  }

  const bandLength = Math.max(1, geometry.measureEnd - geometry.measureStart);
  bandCandidates = bandLength * Math.max(1, geometry.roiHalfWidth * 2);

  maskContext.clearRect(0, 0, width, height);
  maskContext.putImageData(overlay, 0, 0);

  const centers = collectSliceCenters(points, geometry);
  if (centers.length >= 3) {
    geometry = updateGeometryFromCloud(geometry, centers);
    // Fitting a new axis can move the historical origin along that axis.
    // Re-impose the live P0 plane after the fit so the next frame cannot inherit drift.
    if (p0Cut?.source === "VIVO") {
      geometry = anchorGeometryLongitudinallyToPoint(geometry, p0Cut.point);
    }
    calibrationState.geometry = geometry;
    calibrationState.lastGoodAt = performance.now();
  }
  drawTrackedGeometry(geometry, centers);

  if (centers.length < 3 || measureCount < 35) return null;

  const centerPoint = centers[Math.floor(centers.length / 2)];
  const videoScaleX = geometry.sourceWidth / width;
  const videoScaleY = geometry.sourceHeight / height;
  const videoScale = (videoScaleX + videoScaleY) * 0.5;
  const lowU = quantile(measureUs, 0.05);
  const highU = quantile(measureUs, 0.95);
  const widthVideoPx = Math.max(0, highU - lowU) * videoScale;

  return {
    centerX: centerPoint.x * videoScaleX,
    centerY: centerPoint.y * videoScaleY,
    widthPx: widthVideoPx,
    coverage: bandCandidates > 0 ? measureCount / bandCandidates : 0,
    pixelCount: measureCount,
    axisCenters: centers.length,
    p0CutSource: p0Cut ? p0Cut.source : "SIN P0",
    p0CutErrorPx: Number.isFinite(p0CutT) ? Math.abs(p0CutT) : null
  };
}

function updateHud(metrics) {
  const roll = currentRoll();
  maskRollValue.textContent = Number.isFinite(roll) ? roll.toFixed(1) + "°" : "—";

  if (!calibrated) {
    maskStateValue.textContent = previewGeometry ? "P0 + ANTEBRAZO VISTO" : (currentP0() ? "BUSCANDO ANTEBRAZO" : "BUSCANDO P0");
    maskCenterValue.textContent = "—";
    maskWidthValue.textContent = "—";
    maskDeltaValue.textContent = "—";
    maskCoverageValue.textContent = "—";
    return;
  }

  if (!metrics) {
    maskStateValue.textContent = "NUBE PERDIDA";
    maskCenterValue.textContent = "—";
    maskWidthValue.textContent = "—";
    maskDeltaValue.textContent = "—";
    maskCoverageValue.textContent = "—";
    return;
  }

  const cutText = Number.isFinite(metrics.p0CutErrorPx) ? " · CORTE " + metrics.p0CutErrorPx.toFixed(1) + "px" : "";
  maskStateValue.textContent = "NUBE AUTÓNOMA · P0 " + metrics.p0CutSource + cutText + " · " + metrics.axisCenters + "/5 CENTROS";
  maskCenterValue.textContent = metrics.centerX.toFixed(1) + " / " + metrics.centerY.toFixed(1) + " px";
  maskWidthValue.textContent = metrics.widthPx.toFixed(1) + " px";
  maskCoverageValue.textContent = (metrics.coverage * 100).toFixed(1) + "% · " + metrics.pixelCount + " px";

  if (lastMetrics) {
    const deltaCenter = Math.hypot(metrics.centerX - lastMetrics.centerX, metrics.centerY - lastMetrics.centerY);
    const deltaWidth = metrics.widthPx - lastMetrics.widthPx;
    maskDeltaValue.textContent = "centro " + deltaCenter.toFixed(1) + " px · ancho " + (deltaWidth >= 0 ? "+" : "") + deltaWidth.toFixed(1) + " px";
  } else {
    maskDeltaValue.textContent = "primer frame";
  }
}

function paintPreview() {
  if (!ensureCanvasSize()) return;
  analysisContext.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const imageData = analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  previewGeometry = detectPreviewGeometry(imageData);
  if (previewGeometry) drawPreviewCorridor(previewGeometry);
  else maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
}

function calibrate() {
  if (!ensureCanvasSize()) {
    maskHint.textContent = "La cámara todavía no está lista.";
    return;
  }

  analysisContext.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const imageData = analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  const geometry = detectPreviewGeometry(imageData) || previewGeometry;
  if (!geometry) {
    maskHint.textContent = "No veo bien el antebrazo desde P0. Pon la mano a la derecha y el antebrazo hacia la izquierda sobre un fondo contrastado.";
    return;
  }

  const model = learnColorModel(imageData, geometry);
  if (!model) {
    maskHint.textContent = "No he podido aprender suficiente piel. Recoloca el antebrazo y vuelve a pulsar LISTO.";
    return;
  }

  const seedStartFraction = geometry.seedStart / geometry.roiEnd;
  const seedEndFraction = geometry.seedEnd / geometry.roiEnd;
  const seedHalfFraction = geometry.seedHalfWidth / geometry.roiHalfWidth;
  const measureStartFraction = geometry.measureStart / geometry.roiEnd;
  const measureEndFraction = geometry.measureEnd / geometry.roiEnd;

  calibration = {
    geometry: { ...geometry, previewSections: null, p0: null },
    model,
    initialRoll: currentRoll(),
    initialHalfWidth: geometry.roiHalfWidth,
    initialRoiEnd: geometry.roiEnd,
    seedStartFraction,
    seedEndFraction,
    seedHalfFraction,
    measureStartFraction,
    measureEndFraction,
    learnedAt: Date.now(),
    lastGoodAt: performance.now(),
    lastP0Cut: geometry.p0 ? { x: geometry.p0.x, y: geometry.p0.y } : null
  };
  calibrated = true;
  lastMetrics = null;
  currentMetrics = null;
  readyButton.hidden = true;
  resetButton.hidden = false;
  photoButton.hidden = false;
  maskHint.textContent = "La nube mueve sola la ventana. P0 solo recorta el lado de la mano; si se pierde, se mantiene el último P0 válido.";
}

function resetCalibration() {
  calibrated = false;
  calibration = null;
  previewGeometry = null;
  lastMetrics = null;
  currentMetrics = null;
  readyButton.hidden = false;
  resetButton.hidden = true;
  photoButton.hidden = true;
  maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskHint.textContent = "P0 solo marca el inicio. El corredor amarillo debe salir desde la muñeca hacia el codo y abrazar el antebrazo antes de LISTO.";
  updateHud(null);
}

function frameLoop(now) {
  rafHandle = requestAnimationFrame(frameLoop);
  if (now - lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
  lastAnalysisAt = now;
  if (video.readyState < 2 || !ensureCanvasSize()) return;

  if (!calibrated) {
    paintPreview();
    updateHud(null);
    return;
  }

  analysisContext.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
  const imageData = analysisContext.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  const metrics = segmentFrame(imageData, calibration);
  lastMetrics = currentMetrics;
  currentMetrics = metrics;
  updateHud(metrics);
}

function hudLinesForPhoto() {
  return [
    "AMURA · LAB EJE POR NUBE",
    "ESTADO: " + maskStateValue.textContent,
    "CENTRO X/Y: " + maskCenterValue.textContent,
    "ANCHO: " + maskWidthValue.textContent,
    "Δ FRAME: " + maskDeltaValue.textContent,
    "GIRO MEDIAPIPE: " + maskRollValue.textContent,
    "COBERTURA: " + maskCoverageValue.textContent,
    "P0: TOPE 2D MANO · NO POSICIONA NI REDIMENSIONA LA NUBE"
  ];
}

function takePhoto() {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const output = document.createElement("canvas");
  output.width = video.videoWidth;
  output.height = video.videoHeight;
  const context = output.getContext("2d");
  context.drawImage(video, 0, 0, output.width, output.height);
  context.drawImage(maskCanvas, 0, 0, output.width, output.height);
  if (trackingCanvas && trackingCanvas.width && trackingCanvas.height) {
    context.drawImage(trackingCanvas, 0, 0, output.width, output.height);
  }

  const lines = hudLinesForPhoto();
  const fontSize = Math.max(20, Math.round(output.width * 0.018));
  const lineHeight = Math.round(fontSize * 1.35);
  const padding = Math.round(fontSize * 0.65);
  const panelWidth = Math.min(output.width - padding * 2, Math.round(output.width * 0.70));
  const panelHeight = padding * 2 + lineHeight * lines.length;
  context.fillStyle = "rgba(0,0,0,.72)";
  context.fillRect(padding, padding, panelWidth, panelHeight);
  context.fillStyle = "#ffffff";
  context.font = "600 " + fontSize + "px Arial, sans-serif";
  context.textBaseline = "top";
  lines.forEach((line, index) => {
    context.fillText(line, padding * 2, padding * 2 + index * lineHeight, panelWidth - padding * 2);
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.download = "amura-axis-cloud-" + stamp + ".jpg";
  link.href = output.toDataURL("image/jpeg", 0.92);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

readyButton.addEventListener("click", calibrate);
resetButton.addEventListener("click", resetCalibration);
photoButton.addEventListener("click", takePhoto);

window.addEventListener("amura-camera-state", (event) => {
  if (!event.detail || event.detail.status !== "live") resetCalibration();
});

resetCalibration();
rafHandle = requestAnimationFrame(frameLoop);

window.addEventListener("pagehide", () => {
  if (rafHandle) cancelAnimationFrame(rafHandle);
});

window.AmuraForearmMaskLab = {
  snapshot() {
    return {
      calibrated,
      currentMetrics,
      initialRoll: calibration ? calibration.initialRoll : null,
      currentRoll: currentRoll(),
      geometry: calibration ? calibration.geometry : previewGeometry
    };
  }
};