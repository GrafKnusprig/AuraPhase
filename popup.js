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
  const defaults = { enabled: false, speedHz: 0.25, intensity: 0.7 };
  const stored = await browser.storage.local.get(defaults);

  const toggle = document.getElementById("toggle");
  const speed = document.getElementById("speed");
  const intensity = document.getElementById("intensity");
  const speedVal = document.getElementById("speedVal");
  const intVal = document.getElementById("intVal");

  toggle.checked = !!stored.enabled;
  speed.value = stored.speedHz;
  intensity.value = stored.intensity;
  speedVal.textContent = fmtHz(speed.value);
  intVal.textContent = fmtInt(intensity.value);

  async function applyNow() {
    const tab = await getActiveTab();
    const state = {
      enabled: toggle.checked,
      speedHz: Number(speed.value),
      intensity: Number(intensity.value)
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

  // Optionally: apply when popup opens (keeps tab in sync with stored state)
  // await applyNow();
})();