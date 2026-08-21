const EPSILON = 1e-8;

function vectorFrom(point) {
  return {
    x: Number(point && point.x) || 0,
    y: Number(point && point.y) || 0,
    z: Number(point && point.z) || 0
  };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(vector, scalar) {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function magnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector) {
  const length = magnitude(vector);
  if (length < EPSILON) return null;
  return scale(vector, 1 / length);
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5
  };
}

function validPoints(points) {
  return Array.isArray(points) && points.length >= 18 && points.every((point) => (
    point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  ));
}

/**
 * Marco AMURA V11.3 · tres puntos solamente.
 *
 * P0 + P5 + P17 definen el plano de la mano.
 *   +X = dirección longitudinal muñeca → mano (9→3 en el rig AMURA)
 *   +Y = transversal de la muñeca (6→12)
 *   +Z = normal al plano, fondo → cristal
 *
 * La orientación no usa el promedio de los cuatro nudillos ni una pose métrica
 * reconstruida. La posición visual sigue perteneciendo a P0.
 */
export function buildWristFrame(points, physicalHand) {
  if (!validPoints(points) || (physicalHand !== "left" && physicalHand !== "right")) {
    return null;
  }

  const origin = vectorFrom(points[0]);
  const indexMcp = vectorFrom(points[5]);
  const pinkyMcp = vectorFrom(points[17]);
  const knuckleMid = midpoint(indexMcp, pinkyMcp);

  let xAxis = normalize(subtract(knuckleMid, origin));
  if (!xAxis) return null;

  const transverseGuide = physicalHand === "right"
    ? subtract(pinkyMcp, indexMcp)
    : subtract(indexMcp, pinkyMcp);

  const yWithoutX = subtract(
    transverseGuide,
    scale(xAxis, dot(transverseGuide, xAxis))
  );
  let yAxis = normalize(yWithoutX);
  if (!yAxis) return null;

  let zAxis = normalize(cross(xAxis, yAxis));
  if (!zAxis) return null;

  yAxis = normalize(cross(zAxis, xAxis));
  if (!yAxis) return null;
  zAxis = normalize(cross(xAxis, yAxis));
  if (!zAxis) return null;

  return { origin, xAxis, yAxis, zAxis };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function degrees(radians) {
  return radians * 180 / Math.PI;
}

export function imageSpaceLandmarks(points, width, height) {
  const imageWidth = Math.max(1, Number(width) || 1);
  const imageHeight = Math.max(1, Number(height) || 1);

  if (!Array.isArray(points)) return [];

  return points.map((point) => ({
    x: (Number(point && point.x) || 0) * imageWidth,
    y: (Number(point && point.y) || 0) * imageHeight,
    z: (Number(point && point.z) || 0) * imageWidth
  }));
}

export function createHybridWristState() {
  return {
    hand: "",
    referenceRatio: 0,
    angle: null,
    longitudinalReference: 0
  };
}

export function resetHybridWristState(state) {
  if (!state) return;
  state.hand = "";
  state.referenceRatio = 0;
  state.angle = null;
  state.longitudinalReference = 0;
}

/**
 * En la prueba P0-directa el híbrido deja de inventar un marco alternativo.
 * Conservamos la API para no tocar engine4-hand-tracking.js, pero la orientación base
 * siempre sale del mismo triángulo P0/P5/P17.
 */
export function buildHybridWristFrame(
  imagePoints,
  worldPoints,
  physicalHand,
  state,
  correctFlexion
) {
  void correctFlexion;
  if (!state) return null;
  if (state.hand !== physicalHand) {
    resetHybridWristState(state);
    state.hand = physicalHand;
  }

  const frame = buildWristFrame(imagePoints, physicalHand)
    || buildWristFrame(worldPoints, physicalHand);
  if (!frame) return null;

  const metrics = wristFrameMetrics(frame);
  state.angle = metrics ? metrics.rollY * Math.PI / 180 : 0;

  const p5 = imagePoints && imagePoints[5];
  const p17 = imagePoints && imagePoints[17];
  const p0 = imagePoints && imagePoints[0];
  const mid = p5 && p17 ? midpoint(vectorFrom(p5), vectorFrom(p17)) : null;
  const transverse = p5 && p17 ? magnitude(subtract(vectorFrom(p5), vectorFrom(p17))) : 0;
  const longitudinal = mid && p0 ? magnitude(subtract(mid, vectorFrom(p0))) : 0;
  const ratio = longitudinal > EPSILON ? transverse / longitudinal : 0;
  if (ratio > state.referenceRatio) state.referenceRatio = ratio;

  return {
    frame,
    rollDegrees: metrics ? metrics.rollY : 0,
    referenceRatio: state.referenceRatio || ratio,
    observedRatio: ratio,
    longitudinalReference: longitudinal,
    depthSignalDegrees: metrics ? metrics.rollY : 0
  };
}

export function wristFrameMetrics(frame) {
  if (!frame) return null;

  const rotation = degrees(Math.atan2(frame.xAxis.y, frame.xAxis.x));
  const tilt = degrees(Math.acos(clamp(Math.abs(frame.zAxis.z), 0, 1)));
  const rollY = degrees(Math.atan2(frame.yAxis.z, -frame.zAxis.z));

  return {
    rotation,
    tilt,
    rollY,
    zDirection: frame.zAxis.z < 0 ? "hacia cámara" : "opuesta a cámara"
  };
}

export function formatFrameVector(vector) {
  if (!vector) return "—";
  return [vector.x, vector.y, vector.z].map((value) => value.toFixed(3)).join(", ");
}
