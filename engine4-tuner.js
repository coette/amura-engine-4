/**
 * AMURA · Panel de ajuste
 *
 * Convención única del sistema:
 * +X = 9 → 3 · +Y = 6 → 12 · +Z = esfera → cristal.
 */

const STORAGE_KEY = "amura.tuning.v112";

export const tuning = {
  // POSICIÓN GENERAL
  offsetMm: 6,
  lateralMm: -2,
  liftMm: 2,
  // GIRO
  dialDegrees: 0,
  flexionFix: 1,
  // CÁMARA
  fovDiagonal: 73,
  // FILTRO
  smoothing: 1,
  orientationCutoff: 0.55,
  orientationBeta: 1.8,
  // MUÑECA VIRTUAL
  occluderMode: 1,
  occluderWidthMm: 62,
  occluderThicknessMm: 44,
  occluderLengthMm: 150,
  occluderXmm: 0,
  occluderYmm: 0,
  occluderZmm: -20,
  occluderRotX: 0,
  occluderRotY: 0,
  occluderRotZ: 0,
  watchVisible: 1,
  triadMode: 0 // 0 OFF · 1 MUÑECA · 2 RELOJ
};

const GROUPS = [
  {
    id: "pos", label: "POSICIÓN", fields: [
      { key: "offsetMm", label: "Hacia el codo", min: 0, max: 90, step: 1, unit: " mm" },
      { key: "lateralMm", label: "Lateral", min: -30, max: 30, step: 1, unit: " mm" },
      { key: "liftMm", label: "Separar de la piel", min: -5, max: 15, step: 1, unit: " mm" }
    ]
  },
  {
    id: "rot", label: "GIRO", fields: [
      { key: "dialDegrees", label: "Dónde caen las 12", min: -180, max: 180, step: 5, unit: "°" },
      { key: "flexionFix", label: "Corregir falso giro", min: 0, max: 1, step: 1, unit: "", toggle: ["NO", "SÍ"] }
    ]
  },
  {
    id: "wrist", label: "MUÑECA", fields: [
      { key: "occluderWidthMm", label: "Ancho", min: 30, max: 100, step: 1, unit: " mm" },
      { key: "occluderThicknessMm", label: "Grosor", min: 20, max: 80, step: 1, unit: " mm" },
      { key: "occluderLengthMm", label: "Largo", min: 70, max: 240, step: 2, unit: " mm" },
      { key: "occluderXmm", label: "Mover X (+ hacia 3)", min: -200, max: 200, step: 1, unit: " mm" },
      { key: "occluderYmm", label: "Mover Y (+ hacia 12)", min: -200, max: 200, step: 1, unit: " mm" },
      { key: "occluderZmm", label: "Mover Z (+ cristal)", min: -200, max: 200, step: 1, unit: " mm" },
      { key: "occluderRotX", label: "Giro X", min: -90, max: 90, step: 1, unit: "°" },
      { key: "occluderRotY", label: "Giro Y", min: -90, max: 90, step: 1, unit: "°" },
      { key: "occluderRotZ", label: "Giro Z", min: -90, max: 90, step: 1, unit: "°" },
      { key: "occluderMode", label: "Aspecto / función", choices: ["OFF", "TRANSPARENTE", "SÓLIDA", "OCLUSIÓN"] },
      { key: "watchVisible", label: "Reloj", choices: ["OCULTAR RELOJ", "MOSTRAR RELOJ"] },
      { key: "triadMode", label: "Tríada común", choices: ["OFF", "MUÑECA", "RELOJ"] }
    ]
  },
  {
    id: "cam", label: "CÁMARA", fields: [
      { key: "fovDiagonal", label: "FOV diagonal", min: 55, max: 100, step: 1, unit: "°" }
    ]
  },
  {
    id: "filter", label: "FILTRO", fields: [
      { key: "smoothing", label: "Estabilizador", min: 0, max: 1, step: 1, unit: "", toggle: ["CRUDO", "ON"] },
      { key: "orientationCutoff", label: "Quieto = más bajo", min: 0.05, max: 4, step: 0.05, unit: "" },
      { key: "orientationBeta", label: "Rápido = más alto", min: 0.2, max: 8, step: 0.05, unit: "" }
    ]
  }
];

const WRIST_CALIBRATION = [
  {
    id: "position", label: "POSICIÓN", fields: [
      { key: "occluderXmm", label: "X · +→3", min: -200, max: 200, step: 1, unit: " mm" },
      { key: "occluderYmm", label: "Y · +→12", min: -200, max: 200, step: 1, unit: " mm" },
      { key: "occluderZmm", label: "Z · +→CRISTAL", min: -200, max: 200, step: 1, unit: " mm" }
    ]
  },
  {
    id: "size", label: "TAMAÑO", fields: [
      { key: "occluderWidthMm", label: "ANCHO", min: 30, max: 100, step: 1, unit: " mm" },
      { key: "occluderThicknessMm", label: "GROSOR", min: 20, max: 80, step: 1, unit: " mm" },
      { key: "occluderLengthMm", label: "LARGO", min: 70, max: 240, step: 2, unit: " mm" }
    ]
  },
  {
    id: "rotation", label: "GIRO", fields: [
      { key: "occluderRotX", label: "X", min: -90, max: 90, step: 1, unit: "°" },
      { key: "occluderRotY", label: "Y", min: -90, max: 90, step: 1, unit: "°" },
      { key: "occluderRotZ", label: "Z", min: -90, max: 90, step: 1, unit: "°" }
    ]
  }
];

let openGroup = "";
let root = null;
let onChange = null;
let wristView = "calibration";
let calibrationSection = "position";
let calibrationFieldKey = "occluderXmm";
let calibrationActive = false;
let cleanView = false;
let cameraPaused = false;
let freezeCanvas = null;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    Object.keys(tuning).forEach((key) => {
      if (Number.isFinite(saved[key])) tuning[key] = saved[key];
    });
  } catch (error) {
    /* primera vez / modo privado */
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch (error) {
    /* modo privado */
  }
}

function notify(key) {
  save();
  if (onChange) onChange(key);
}

function ensureRuntimeStyles() {
  if (document.getElementById("amuraTunerRuntimeStyles")) return;
  const style = document.createElement("style");
  style.id = "amuraTunerRuntimeStyles";
  style.textContent = `
    body.wrist-tuning-open .topbar,
    body.wrist-tuning-open .tracking-hud,
    body.wrist-tuning-open .axis-legend,
    body.wrist-tuning-open .controls,
    body.wrist-tuning-open .rotation-modes,
    body.wrist-tuning-open .diagnostics {
      display: none !important;
    }
    body.wrist-calibration-open .tracking-canvas {
      opacity: 0 !important;
    }
    body.wrist-calibration-open #tunerRoot {
      bottom: calc(env(safe-area-inset-bottom) + 12px) !important;
      gap: 0 !important;
    }
    body.wrist-clean-view #tunerRoot {
      display: none !important;
    }
    .wrist-freeze-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
      z-index: -2;
    }
    body[data-facing="user"] .wrist-freeze-canvas {
      transform: scaleX(-1);
    }
    .tuner-choice-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .tuner-choice {
      min-height: 40px;
      padding: 8px 6px;
      border: 1px solid #3d3160;
      border-radius: 4px;
      background: rgba(13,10,22,.92);
      color: #9b8bc4;
      font: 700 10px/1 ui-monospace, Menlo, monospace;
      letter-spacing: .8px;
    }
    .tuner-choice.on {
      border-color: #a992ff;
      background: #2a2145;
      color: #fff;
      box-shadow: inset 0 -3px 0 #a992ff;
    }
    .wrist-calibration-panel {
      width: min(96vw, 560px);
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border: 1px solid rgba(106,85,176,.72);
      border-radius: 6px;
      background: rgba(13,10,22,.74);
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
    }
    .wrist-calibration-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #e3dcff;
      font: 700 11px/1 ui-monospace, Menlo, monospace;
      letter-spacing: 1px;
    }
    .wrist-calibration-title b {
      color: #a992ff;
      font-size: 11px;
      text-align: right;
    }
    .wrist-axis-rule {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      font: 800 10px/1.1 ui-monospace, Menlo, monospace;
      text-align: center;
      text-shadow: 0 1px 3px #000;
    }
    .wrist-axis-rule .x { color: #ff5c6c; }
    .wrist-axis-rule .y { color: #6ad46a; }
    .wrist-axis-rule .z { color: #5aa9ff; }
    .wrist-calibration-tools {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 5px;
    }
    .wrist-calibration-tabs,
    .wrist-calibration-fields,
    .wrist-calibration-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 5px;
    }
    .wrist-calibration-tools button,
    .wrist-calibration-tabs button,
    .wrist-calibration-fields button,
    .wrist-calibration-actions button,
    .wrist-advanced-button {
      min-height: 37px;
      padding: 7px 4px;
      border: 1px solid #3d3160;
      border-radius: 4px;
      background: rgba(13,10,22,.92);
      color: #9b8bc4;
      font: 700 9px/1.05 ui-monospace, Menlo, monospace;
      letter-spacing: .55px;
    }
    .wrist-calibration-tools button.on,
    .wrist-calibration-tabs button.on,
    .wrist-calibration-fields button.on {
      border-color: #a992ff;
      background: #2a2145;
      color: #fff;
    }
    .wrist-calibration-tools .pause.on {
      border-color: #d4b76a;
      color: #fff4bf;
      background: rgba(90,69,20,.9);
    }
    .wrist-calibration-actions .done {
      border-color: #a992ff;
      color: #fff;
      background: #2a2145;
    }
    .wrist-calibration-slider {
      padding-top: 1px;
    }
    .wrist-calibration-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      color: #e3dcff;
      font: 700 12px/1 ui-monospace, Menlo, monospace;
      text-shadow: 0 1px 3px #000, 0 0 8px #000;
    }
    .wrist-calibration-head b {
      color: #fff;
      font-size: 18px;
    }
    .wrist-calibration-slider input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 42px;
      margin: 0;
      background: transparent;
    }
    .wrist-calibration-slider input[type=range]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 4px;
      background: rgba(160,140,230,.72);
      box-shadow: 0 0 0 1px rgba(0,0,0,.7);
    }
    .wrist-calibration-slider input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 36px;
      height: 36px;
      margin-top: -15px;
      border: 3px solid #0d0a16;
      border-radius: 50%;
      background: #a992ff;
    }
    .wrist-advanced-wrap {
      width: min(94vw, 460px);
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .wrist-advanced-button {
      width: 100%;
      color: #cbb6ff;
      border-color: #6a55b0;
    }
  `;
  document.head.appendChild(style);
}

function displayValue(field) {
  const value = tuning[field.key];
  if (field.choices) {
    return field.choices[
      Math.max(0, Math.min(field.choices.length - 1, Math.round(value)))
    ] || "";
  }
  if (field.toggle) return field.toggle[value ? 1 : 0];
  const decimals = field.step < 1 ? 2 : 0;
  return Number(value).toFixed(decimals) + field.unit;
}

function renderGroup(group) {
  const panel = document.createElement("div");
  panel.className = "tuner-panel";

  group.fields.forEach((field) => {
    const row = document.createElement("div");
    row.className = "tuner-row";

    const head = document.createElement("div");
    head.className = "tuner-head";
    const name = document.createElement("span");
    name.textContent = field.label;
    const value = document.createElement("b");
    value.textContent = displayValue(field);
    head.append(name, value);

    if (field.choices) {
      const choiceRow = document.createElement("div");
      choiceRow.className = "tuner-choice-row";
      const buttons = [];

      field.choices.forEach((label, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className =
          "tuner-choice" +
          (Math.round(tuning[field.key]) === index ? " on" : "");
        button.textContent = label;
        button.addEventListener("click", () => {
          tuning[field.key] = index;
          value.textContent = displayValue(field);
          buttons.forEach((item, itemIndex) => {
            item.classList.toggle("on", itemIndex === index);
          });
          notify(field.key);
        });
        buttons.push(button);
        choiceRow.appendChild(button);
      });

      row.append(head, choiceRow);
    } else {
      const input = document.createElement("input");
      input.type = "range";
      input.min = field.min;
      input.max = field.max;
      input.step = field.step;
      input.value = tuning[field.key];
      input.addEventListener("input", () => {
        tuning[field.key] = Number(input.value);
        value.textContent = displayValue(field);
        notify(field.key);
      });
      row.append(head, input);
    }

    panel.appendChild(row);
  });

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "tuner-reset";
  copy.textContent = "COPIAR VALORES";
  copy.addEventListener("click", () => {
    const text = JSON.stringify(tuning, null, 1);
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    copy.textContent = "COPIADO";
    setTimeout(() => { copy.textContent = "COPIAR VALORES"; }, 1400);
  });
  panel.appendChild(copy);

  return panel;
}

function currentCalibrationSection() {
  return WRIST_CALIBRATION.find(
    (section) => section.id === calibrationSection
  ) || WRIST_CALIBRATION[0];
}

function currentCalibrationField() {
  const section = currentCalibrationSection();
  return section.fields.find(
    (field) => field.key === calibrationFieldKey
  ) || section.fields[0];
}

function removeFreezeCanvas() {
  if (freezeCanvas && freezeCanvas.parentNode) {
    freezeCanvas.parentNode.removeChild(freezeCanvas);
  }
  freezeCanvas = null;
}

function setCalibrationPaused(paused) {
  const next = Boolean(paused);
  if (next === cameraPaused) return;

  if (next) {
    const video = document.getElementById("cameraVideo");
    const lab = document.querySelector(".camera-lab");
    if (!video || !lab || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return;
    }

    removeFreezeCanvas();
    freezeCanvas = document.createElement("canvas");
    freezeCanvas.className = "wrist-freeze-canvas";
    freezeCanvas.width = video.videoWidth;
    freezeCanvas.height = video.videoHeight;
    const ctx = freezeCanvas.getContext("2d");
    if (ctx) ctx.drawImage(video, 0, 0, freezeCanvas.width, freezeCanvas.height);
    lab.appendChild(freezeCanvas);
    cameraPaused = true;
    window.AmuraWristCalibrationPaused = true;
  } else {
    cameraPaused = false;
    window.AmuraWristCalibrationPaused = false;
    removeFreezeCanvas();
  }
}

function enterWristCalibration() {
  calibrationActive = true;
  cleanView = false;
  wristView = "calibration";
  setCalibrationPaused(false);
  tuning.watchVisible = 0;
  tuning.occluderMode = 2;
  tuning.triadMode = 1;
  notify("watchVisible");
  notify("occluderMode");
  notify("triadMode");
}

function finishWristCalibration() {
  calibrationActive = false;
  cleanView = false;
  setCalibrationPaused(false);
  tuning.watchVisible = 1;
  tuning.occluderMode = 3;
  tuning.triadMode = 0;
  notify("watchVisible");
  notify("occluderMode");
  notify("triadMode");
  document.body.classList.remove("wrist-clean-view");
}

function restoreCleanView() {
  if (!cleanView) return;
  cleanView = false;
  document.body.classList.remove("wrist-clean-view");
  render();
}

function showCleanView(event) {
  if (event) event.stopPropagation();
  cleanView = true;
  document.body.classList.add("wrist-clean-view");
  root.innerHTML = "";
  setTimeout(() => {
    document.addEventListener("pointerdown", restoreCleanView, { once: true });
  }, 80);
}

function triadButtonLabel() {
  const mode = Math.max(0, Math.min(2, Math.round(Number(tuning.triadMode) || 0)));
  if (mode === 1) return "TRÍADA · MUÑECA";
  if (mode === 2) return "TRÍADA · RELOJ";
  return "TRÍADA · OFF";
}

function renderWristCalibration() {
  const panel = document.createElement("div");
  panel.className = "wrist-calibration-panel";

  const title = document.createElement("div");
  title.className = "wrist-calibration-title";
  const left = document.createElement("span");
  left.textContent = "MUÑECA · AJUSTE";
  const state = document.createElement("b");
  state.textContent =
    (cameraPaused ? "PAUSA" : "LIVE") +
    " · " +
    (Number(tuning.watchVisible) ? "RELOJ VISIBLE" : "RELOJ OCULTO");
  title.append(left, state);
  panel.appendChild(title);

  const axisRule = document.createElement("div");
  axisRule.className = "wrist-axis-rule";
  axisRule.innerHTML =
    '<span class="x">+X · 9→3</span>' +
    '<span class="y">+Y · 6→12</span>' +
    '<span class="z">+Z · ESFERA→CRISTAL</span>';
  panel.appendChild(axisRule);

  const tools = document.createElement("div");
  tools.className = "wrist-calibration-tools";

  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "pause" + (cameraPaused ? " on" : "");
  pause.textContent = cameraPaused ? "▶ REANUDAR" : "⏸ PAUSAR";
  pause.addEventListener("click", () => {
    setCalibrationPaused(!cameraPaused);
    render();
  });

  const watch = document.createElement("button");
  watch.type = "button";
  watch.className = Number(tuning.watchVisible) ? "on" : "";
  watch.textContent = Number(tuning.watchVisible)
    ? "RELOJ · VISIBLE"
    : "RELOJ · OCULTO";
  watch.addEventListener("click", () => {
    tuning.watchVisible = Number(tuning.watchVisible) ? 0 : 1;
    notify("watchVisible");
    render();
  });

  const triad = document.createElement("button");
  triad.type = "button";
  triad.className = Number(tuning.triadMode) ? "on" : "";
  triad.textContent = triadButtonLabel();
  triad.addEventListener("click", () => {
    tuning.triadMode = (Math.round(Number(tuning.triadMode) || 0) + 1) % 3;
    notify("triadMode");
    render();
  });

  tools.append(pause, watch, triad);
  panel.appendChild(tools);

  const sectionTabs = document.createElement("div");
  sectionTabs.className = "wrist-calibration-tabs";
  WRIST_CALIBRATION.forEach((section) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = section.label;
    button.className = section.id === calibrationSection ? "on" : "";
    button.addEventListener("click", () => {
      calibrationSection = section.id;
      calibrationFieldKey = section.fields[0].key;
      render();
    });
    sectionTabs.appendChild(button);
  });
  panel.appendChild(sectionTabs);

  const section = currentCalibrationSection();
  const fieldTabs = document.createElement("div");
  fieldTabs.className = "wrist-calibration-fields";
  section.fields.forEach((field) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = field.label;
    button.className = field.key === calibrationFieldKey ? "on" : "";
    button.addEventListener("click", () => {
      calibrationFieldKey = field.key;
      render();
    });
    fieldTabs.appendChild(button);
  });
  panel.appendChild(fieldTabs);

  const field = currentCalibrationField();
  const sliderWrap = document.createElement("div");
  sliderWrap.className = "wrist-calibration-slider";

  const head = document.createElement("div");
  head.className = "wrist-calibration-head";
  const name = document.createElement("span");
  name.textContent = `${section.label} · ${field.label}`;
  const value = document.createElement("b");
  value.textContent = displayValue(field);
  head.append(name, value);

  const input = document.createElement("input");
  input.type = "range";
  input.min = field.min;
  input.max = field.max;
  input.step = field.step;
  input.value = tuning[field.key];
  input.addEventListener("input", () => {
    tuning[field.key] = Number(input.value);
    value.textContent = displayValue(field);
    notify(field.key);
  });

  sliderWrap.append(head, input);
  panel.appendChild(sliderWrap);

  const actions = document.createElement("div");
  actions.className = "wrist-calibration-actions";

  const clean = document.createElement("button");
  clean.type = "button";
  clean.textContent = "VER LIMPIO";
  clean.addEventListener("click", showCleanView);

  const advanced = document.createElement("button");
  advanced.type = "button";
  advanced.textContent = "AVANZADO";
  advanced.addEventListener("click", () => {
    wristView = "advanced";
    document.body.classList.remove("wrist-clean-view");
    render();
  });

  const done = document.createElement("button");
  done.type = "button";
  done.className = "done";
  done.textContent = "LISTO";
  done.addEventListener("click", () => {
    finishWristCalibration();
    openGroup = "menu";
    wristView = "calibration";
    render();
  });

  actions.append(clean, advanced, done);
  panel.appendChild(actions);

  return panel;
}

function renderAdvancedWrist(group) {
  const wrap = document.createElement("div");
  wrap.className = "wrist-advanced-wrap";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "wrist-advanced-button";
  back.textContent = "VOLVER A MODO AJUSTE";
  back.addEventListener("click", () => {
    wristView = "calibration";
    tuning.occluderMode = 2;
    notify("occluderMode");
    render();
  });

  wrap.append(back, renderGroup(group));
  return wrap;
}

function render() {
  root.innerHTML = "";
  const wristOpen = openGroup === "wrist";
  const calibrationOpen = wristOpen && wristView === "calibration";

  document.body.classList.toggle("wrist-tuning-open", wristOpen);
  document.body.classList.toggle("wrist-calibration-open", calibrationOpen);
  document.body.classList.toggle(
    "wrist-clean-view",
    calibrationOpen && cleanView
  );

  if (calibrationOpen) {
    root.appendChild(renderWristCalibration());
    return;
  }

  if (!openGroup) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "tuner-toggle";
    open.textContent = "AJUSTES";
    open.addEventListener("click", () => {
      openGroup = "menu";
      render();
    });
    root.appendChild(open);
    return;
  }

  const bar = document.createElement("div");
  bar.className = "tuner-bar";

  GROUPS.forEach((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "tuner-tab" + (openGroup === group.id ? " on" : "");
    button.textContent = group.label;
    button.addEventListener("click", () => {
      if (group.id === "wrist" && openGroup !== "wrist") {
        openGroup = "wrist";
        enterWristCalibration();
      } else if (openGroup === "wrist") {
        finishWristCalibration();
        openGroup = group.id === "wrist" ? "menu" : group.id;
      } else {
        openGroup = openGroup === group.id ? "menu" : group.id;
      }
      render();
    });
    bar.appendChild(button);
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "tuner-tab close";
  close.textContent = "×";
  close.addEventListener("click", () => {
    if (openGroup === "wrist" && calibrationActive) {
      finishWristCalibration();
    }
    openGroup = "";
    render();
  });
  bar.appendChild(close);

  const active = GROUPS.find((group) => group.id === openGroup);
  if (active) {
    if (active.id === "wrist" && wristView === "advanced") {
      root.appendChild(renderAdvancedWrist(active));
    } else {
      root.appendChild(renderGroup(active));
    }
  }
  root.appendChild(bar);
}

export function initTuner(changeHandler) {
  onChange = changeHandler;
  load();
  window.AmuraWristCalibrationPaused = false;
  ensureRuntimeStyles();
  root = document.createElement("div");
  root.id = "tunerRoot";
  document.body.appendChild(root);
  render();
  return tuning;
}
