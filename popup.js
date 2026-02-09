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
  const defaults = { enabled: false, speedHz: 0.25, intensity: 0.7, direction: "right", spinEnabled: true };
  const stored = await browser.storage.local.get(defaults);

  const toggle = document.getElementById("toggle");
  const speed = document.getElementById("speed");
  const intensity = document.getElementById("intensity");
  const speedVal = document.getElementById("speedVal");
  const intVal = document.getElementById("intVal");
  const spinToggle = document.getElementById("spinToggle");
  const directionBtn = document.getElementById("directionBtn");
  const directionWrap = document.getElementById("directionWrap");

  toggle.checked = !!stored.enabled;
  speed.value = stored.speedHz;
  intensity.value = stored.intensity;
  speedVal.textContent = fmtHz(speed.value);
  intVal.textContent = fmtInt(intensity.value);

  let direction = stored.direction === "left" ? "left" : "right";
  const setDirectionLabel = () => {
    directionBtn.textContent = direction === "left" ? "Counterclockwise" : "Clockwise";
  };
  setDirectionLabel();

  spinToggle.checked = stored.spinEnabled !== false;
  const updateSpinUi = () => {
    const disabled = !spinToggle.checked;
    directionBtn.disabled = disabled;
    directionWrap.classList.toggle("is-disabled", disabled);
  };
  updateSpinUi();

  async function applyNow() {
    const tab = await getActiveTab();
    const state = {
      enabled: toggle.checked,
      speedHz: Number(speed.value),
      intensity: Number(intensity.value),
      direction,
      spinEnabled: spinToggle.checked
    };
    await browser.storage.local.set(state);
    await ensureInjected(tab.id);
    await sendState(tab.id, state);
  }

  toggle.addEventListener("change", applyNow);

  speed.addEventListener("input", () => { speedVal.textContent = fmtHz(speed.value); });
  speed.addEventListener("change", applyNow);

  intensity.addEventListener("input", () => { intVal.textContent = fmtInt(intensity.value); });
  intensity.addEventListener("change", applyNow);

  spinToggle.addEventListener("change", async () => {
    updateSpinUi();
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