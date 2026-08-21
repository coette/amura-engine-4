// AMURA ENGINE 4 · R1.1 · AUTORRESCATE
// Capa de vigilancia del eje oficial. NO cambia verde -> naranja.
// 3 lecturas malas seguidas => perdido. Si P0 esta vivo, relocaliza; si no, congela la ultima buena.

const POLL_MS = 80;
const BAD_LIMIT = 3;
const P0_STABLE_LIMIT = 2;
const WARMUP_MS = 850;
const COOLDOWN_MS = 1100;

const maskCanvas = document.getElementById("maskCanvas");
const readyButton = document.getElementById("maskReadyButton");
const resetButton = document.getElementById("maskResetButton");
const video = document.getElementById("cameraVideo");

let lab = null;
let rawSnapshot = null;
let timer = 0;
let wasCalibrated = false;
let calibratedSince = 0;
let ignoreUntil = 0;
let cooldownUntil = 0;
let badCount = 0;
let p0StableCount = 0;
let p0MissingSince = 0;
let badDuringP0Loss = false;
let frozen = false;
let waitingForP0 = false;
let rescuing = false;
let lastGoodSnapshot = null;
let lastGoodAxisMetrics = null;
let lastGoodOfficialAxis = null;
let lastGoodCanvasAt = 0;
let lastReason = "";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clone(value) {
  if (value === null || value === undefined) return value;
  try { return structuredClone(value); } catch (_) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
  }
}

function parseVector(value) {
  if (!value || value === "—") return null;
  const n = String(value).split(",").map((v) => Number(v.trim()));
  if (n.length < 2 || !Number.isFinite(n[0]) || !Number.isFinite(n[1])) return null;
  return { x: n[0], y: n[1] };
}

function p0Live() {
  const d = window.AmuraTrackingDiagnostics || {};
  return d["Mano detectada"] === "sí" && Boolean(parseVector(d["Origen muñeca"]));
}

function ensureBadge() {
  let badge = document.getElementById("engine4RescueBadge");
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = "engine4RescueBadge";
  badge.textContent = "AUTORRESCATE · ESPERANDO LISTO";
  badge.style.cssText = "position:absolute;left:10px;top:calc(env(safe-area-inset-top,0px) + 170px);z-index:100025;padding:6px 9px;border-radius:8px;background:rgba(4,8,14,.78);color:#fff;font:800 10px/1.25 Arial,sans-serif;letter-spacing:.03em;pointer-events:none;backdrop-filter:blur(6px)";
  (document.querySelector(".camera-lab") || document.body).appendChild(badge);
  return badge;
}

function setBadge(text) {
  const badge = ensureBadge();
  if (document.body.dataset.amuraMode === "bank") {
    badge.style.display = "none";
    return;
  }
  badge.style.display = "block";
  badge.textContent = text;
}

function ensureFreezeCanvas() {
  let c = document.getElementById("engine4FreezeCanvas");
  if (c) return c;
  c = document.createElement("canvas");
  c.id = "engine4FreezeCanvas";
  c.setAttribute("aria-hidden", "true");
  c.style.cssText = "display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:31;pointer-events:none";
  maskCanvas?.insertAdjacentElement("afterend", c);
  return c;
}

function captureGoodCanvas() {
  if (!maskCanvas || !maskCanvas.width || !maskCanvas.height) return;
  const c = ensureFreezeCanvas();
  if (c.width !== maskCanvas.width || c.height !== maskCanvas.height) {
    c.width = maskCanvas.width;
    c.height = maskCanvas.height;
  }
  const x = c.getContext("2d");
  if (!x) return;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(maskCanvas, 0, 0);
  lastGoodCanvasAt = performance.now();
}

function setFrozen(value, reason = "") {
  frozen = value;
  const c = ensureFreezeCanvas();
  if (value && lastGoodCanvasAt > 0) {
    c.style.display = "block";
    if (maskCanvas) maskCanvas.style.visibility = "hidden";
  } else {
    c.style.display = "none";
    if (maskCanvas) maskCanvas.style.visibility = "";
  }
  if (value) setBadge(`AUTORRESCATE · CONGELADO · ${reason || "ESPERANDO"}`);
}

function fitLine(points) {
  if (!points || points.length < 3) return null;
  const mean = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length
  };
  let xx = 0, xy = 0, yy = 0;
  for (const p of points) {
    const dx = p.x - mean.x, dy = p.y - mean.y;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  const a = 0.5 * Math.atan2(2 * xy, xx - yy);
  const d = { x: Math.cos(a), y: Math.sin(a) };
  const n = { x: -d.y, y: d.x };
  const along = points.map((p) => (p.x - mean.x) * d.x + (p.y - mean.y) * d.y);
  const cross = points.map((p) => Math.abs((p.x - mean.x) * n.x + (p.y - mean.y) * n.y));
  const span = Math.max(...along) - Math.min(...along);
  const rms = Math.sqrt(cross.reduce((s, v) => s + v * v, 0) / cross.length);
  return { span, ratio: span > 0 ? rms / span : Infinity };
}

function plausibility(snapshot, now) {
  const reasons = [];
  if (!snapshot?.calibrated) return { ok: true, reasons: [] };
  if (now < calibratedSince + WARMUP_MS || now < ignoreUntil) return { ok: true, reasons: [] };

  const m = snapshot.currentMetrics;
  if (!m) {
    reasons.push("sin nube");
  } else {
    const coverage = Number(m.coverage);
    if (!Number.isFinite(coverage) || coverage < 0.02 || coverage > 1.15) reasons.push("cobertura");
    if (!Number.isFinite(m.axisCenters) || m.axisCenters < 3) reasons.push("centros");
    const vw = video?.videoWidth || 0;
    if (vw && Number.isFinite(m.widthPx)) {
      const f = m.widthPx / vw;
      if (f < 0.015 || f > 0.60) reasons.push("anchura");
    }
  }

  const axisMetrics = window.AmuraEngine4AxisMetrics;
  const fresh = axisMetrics && Number.isFinite(axisMetrics.updatedAt) && now - axisMetrics.updatedAt < 650 && axisMetrics.final;
  if (!fresh) {
    reasons.push("eje");
  } else {
    const centers = axisMetrics.baseCenters || [];
    if (centers.length < 5) reasons.push("secciones");
    else {
      const shape = fitLine(centers);
      if (!shape || shape.span < 28 || shape.ratio > 0.24) reasons.push("forma");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

function saveGood(snapshot) {
  lastGoodSnapshot = clone(snapshot);
  lastGoodAxisMetrics = clone(window.AmuraEngine4AxisMetrics);
  lastGoodOfficialAxis = clone(window.AmuraEngine4OfficialAxis);
  captureGoodCanvas();
}

function restoreGoodGlobals() {
  if (!frozen) return;
  const now = performance.now();
  if (lastGoodAxisMetrics) {
    const axisMetrics = clone(lastGoodAxisMetrics);
    axisMetrics.updatedAt = now;
    if (axisMetrics.final) axisMetrics.final.updatedAt = now;
    window.AmuraEngine4AxisMetrics = axisMetrics;
  }
  if (lastGoodOfficialAxis) {
    const metric = clone(lastGoodOfficialAxis);
    metric.updatedAt = now;
    window.AmuraEngine4OfficialAxis = metric;
  }
}

function enterWaiting(reason) {
  waitingForP0 = true;
  lastReason = reason || "geometría no plausible";
  setFrozen(true, "ESPERANDO P0");
  restoreGoodGlobals();
}

async function relocalize(reason) {
  const now = performance.now();
  if (rescuing || now < cooldownUntil || document.body.dataset.amuraMode === "bank") return;
  if (p0StableCount < P0_STABLE_LIMIT) {
    enterWaiting(reason);
    return;
  }

  rescuing = true;
  waitingForP0 = false;
  lastReason = reason || "rescate";
  setFrozen(true, "RELOCALIZANDO");
  setBadge("AUTORRESCATE · RELOCALIZANDO DESDE P0");

  try {
    if (resetButton && !resetButton.hidden) resetButton.click();
    await sleep(140);

    if (!p0Live()) {
      enterWaiting("P0 perdido durante rescate");
      return;
    }

    if (readyButton) readyButton.click();
    await sleep(320);

    let s = rawSnapshot ? rawSnapshot() : null;
    if (!s?.calibrated && p0Live()) {
      await sleep(180);
      readyButton?.click();
      await sleep(280);
      s = rawSnapshot ? rawSnapshot() : null;
    }

    if (s?.calibrated) {
      badCount = 0;
      badDuringP0Loss = false;
      p0MissingSince = 0;
      waitingForP0 = false;
      calibratedSince = performance.now();
      ignoreUntil = calibratedSince + WARMUP_MS;
      cooldownUntil = calibratedSince + COOLDOWN_MS;
      setFrozen(false);
      setBadge("AUTORRESCATE · RECUPERADO");
      setTimeout(() => {
        if (!frozen && !rescuing) setBadge("AUTORRESCATE · VIGILANDO");
      }, 900);
    } else {
      enterWaiting("no pudo recalibrar");
    }
  } finally {
    rescuing = false;
  }
}

function updateP0(now) {
  const live = p0Live();
  if (live) {
    p0StableCount += 1;
    if (p0MissingSince && badDuringP0Loss && p0StableCount >= P0_STABLE_LIMIT) {
      p0MissingSince = 0;
      relocalize("P0 volvió tras pérdida");
    } else if (waitingForP0 && p0StableCount >= P0_STABLE_LIMIT) {
      p0MissingSince = 0;
      relocalize("P0 disponible");
    } else if (!badDuringP0Loss) {
      p0MissingSince = 0;
    }
  } else {
    p0StableCount = 0;
    if (!p0MissingSince) p0MissingSince = now;
  }
  return live;
}

function tick() {
  if (!rawSnapshot || document.body.dataset.amuraMode === "bank") {
    ensureBadge().style.display = document.body.dataset.amuraMode === "bank" ? "none" : "block";
    return;
  }

  const now = performance.now();
  const p0 = updateP0(now);
  const snapshot = rawSnapshot();
  const calibrated = Boolean(snapshot?.calibrated);

  if (calibrated && !wasCalibrated) {
    calibratedSince = now;
    ignoreUntil = now + WARMUP_MS;
    badCount = 0;
    setBadge("AUTORRESCATE · ASENTANDO");
  }
  wasCalibrated = calibrated;

  if (!calibrated) {
    if (!rescuing && !waitingForP0) setBadge("AUTORRESCATE · ESPERANDO LISTO");
    restoreGoodGlobals();
    return;
  }

  if (rescuing || waitingForP0) {
    restoreGoodGlobals();
    if (waitingForP0 && p0StableCount >= P0_STABLE_LIMIT) relocalize(lastReason || "P0 volvió");
    return;
  }

  const health = plausibility(snapshot, now);
  if (health.ok) {
    badCount = 0;
    saveGood(snapshot);
    setBadge("AUTORRESCATE · VIGILANDO");
    return;
  }

  badCount += 1;
  lastReason = health.reasons.join("+");
  if (!p0) badDuringP0Loss = true;
  setBadge(`AUTORRESCATE · AVISO ${badCount}/${BAD_LIMIT} · ${lastReason}`);

  if (badCount < BAD_LIMIT) return;
  if (p0StableCount >= P0_STABLE_LIMIT) relocalize(lastReason);
  else enterWaiting(lastReason);
}

async function start() {
  ensureBadge();
  ensureFreezeCanvas();
  const started = performance.now();
  while (!(lab = window.AmuraForearmMaskLab) || typeof lab.snapshot !== "function") {
    if (performance.now() - started > 9000) {
      setBadge("AUTORRESCATE · NO INICIADO");
      return;
    }
    await sleep(25);
  }

  rawSnapshot = lab.snapshot.bind(lab);
  lab.snapshot = function () {
    const current = rawSnapshot();
    if (frozen && lastGoodSnapshot) {
      return {
        ...current,
        calibrated: true,
        geometry: clone(lastGoodSnapshot.geometry),
        currentMetrics: clone(lastGoodSnapshot.currentMetrics),
        officialAxis: clone(lastGoodSnapshot.officialAxis || lastGoodOfficialAxis),
        rescueFrozen: true,
        rescueReason: lastReason
      };
    }
    return current;
  };
  lab.__engine4AutoRescueInstalled = true;

  window.AmuraEngine4Rescue = {
    revision: "ENGINE 4 · R1.1",
    get state() {
      return {
        frozen,
        waitingForP0,
        rescuing,
        badCount,
        p0StableCount,
        lastReason,
        hasLastGood: Boolean(lastGoodSnapshot)
      };
    },
    forceRescue() { relocalize("manual debug"); }
  };

  timer = window.setInterval(tick, POLL_MS);
  setBadge("AUTORRESCATE · ESPERANDO LISTO");
}

window.addEventListener("amura-camera-state", (event) => {
  if (!event.detail || event.detail.status !== "live") {
    badCount = 0;
    p0StableCount = 0;
    p0MissingSince = 0;
    badDuringP0Loss = false;
    waitingForP0 = false;
    rescuing = false;
    wasCalibrated = false;
    lastGoodSnapshot = null;
    lastGoodAxisMetrics = null;
    lastGoodOfficialAxis = null;
    lastGoodCanvasAt = 0;
    lastReason = "";
    setFrozen(false);
  }
});

window.addEventListener("pagehide", () => {
  if (timer) clearInterval(timer);
});

start();
