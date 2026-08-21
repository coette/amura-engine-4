const cameraVideo = document.getElementById("cameraVideo");
let lockedTrack = null;
let monitorTimer = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function enforceMainView() {
  const stream = cameraVideo && cameraVideo.srcObject;
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (!track || track.readyState !== "live") return;

  lockedTrack = track;
  const capabilities = track.getCapabilities ? track.getCapabilities() : {};
  const settingsBefore = track.getSettings ? track.getSettings() : {};
  const advanced = {};

  if (capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max)) {
    advanced.zoom = clamp(1, capabilities.zoom.min, capabilities.zoom.max);
  }

  if (Object.keys(advanced).length && track.applyConstraints) {
    try {
      await track.applyConstraints({ advanced: [advanced] });
    } catch (_) {
      // Safari puede anunciar zoom y no aceptar el constraint exacto.
    }
  }

  const settingsAfter = track.getSettings ? track.getSettings() : settingsBefore;
  window.AmuraLensLock = {
    label: track.label || "—",
    deviceId: settingsAfter.deviceId || "—",
    zoom: Number.isFinite(settingsAfter.zoom) ? settingsAfter.zoom : null,
    width: settingsAfter.width || cameraVideo.videoWidth || 0,
    height: settingsAfter.height || cameraVideo.videoHeight || 0,
    enforcedAt: Date.now()
  };
}

function monitorLens() {
  if (!lockedTrack || lockedTrack.readyState !== "live") return;
  const capabilities = lockedTrack.getCapabilities ? lockedTrack.getCapabilities() : {};
  const settings = lockedTrack.getSettings ? lockedTrack.getSettings() : {};
  if (
    lockedTrack.applyConstraints &&
    capabilities.zoom &&
    Number.isFinite(settings.zoom) &&
    Math.abs(settings.zoom - 1) > 0.03 &&
    capabilities.zoom.min <= 1 && capabilities.zoom.max >= 1
  ) {
    lockedTrack.applyConstraints({ advanced: [{ zoom: 1 }] }).catch(() => {});
  }
}

function startMonitor() {
  window.clearInterval(monitorTimer);
  window.setTimeout(enforceMainView, 180);
  monitorTimer = window.setInterval(monitorLens, 700);
}

window.addEventListener("amura-camera-state", (event) => {
  if (event.detail && event.detail.status === "live" && event.detail.facingMode !== "user") {
    startMonitor();
  } else {
    lockedTrack = null;
    window.clearInterval(monitorTimer);
    monitorTimer = 0;
  }
});

if (window.AmuraCameraState && window.AmuraCameraState.status === "live") startMonitor();

window.addEventListener("pagehide", () => {
  window.clearInterval(monitorTimer);
});