const EPSILON = 1e-8;
const TWO_PI = Math.PI * 2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function copyVector(vector) {
  return {
    x: Number(vector && vector.x) || 0,
    y: Number(vector && vector.y) || 0,
    z: Number(vector && vector.z) || 0
  };
}

function negateVector(vector) {
  return { x: -vector.x, y: -vector.y, z: -vector.z };
}

function lerpVector(from, to, alpha) {
  return {
    x: from.x + (to.x - from.x) * alpha,
    y: from.y + (to.y - from.y) * alpha,
    z: from.z + (to.z - from.z) * alpha
  };
}

function smoothingAlpha(cutoff, deltaSeconds) {
  return 1 - Math.exp(-TWO_PI * cutoff * deltaSeconds);
}

function adaptiveCutoff(minimum, beta, speed, deadband) {
  return minimum + beta * Math.max(0, speed - deadband);
}

function normalizeQuaternion(quaternion) {
  const length = Math.hypot(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w
  );
  if (length < EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length
  };
}

function quaternionDot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function quaternionAngleDegrees(a, b) {
  const cosine = clamp(Math.abs(quaternionDot(a, b)), -1, 1);
  return 2 * Math.acos(cosine) * 180 / Math.PI;
}

function flipFrameAroundAxis(frame, axis) {
  const result = {
    origin: copyVector(frame.origin),
    xAxis: copyVector(frame.xAxis),
    yAxis: copyVector(frame.yAxis),
    zAxis: copyVector(frame.zAxis)
  };

  if (axis === "X") {
    result.yAxis = negateVector(result.yAxis);
    result.zAxis = negateVector(result.zAxis);
  } else if (axis === "Y") {
    result.xAxis = negateVector(result.xAxis);
    result.zAxis = negateVector(result.zAxis);
  } else if (axis === "Z") {
    result.xAxis = negateVector(result.xAxis);
    result.yAxis = negateVector(result.yAxis);
  }
  return result;
}

function multiplyQuaternions(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function angularVelocity(previous, current, deltaSeconds) {
  const inversePrevious = {
    x: -previous.x,
    y: -previous.y,
    z: -previous.z,
    w: previous.w
  };
  let delta = normalizeQuaternion(multiplyQuaternions(current, inversePrevious));
  if (delta.w < 0) {
    delta = { x: -delta.x, y: -delta.y, z: -delta.z, w: -delta.w };
  }

  const sineHalfAngle = Math.hypot(delta.x, delta.y, delta.z);
  if (sineHalfAngle < EPSILON) return { x: 0, y: 0, z: 0 };
  const angle = 2 * Math.atan2(sineHalfAngle, clamp(delta.w, -1, 1));
  const factor = angle / sineHalfAngle / deltaSeconds;
  return {
    x: delta.x * factor,
    y: delta.y * factor,
    z: delta.z * factor
  };
}

function quaternionFromFrame(frame) {
  const m00 = frame.xAxis.x;
  const m01 = frame.yAxis.x;
  const m02 = frame.zAxis.x;
  const m10 = frame.xAxis.y;
  const m11 = frame.yAxis.y;
  const m12 = frame.zAxis.y;
  const m20 = frame.xAxis.z;
  const m21 = frame.yAxis.z;
  const m22 = frame.zAxis.z;
  const trace = m00 + m11 + m22;
  let quaternion;

  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    quaternion = {
      w: 0.25 * scale,
      x: (m21 - m12) / scale,
      y: (m02 - m20) / scale,
      z: (m10 - m01) / scale
    };
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    quaternion = {
      w: (m21 - m12) / scale,
      x: 0.25 * scale,
      y: (m01 + m10) / scale,
      z: (m02 + m20) / scale
    };
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    quaternion = {
      w: (m02 - m20) / scale,
      x: (m01 + m10) / scale,
      y: 0.25 * scale,
      z: (m12 + m21) / scale
    };
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    quaternion = {
      w: (m10 - m01) / scale,
      x: (m02 + m20) / scale,
      y: (m12 + m21) / scale,
      z: 0.25 * scale
    };
  }
  return normalizeQuaternion(quaternion);
}

function frameAxesFromQuaternion(quaternion) {
  const q = normalizeQuaternion(quaternion);
  const xx = q.x * q.x;
  const yy = q.y * q.y;
  const zz = q.z * q.z;
  const xy = q.x * q.y;
  const xz = q.x * q.z;
  const yz = q.y * q.z;
  const wx = q.w * q.x;
  const wy = q.w * q.y;
  const wz = q.w * q.z;

  return {
    xAxis: {
      x: 1 - 2 * (yy + zz),
      y: 2 * (xy + wz),
      z: 2 * (xz - wy)
    },
    yAxis: {
      x: 2 * (xy - wz),
      y: 1 - 2 * (xx + zz),
      z: 2 * (yz + wx)
    },
    zAxis: {
      x: 2 * (xz + wy),
      y: 2 * (yz - wx),
      z: 1 - 2 * (xx + yy)
    }
  };
}

function slerpQuaternion(from, to, alpha) {
  let target = to;
  let cosine = quaternionDot(from, target);
  if (cosine < 0) {
    cosine = -cosine;
    target = { x: -target.x, y: -target.y, z: -target.z, w: -target.w };
  }

  if (cosine > 0.9995) {
    return normalizeQuaternion({
      x: from.x + (target.x - from.x) * alpha,
      y: from.y + (target.y - from.y) * alpha,
      z: from.z + (target.z - from.z) * alpha,
      w: from.w + (target.w - from.w) * alpha
    });
  }

  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  const fromWeight = Math.sin((1 - alpha) * angle) / sine;
  const toWeight = Math.sin(alpha * angle) / sine;
  return normalizeQuaternion({
    x: from.x * fromWeight + target.x * toWeight,
    y: from.y * fromWeight + target.y * toWeight,
    z: from.z * fromWeight + target.z * toWeight,
    w: from.w * fromWeight + target.w * toWeight
  });
}

export class WristFrameStabilizer {
  constructor(options = {}) {
    this.options = {
      orientationMinCutoff: options.orientationMinCutoff || 0.8,
      orientationBeta: options.orientationBeta || 1.15,
      orientationDeadband: options.orientationDeadband || 0.1,
      positionMinCutoff: options.positionMinCutoff || 0.95,
      positionBeta: options.positionBeta || 12,
      positionDeadband: options.positionDeadband || 0.012,
      scaleMinCutoff: options.scaleMinCutoff || 0.8,
      scaleBeta: options.scaleBeta || 2,
      scaleDeadband: options.scaleDeadband || 0.02,
      motionCutoff: options.motionCutoff || 1.5,
      gapResetMs: options.gapResetMs || 500,
      jumpRejectDegrees: options.jumpRejectDegrees || 100,
      jumpConfirmFrames: options.jumpConfirmFrames || 3,
      jumpConfirmToleranceDegrees: options.jumpConfirmToleranceDegrees || 30,
      relocalizeDegrees: options.relocalizeDegrees || 110,
      relocalizeConfirmFrames: options.relocalizeConfirmFrames || 6,
      relocalizeToleranceDegrees: options.relocalizeToleranceDegrees || 24,
      relocalizeLockFrames: options.relocalizeLockFrames || 10
    };
    this.reset();
  }

  reset() {
    this.lastTimestamp = null;
    this.rawQuaternion = null;
    this.filteredQuaternion = null;
    this.rawScreenOrigin = null;
    this.filteredScreenOrigin = null;
    this.filteredFrameOrigin = null;
    this.rawScale = null;
    this.filteredScale = null;
    this.angularVelocity = { x: 0, y: 0, z: 0 };
    this.positionVelocity = { x: 0, y: 0, z: 0 };
    this.scaleVelocity = 0;
    this.angularSpeed = 0;
    this.axisFlipCorrected = false;
    this.axisFlipAxis = "";
    this.jumpRejected = false;
    this.pendingJumpQuaternion = null;
    this.pendingJumpFrames = 0;
    this.relocalizeCandidateQuaternion = null;
    this.relocalizePendingFrames = 0;
    this.relocalizeLockFramesRemaining = 0;
    this.relocalized = false;
  }

  update(frame, screenOrigin, overlayScale, timestampMilliseconds) {
    if (!frame || !screenOrigin || !Number.isFinite(overlayScale)) return null;

    const timestamp = Number.isFinite(timestampMilliseconds)
      ? timestampMilliseconds
      : performance.now();

    if (this.lastTimestamp !== null && timestamp - this.lastTimestamp > this.options.gapResetMs) {
      this.reset();
    }

    const directQuaternion = quaternionFromFrame(frame);
    let currentQuaternion = directQuaternion;
    const currentScreenOrigin = copyVector(screenOrigin);
    const currentFrameOrigin = copyVector(frame.origin);

    this.axisFlipCorrected = false;
    this.axisFlipAxis = "";
    this.jumpRejected = false;
    this.relocalized = false;

    if (this.filteredQuaternion) {
      // Durante unos frames después de reenganchar confiamos en la referencia
      // absoluta cruda para que la continuidad no vuelva a arrastrarnos a la rama mala.
      if (this.relocalizeLockFramesRemaining > 0) {
        currentQuaternion = directQuaternion;
        this.relocalizeLockFramesRemaining -= 1;
        this.pendingJumpQuaternion = null;
        this.pendingJumpFrames = 0;
        this.relocalizeCandidateQuaternion = null;
        this.relocalizePendingFrames = 0;
      } else {
        // Watchdog absoluto: si MediaPipe insiste de forma coherente en una orientación
        // muy distinta de la que el filtro está manteniendo, acumulamos evidencia.
        const absoluteDisagreement = quaternionAngleDegrees(
          this.filteredQuaternion,
          directQuaternion
        );

        if (absoluteDisagreement > this.options.relocalizeDegrees) {
          const coherentAbsolute = this.relocalizeCandidateQuaternion &&
            quaternionAngleDegrees(
              this.relocalizeCandidateQuaternion,
              directQuaternion
            ) <= this.options.relocalizeToleranceDegrees;

          if (coherentAbsolute) {
            this.relocalizePendingFrames += 1;
            this.relocalizeCandidateQuaternion = slerpQuaternion(
              this.relocalizeCandidateQuaternion,
              directQuaternion,
              0.35
            );
          } else {
            this.relocalizeCandidateQuaternion = directQuaternion;
            this.relocalizePendingFrames = 1;
          }
        } else {
          this.relocalizeCandidateQuaternion = null;
          this.relocalizePendingFrames = 0;
        }

        if (this.relocalizePendingFrames >= this.options.relocalizeConfirmFrames) {
          // Reenganche duro: reseteamos sólo la parte angular, sin perder posición,
          // escala ni detección de mano. Así el reloj recupera su rama correcta solo.
          currentQuaternion = directQuaternion;
          this.filteredQuaternion = directQuaternion;
          this.rawQuaternion = directQuaternion;
          this.angularVelocity = { x: 0, y: 0, z: 0 };
          this.angularSpeed = 0;
          this.pendingJumpQuaternion = null;
          this.pendingJumpFrames = 0;
          this.relocalizeCandidateQuaternion = null;
          this.relocalizePendingFrames = 0;
          this.relocalizeLockFramesRemaining = this.options.relocalizeLockFrames;
          this.relocalized = true;
        } else {
          // Protección normal contra las tres ambigüedades exactas de 180°.
          const candidates = [
            { axis: "", quaternion: directQuaternion },
            { axis: "X", quaternion: quaternionFromFrame(flipFrameAroundAxis(frame, "X")) },
            { axis: "Y", quaternion: quaternionFromFrame(flipFrameAroundAxis(frame, "Y")) },
            { axis: "Z", quaternion: quaternionFromFrame(flipFrameAroundAxis(frame, "Z")) }
          ];

          let best = candidates[0];
          let bestContinuity = Math.abs(quaternionDot(this.filteredQuaternion, best.quaternion));
          for (let index = 1; index < candidates.length; index += 1) {
            const continuity = Math.abs(quaternionDot(
              this.filteredQuaternion,
              candidates[index].quaternion
            ));
            if (continuity > bestContinuity) {
              best = candidates[index];
              bestContinuity = continuity;
            }
          }

          currentQuaternion = best.quaternion;
          if (best.axis) {
            this.axisFlipCorrected = true;
            this.axisFlipAxis = best.axis;
          }

          const jumpDegrees = quaternionAngleDegrees(
            this.filteredQuaternion,
            currentQuaternion
          );
          if (jumpDegrees > this.options.jumpRejectDegrees) {
            const samePendingJump = this.pendingJumpQuaternion &&
              quaternionAngleDegrees(
                this.pendingJumpQuaternion,
                currentQuaternion
              ) <= this.options.jumpConfirmToleranceDegrees;

            if (samePendingJump) {
              this.pendingJumpFrames += 1;
            } else {
              this.pendingJumpQuaternion = currentQuaternion;
              this.pendingJumpFrames = 1;
            }

            if (this.pendingJumpFrames < this.options.jumpConfirmFrames) {
              currentQuaternion = this.filteredQuaternion;
              this.jumpRejected = true;
            } else {
              this.pendingJumpQuaternion = null;
              this.pendingJumpFrames = 0;
            }
          } else {
            this.pendingJumpQuaternion = null;
            this.pendingJumpFrames = 0;
          }
        }
      }
    }

    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestamp;
      this.rawQuaternion = currentQuaternion;
      this.filteredQuaternion = currentQuaternion;
      this.rawScreenOrigin = currentScreenOrigin;
      this.filteredScreenOrigin = currentScreenOrigin;
      this.filteredFrameOrigin = currentFrameOrigin;
      this.rawScale = overlayScale;
      this.filteredScale = overlayScale;
      return this.result(1, 1, 1);
    }

    const deltaSeconds = clamp((timestamp - this.lastTimestamp) / 1000, 1 / 120, 0.1);
    const motionAlpha = smoothingAlpha(this.options.motionCutoff, deltaSeconds);
    const rawAngularVelocity = angularVelocity(
      this.rawQuaternion,
      currentQuaternion,
      deltaSeconds
    );
    const rawPositionVelocity = {
      x: (currentScreenOrigin.x - this.rawScreenOrigin.x) / deltaSeconds,
      y: (currentScreenOrigin.y - this.rawScreenOrigin.y) / deltaSeconds,
      z: (currentScreenOrigin.z - this.rawScreenOrigin.z) / deltaSeconds
    };
    const scaleBase = Math.max(Math.abs(this.rawScale), EPSILON);
    const rawScaleVelocity = (overlayScale - this.rawScale) / scaleBase / deltaSeconds;

    this.angularVelocity = lerpVector(
      this.angularVelocity,
      rawAngularVelocity,
      motionAlpha
    );
    this.positionVelocity = lerpVector(
      this.positionVelocity,
      rawPositionVelocity,
      motionAlpha
    );
    this.scaleVelocity += (rawScaleVelocity - this.scaleVelocity) * motionAlpha;
    this.angularSpeed = Math.hypot(
      this.angularVelocity.x,
      this.angularVelocity.y,
      this.angularVelocity.z
    );

    const positionSpeed = Math.hypot(
      this.positionVelocity.x,
      this.positionVelocity.y,
      this.positionVelocity.z
    );
    const scaleSpeed = Math.abs(this.scaleVelocity);

    const orientationCutoff = adaptiveCutoff(
      this.options.orientationMinCutoff,
      this.options.orientationBeta,
      this.angularSpeed,
      this.options.orientationDeadband
    );
    const positionCutoff = adaptiveCutoff(
      this.options.positionMinCutoff,
      this.options.positionBeta,
      positionSpeed,
      this.options.positionDeadband
    );
    const scaleCutoff = adaptiveCutoff(
      this.options.scaleMinCutoff,
      this.options.scaleBeta,
      scaleSpeed,
      this.options.scaleDeadband
    );

    const orientationAlpha = smoothingAlpha(orientationCutoff, deltaSeconds);
    const positionAlpha = smoothingAlpha(positionCutoff, deltaSeconds);
    const scaleAlpha = smoothingAlpha(scaleCutoff, deltaSeconds);

    this.filteredQuaternion = slerpQuaternion(
      this.filteredQuaternion,
      currentQuaternion,
      orientationAlpha
    );
    this.filteredScreenOrigin = lerpVector(
      this.filteredScreenOrigin,
      currentScreenOrigin,
      positionAlpha
    );
    this.filteredFrameOrigin = lerpVector(
      this.filteredFrameOrigin,
      currentFrameOrigin,
      positionAlpha
    );
    this.filteredScale += (overlayScale - this.filteredScale) * scaleAlpha;

    this.rawQuaternion = currentQuaternion;
    this.rawScreenOrigin = currentScreenOrigin;
    this.rawScale = overlayScale;
    this.lastTimestamp = timestamp;

    return this.result(orientationAlpha, positionAlpha, scaleAlpha);
  }

  result(orientationAlpha, positionAlpha, scaleAlpha) {
    const axes = frameAxesFromQuaternion(this.filteredQuaternion);
    return {
      frame: {
        origin: copyVector(this.filteredFrameOrigin),
        xAxis: axes.xAxis,
        yAxis: axes.yAxis,
        zAxis: axes.zAxis
      },
      screenOrigin: copyVector(this.filteredScreenOrigin),
      overlayScale: this.filteredScale,
      diagnostics: {
        orientationAlpha,
        positionAlpha,
        scaleAlpha,
        angularSpeedDegrees: this.angularSpeed * 180 / Math.PI,
        axisFlipCorrected: this.axisFlipCorrected,
        axisFlipAxis: this.axisFlipAxis,
        jumpRejected: this.jumpRejected,
        jumpPendingFrames: this.pendingJumpFrames,
        relocalized: this.relocalized,
        relocalizePendingFrames: this.relocalizePendingFrames,
        relocalizeLockFrames: this.relocalizeLockFramesRemaining
      }
    };
  }
}
