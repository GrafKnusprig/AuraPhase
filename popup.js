const fmtHz = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2) + " Hz";
const fmtInt = (n) => Math.round(Number(n) * 100) + "%";

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureInjected(tabId) {
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendState(tabId, state) {
  await browser.tabs.sendMessage(tabId, { type: "AURAPHASE", ...state }).catch(() => {});
}

(async () => {
  const defaults = { enabled: false, monoEnabled: false, speedHz: 0.25, intensity: 0.7, direction: "right", spinEnabled: true };
  const stored = await browser.storage.local.get(defaults);

  const toggle = document.getElementById("toggle");
  const monoToggle = document.getElementById("monoToggle");
  const speed = document.getElementById("speed");
  const intensity = document.getElementById("intensity");
  const speedVal = document.getElementById("speedVal");
  const intVal = document.getElementById("intVal");
  const posViz = document.getElementById("posViz");
  const posDot = document.getElementById("posDot");
  const coreGroup = document.getElementById("coreGroup");
  const spinToggle = document.getElementById("spinToggle");
  const directionBtn = document.getElementById("directionBtn");
  const directionWrap = document.getElementById("directionWrap");
  const spinGroup = document.getElementById("spinGroup");

  toggle.checked = !!stored.enabled;
  monoToggle.checked = !!stored.monoEnabled;
  speed.value = stored.speedHz;
  intensity.value = stored.intensity;
  speedVal.textContent = fmtHz(speed.value);
  intVal.textContent = fmtInt(intensity.value);

  let direction = stored.direction === "left" ? "left" : "right";
  const setDirectionLabel = () => {
    directionBtn.textContent = direction === "left" ? "Clockwise" : "Counterclockwise";
  };
  setDirectionLabel();

  spinToggle.checked = stored.spinEnabled !== false;
  let vizRaf = null;
  let vizLastTs = null;
  let vizPhase = 0;
  let vizSpeed = Number(speed.value) || 0;
  const shapeGamma = 0.55;

  const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  const setPos = (pos) => {
    posDot.style.left = `${clamp01(pos) * 100}%`;
  };

  const stepViz = (ts) => {
    if (!toggle.checked) return;
    if (vizLastTs == null) vizLastTs = ts;
    const dt = Math.min(0.05, (ts - vizLastTs) / 1000);
    vizLastTs = ts;

    vizPhase += 2 * Math.PI * vizSpeed * dt;
    const x = Math.sin(vizPhase);
    const shaped = Math.sign(x) * Math.pow(Math.abs(x), shapeGamma);
    const dirSign = direction === "left" ? 1 : -1;
    setPos((shaped * dirSign + 1) / 2);

    vizRaf = requestAnimationFrame(stepViz);
  };

  const startPositionUpdates = () => {
    if (vizRaf != null) return;
    vizLastTs = null;
    vizSpeed = Number(speed.value) || 0;
    vizRaf = requestAnimationFrame(stepViz);
  };

  const stopPositionUpdates = () => {
    if (vizRaf == null) return;
    cancelAnimationFrame(vizRaf);
    vizRaf = null;
    vizLastTs = null;
    vizPhase = 0;
    vizSpeed = 0;
    setPos(0.5);
  };
  const updateUi = () => {
    const masterEnabled = toggle.checked;
    const spinEnabled = masterEnabled && spinToggle.checked;

    monoToggle.disabled = !masterEnabled;
    speed.disabled = !masterEnabled;
    intensity.disabled = !masterEnabled;
    spinToggle.disabled = !masterEnabled;
    directionBtn.disabled = !spinEnabled;

    coreGroup.classList.toggle("is-disabled", !masterEnabled);
    spinGroup.classList.toggle("is-disabled", !masterEnabled);
    directionWrap.classList.toggle("is-disabled", !spinEnabled);
    posViz.hidden = !masterEnabled;
    posViz.classList.toggle("is-disabled", !masterEnabled);
    if (masterEnabled) startPositionUpdates();
    else stopPositionUpdates();
  };
  updateUi();

  if (toggle.checked) startPositionUpdates();

  async function applyNow() {
    const tab = await getActiveTab();
    const state = {
      enabled: toggle.checked,
      monoEnabled: monoToggle.checked,
      speedHz: Number(speed.value),
      intensity: Number(intensity.value),
      direction,
      spinEnabled: spinToggle.checked
    };
    await browser.storage.local.set(state);
    await ensureInjected(tab.id);
    await sendState(tab.id, state);
  }

  const applyAndSync = async () => {
    await applyNow();
    vizSpeed = Number(speed.value) || 0;
  };

  toggle.addEventListener("change", () => {
    updateUi();
    applyAndSync();
  });
  monoToggle.addEventListener("change", applyAndSync);

  speed.addEventListener("input", () => { speedVal.textContent = fmtHz(speed.value); });
  speed.addEventListener("change", applyAndSync);

  intensity.addEventListener("input", () => { intVal.textContent = fmtInt(intensity.value); });
  intensity.addEventListener("change", applyAndSync);

  spinToggle.addEventListener("change", async () => {
    updateUi();
    await applyAndSync();
  });

  directionBtn.addEventListener("click", async () => {
    direction = direction === "left" ? "right" : "left";
    setDirectionLabel();
    await applyAndSync();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && toggle.checked) startPositionUpdates();
  });
})();