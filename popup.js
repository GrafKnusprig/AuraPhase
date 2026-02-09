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
  };
  updateUi();

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

  toggle.addEventListener("change", () => {
    updateUi();
    applyNow();
  });
  monoToggle.addEventListener("change", applyNow);

  speed.addEventListener("input", () => { speedVal.textContent = fmtHz(speed.value); });
  speed.addEventListener("change", applyNow);

  intensity.addEventListener("input", () => { intVal.textContent = fmtInt(intensity.value); });
  intensity.addEventListener("change", applyNow);

  spinToggle.addEventListener("change", async () => {
    updateUi();
    await applyNow();
  });

  directionBtn.addEventListener("click", async () => {
    direction = direction === "left" ? "right" : "left";
    setDirectionLabel();
    await applyNow();
  });

  // Optionally: apply when popup opens (keeps tab in sync with stored state)
  // await applyNow();
})();