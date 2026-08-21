(function () {
  "use strict";

  var cameraLab = document.querySelector(".camera-lab");
  var video = document.getElementById("cameraVideo");
  var startPanel = document.getElementById("startPanel");
  var requestPanel = document.getElementById("requestPanel");
  var startButton = document.getElementById("startButton");
  var stopButton = document.getElementById("stopButton");
  var switchCameraButton = document.getElementById("switchCameraButton");
  var switchCameraValue = document.getElementById("switchCameraValue");
  var diagnosticsButton = document.getElementById("diagnosticsButton");
  var closeDiagnosticsButton = document.getElementById("closeDiagnosticsButton");
  var diagnosticsPanel = document.getElementById("diagnosticsPanel");
  var diagnosticsList = document.getElementById("diagnosticsList");
  var statusLabel = document.getElementById("statusLabel");
  var statusMessage = document.getElementById("statusMessage");
  var fpsValue = document.getElementById("fpsValue");
  var installHint = document.getElementById("installHint");

  var stream = null;
  var cameras = [];
  var currentDeviceId = "";
  var currentFacingMode = "environment";
  var facingDeviceIds = { user: "", environment: "" };
  var currentStatus = "idle";
  var measuredFps = 0;
  var frameHandle = null;
  var frameToken = 0;
  var frameStats = { frames: 0, startedAt: 0, lastVideoTime: -1 };
  var interfaceTimer = null;
  var DEVELOPMENT_UI_ALWAYS_VISIBLE = true;

  window.AmuraCameraState = {
    status: currentStatus,
    facingMode: currentFacingMode
  };

  var STATUS_LABELS = {
    idle: "EN ESPERA",
    requesting: "SOLICITANDO",
    live: "CÁMARA ACTIVA",
    paused: "PAUSADA",
    error: "REVISAR"
  };

  function isStandaloneMode() {
    var standaloneDisplay = window.matchMedia && (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches
    );
    return Boolean(standaloneDisplay || window.navigator.standalone === true);
  }

  function clearInterfaceTimer() {
    if (interfaceTimer !== null) {
      clearTimeout(interfaceTimer);
      interfaceTimer = null;
    }
  }

  function hideInterface() {
    if (DEVELOPMENT_UI_ALWAYS_VISIBLE) {
      document.body.classList.remove("ui-hidden");
      return;
    }
    if (currentStatus === "live" && diagnosticsPanel.hidden) document.body.classList.add("ui-hidden");
  }

  function scheduleInterfaceHide() {
    clearInterfaceTimer();
    if (DEVELOPMENT_UI_ALWAYS_VISIBLE) {
      document.body.classList.remove("ui-hidden");
      return;
    }
    if (currentStatus === "live" && diagnosticsPanel.hidden) interfaceTimer = setTimeout(hideInterface, 2800);
  }

  function showInterface(scheduleHide) {
    clearInterfaceTimer();
    document.body.classList.remove("ui-hidden");
    if (scheduleHide) scheduleInterfaceHide();
  }

  function updateStandaloneState() {
    var standalone = isStandaloneMode();
    document.body.classList.toggle("standalone", standalone);
    installHint.hidden = standalone;
  }

  function requestAvailableFullscreen() {
    if (isStandaloneMode() || document.fullscreenElement) return;
    var root = document.documentElement;
    if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
  }

  function setStatus(status, message) {
    currentStatus = status;
    document.body.setAttribute("data-status", status);
    statusLabel.textContent = STATUS_LABELS[status] || status.toUpperCase();
    if (message) statusMessage.textContent = message;
    requestPanel.hidden = status !== "requesting";
    startPanel.hidden = status === "requesting" || status === "live";
    if (status === "paused") startButton.textContent = "Reanudar cámara";
    else if (status === "error") startButton.textContent = "Reintentar cámara";
    else startButton.textContent = "Abrir cámara trasera";
    updateControls();
    if (status === "live") showInterface(true); else showInterface(false);
    window.AmuraCameraState = { status: currentStatus, facingMode: currentFacingMode };
    window.dispatchEvent(new CustomEvent("amura-camera-state", { detail: window.AmuraCameraState }));
  }

  function updateControls() {
    var hasStream = Boolean(stream);
    stopButton.hidden = !hasStream;
    switchCameraButton.hidden = !hasStream;
    switchCameraButton.disabled = currentStatus !== "live";
    switchCameraValue.textContent = currentFacingMode === "user" ? "TRASERA" : "FRONTAL";
  }

  function cameraErrorMessage(error) {
    var name = error && error.name ? error.name : "UnknownError";
    var messages = {
      NotAllowedError: "No tenemos permiso para usar la cámara. Permite el acceso en los ajustes del navegador y vuelve a intentarlo.",
      PermissionDeniedError: "No tenemos permiso para usar la cámara. Permite el acceso en los ajustes del navegador y vuelve a intentarlo.",
      NotFoundError: "No se ha encontrado ninguna cámara disponible.",
      DevicesNotFoundError: "No se ha encontrado ninguna cámara disponible.",
      NotReadableError: "La cámara está ocupada por otra aplicación o el navegador no puede acceder a ella.",
      TrackStartError: "La cámara está ocupada por otra aplicación o el navegador no puede acceder a ella.",
      OverconstrainedError: "La cámara no admite la configuración solicitada.",
      ConstraintNotSatisfiedError: "La cámara no admite la configuración solicitada.",
      SecurityError: "El navegador ha bloqueado la cámara por seguridad.",
      TypeError: "La cámara solo puede abrirse desde una conexión HTTPS segura.",
      AbortError: "La apertura de la cámara se ha interrumpido."
    };
    return messages[name] || "No se ha podido abrir la cámara (" + name + ").";
  }

  function cancelFrameCounter() {
    frameToken += 1;
    if (frameHandle !== null) {
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle); else cancelAnimationFrame(frameHandle);
    }
    frameHandle = null;
    measuredFps = 0;
    frameStats = { frames: 0, startedAt: 0, lastVideoTime: -1 };
    fpsValue.textContent = "DATOS";
  }

  function startFrameCounter() {
    cancelFrameCounter();
    var token = frameToken;
    frameStats.startedAt = performance.now();
    frameStats.lastVideoTime = video.currentTime;
    function registerFrame(now) {
      if (token !== frameToken) return;
      frameStats.frames += 1;
      var elapsed = now - frameStats.startedAt;
      if (elapsed >= 1000) {
        measuredFps = frameStats.frames * 1000 / elapsed;
        frameStats.frames = 0;
        frameStats.startedAt = now;
        fpsValue.textContent = measuredFps.toFixed(0) + " FPS";
      }
    }
    if (video.requestVideoFrameCallback) {
      function videoTick(now) { if (token !== frameToken) return; registerFrame(now); frameHandle = video.requestVideoFrameCallback(videoTick); }
      frameHandle = video.requestVideoFrameCallback(videoTick); return;
    }
    function animationTick(now) {
      if (token !== frameToken) return;
      if (video.currentTime !== frameStats.lastVideoTime) { frameStats.lastVideoTime = video.currentTime; registerFrame(now); }
      frameHandle = requestAnimationFrame(animationTick);
    }
    frameHandle = requestAnimationFrame(animationTick);
  }

  function stopMedia(updateStatus) {
    cancelFrameCounter();
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    stream = null; currentDeviceId = ""; currentFacingMode = "environment";
    document.body.setAttribute("data-facing", currentFacingMode);
    video.srcObject = null; updateControls();
    if (updateStatus !== false) setStatus("idle", "Cámara detenida. Puedes volver a abrirla cuando quieras.");
  }

  function refreshCameraList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) { cameras = []; updateControls(); return Promise.resolve(); }
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      cameras = devices.filter(function (device) { return device.kind === "videoinput"; }).map(function (device, index) {
        return { deviceId: device.deviceId, label: device.label || "Cámara " + (index + 1) };
      });
      updateControls();
    }).catch(function () { cameras = []; updateControls(); });
  }

  function preferredConstraints(facingMode, deviceId) {
    var videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId }; else videoConstraints.facingMode = { ideal: facingMode };
    return { audio: false, video: videoConstraints };
  }

  function findCameraForFacing(facingMode) {
    var frontPattern = /front|user|facetime|frontal|avant|vorne|fronte|前置/i;
    var rearPattern = /back|rear|environment|trasera|arrière|hinten|traseira|背面|后置/i;
    var pattern = facingMode === "user" ? frontPattern : rearPattern;
    var match = cameras.find(function (camera) { return pattern.test(camera.label); });
    return match ? match.deviceId : "";
  }

  function attachTrackEvents(track) {
    track.addEventListener("ended", function () { cancelFrameCounter(); setStatus("paused", "La cámara se ha detenido. Pulsa reanudar para abrirla de nuevo."); });
    track.addEventListener("mute", function () { setStatus("paused", "El sistema ha pausado temporalmente la cámara."); });
    track.addEventListener("unmute", function () { setStatus("live", "Cámara activa."); startFrameCounter(); });
  }

  function startCamera(facingMode, deviceId) {
    var requestedFacingMode = facingMode || "environment";
    stopMedia(false); setStatus("requesting", "Esperando permiso del navegador…");
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("error", "Este navegador no permite usar la cámara aquí. Abre el laboratorio desde la URL HTTPS de Cloudflare Pages."); return;
    }
    var request = navigator.mediaDevices.getUserMedia(preferredConstraints(requestedFacingMode, deviceId));
    request.catch(function () { return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: requestedFacingMode } }); }).then(function (newStream) {
      stream = newStream; video.srcObject = newStream;
      return video.play().then(function () {
        var track = newStream.getVideoTracks()[0];
        var settings = track.getSettings ? track.getSettings() : {};
        currentDeviceId = settings.deviceId || deviceId || "";
        currentFacingMode = settings.facingMode || requestedFacingMode;
        document.body.setAttribute("data-facing", currentFacingMode);
        if (currentDeviceId && facingDeviceIds[currentFacingMode] !== undefined) facingDeviceIds[currentFacingMode] = currentDeviceId;
        attachTrackEvents(track); setStatus("live", "Cámara activa."); startFrameCounter(); return refreshCameraList();
      });
    }).catch(function (error) { stopMedia(false); setStatus("error", cameraErrorMessage(error)); });
  }

  function toggleCamera() {
    var targetFacingMode = currentFacingMode === "user" ? "environment" : "user";
    var targetDeviceId = facingDeviceIds[targetFacingMode] || findCameraForFacing(targetFacingMode);
    startCamera(targetFacingMode, targetDeviceId);
  }

  function orientationLabel() {
    if (screen.orientation && screen.orientation.type) return screen.orientation.type + " · " + screen.orientation.angle + "°";
    var portrait = window.innerHeight >= window.innerWidth;
    var legacyAngle = typeof window.orientation === "number" ? window.orientation : 0;
    return (portrait ? "portrait" : "landscape") + " · " + legacyAngle + "°";
  }

  function findActiveCameraLabel(track) {
    var active = cameras.find(function (camera) { return camera.deviceId === currentDeviceId; });
    return (active && active.label) || (track && track.label) || "—";
  }

  function updateDiagnostics() {
    var track = stream && stream.getVideoTracks()[0];
    var settings = track && track.getSettings ? track.getSettings() : {};
    var sourceWidth = video.videoWidth || 0, sourceHeight = video.videoHeight || 0;
    var viewportWidth = Math.round(window.visualViewport ? window.visualViewport.width : window.innerWidth);
    var viewportHeight = Math.round(window.visualViewport ? window.visualViewport.height : window.innerHeight);
    var crop = "—";
    if (sourceWidth && sourceHeight && viewportWidth && viewportHeight) {
      var scale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
      var renderedWidth = sourceWidth * scale, renderedHeight = sourceHeight * scale;
      var cropX = Math.max(0, (renderedWidth - viewportWidth) / 2), cropY = Math.max(0, (renderedHeight - viewportHeight) / 2);
      crop = cropX.toFixed(0) + " × " + cropY.toFixed(0) + " px";
    }
    var data = [
      ["Versión", "ENGINE 4"], ["Estado", currentStatus], ["Interfaz debug", DEVELOPMENT_UI_ALWAYS_VISIBLE ? "fija" : "automática"],
      ["FPS medidos", measuredFps ? measuredFps.toFixed(1) : "—"], ["FPS cámara", typeof settings.frameRate === "number" ? settings.frameRate.toFixed(1) : "—"],
      ["Fuente vídeo", sourceWidth ? sourceWidth + " × " + sourceHeight : "—"], ["Ajuste track", settings.width ? settings.width + " × " + settings.height : "—"],
      ["Dirección", settings.facingMode || "no indicada"], ["Cámara", findActiveCameraLabel(track)], ["Track / mute", track ? track.readyState + " / " + track.muted : "—"],
      ["Cámaras vistas", String(cameras.length)], ["Viewport", viewportWidth + " × " + viewportHeight], ["DPR", window.devicePixelRatio.toFixed(2)],
      ["Orientación", orientationLabel()], ["Recorte cover", crop], ["HTTPS", window.isSecureContext ? "sí" : "no"], ["Visibilidad", document.visibilityState],
      ["Modo", isStandaloneMode() ? "web-app" : "navegador"], ["Fullscreen", document.fullscreenElement ? "sí" : "no"]
    ];
    var trackingData = window.AmuraTrackingDiagnostics || {};
    Object.keys(trackingData).forEach(function (key) { data.push([key, String(trackingData[key])]); });
    diagnosticsList.innerHTML = data.map(function (item) { return "<div><dt>" + item[0] + "</dt><dd>" + item[1] + "</dd></div>"; }).join("");
  }

  function setDiagnosticsOpen(open) {
    showInterface(false); diagnosticsPanel.hidden = !open; diagnosticsButton.setAttribute("aria-pressed", open ? "true" : "false");
    if (open) updateDiagnostics(); else scheduleInterfaceHide();
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    var track = stream && stream.getVideoTracks()[0];
    if (track && track.readyState === "ended") { setStatus("paused", "La cámara se cerró al salir del navegador. Pulsa reanudar."); return; }
    if (track && video.paused) video.play().then(function () { setStatus("live", "Cámara activa."); startFrameCounter(); }).catch(function () { setStatus("paused", "Pulsa reanudar para recuperar el vídeo."); });
  }

  startButton.addEventListener("click", function () { requestAvailableFullscreen(); startCamera("environment"); });
  stopButton.addEventListener("click", function () { stopMedia(true); if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); });
  switchCameraButton.addEventListener("click", toggleCamera);
  diagnosticsButton.addEventListener("click", function () { setDiagnosticsOpen(diagnosticsPanel.hidden); });
  closeDiagnosticsButton.addEventListener("click", function () { setDiagnosticsOpen(false); });
  cameraLab.addEventListener("click", function () { if (currentStatus === "live") showInterface(true); });
  window.addEventListener("resize", updateDiagnostics); window.addEventListener("orientationchange", updateDiagnostics);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", updateDiagnostics);
  document.addEventListener("visibilitychange", handleVisibilityChange); document.addEventListener("fullscreenchange", updateDiagnostics);
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", refreshCameraList);
  window.addEventListener("pagehide", function (event) { if (!event.persisted) stopMedia(false); });
  setInterval(updateDiagnostics, 500); updateStandaloneState(); updateDiagnostics(); updateControls();
}());
