(() => {
  // Prevent stacking: if injected multiple times, reuse the existing instance.
  if (window.__AURAPHASE__) {
    // Optional: ping existing instance that we're "alive"
    return;
  }

  const A = {
    enabled: false,
    speedHz: 0.25,
    intensity: 0.7,

    ctx: null,
    pipelines: new WeakMap(),
    watcher: null,

    // caps / tuning
    maxPan: 0.85,          // never hard L/R
    baseDelay: 0.006,      // 6ms
    maxDelayDepth: 0.006,  // +/- 6ms => 0..12ms swing
    tremMax: 0.12,         // subtle

    // shape: >1 slows around center (reduces "too fast in middle" feel)
    // 2.0 is a good start
    shapeGamma: 2.0
  };

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function ensureContext() {
    if (A.ctx) return A.ctx;
    A.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return A.ctx;
  }

  function makeShaper(ac) {
    const shaper = ac.createWaveShaper();
    const N = 2048;
    const curve = new Float32Array(N);
    const g = A.shapeGamma;

    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1; // -1..1
      const y = Math.sign(x) * Math.pow(Math.abs(x), g);
      curve[i] = y;
    }
    shaper.curve = curve;
    shaper.oversample = "4x";
    return shaper;
  }

  function ensurePipelineFor(mediaEl) {
    if (!(mediaEl instanceof HTMLMediaElement)) return;
    if (A.pipelines.has(mediaEl)) return;

    const ac = ensureContext();

    let source;
    try {
      source = ac.createMediaElementSource(mediaEl);
    } catch (e) {
      console.warn("[AuraPhase] Cannot hook this element:", e);
      return;
    }

    // --- Graph building ---
    const splitter = ac.createChannelSplitter(2);
    const merger = ac.createChannelMerger(2);

    const delayL = ac.createDelay(0.05);
    const delayR = ac.createDelay(0.05);

    const trem = ac.createGain();
    const panner = ac.createStereoPanner();
    const outGain = ac.createGain();

    // LFO (orbit)
    const lfo = ac.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = A.speedHz;

    // Shape LFO so center movement is less aggressive
    const shaper = makeShaper(ac);
    lfo.connect(shaper);

    // --- PAN (ILD) ---
    const panDepth = ac.createGain();
    // actual value set in applyParams()
    shaper.connect(panDepth);
    panDepth.connect(panner.pan);

    // --- ITD (Haas) ---
    const baseL = ac.createConstantSource();
    const baseR = ac.createConstantSource();
    baseL.offset.value = A.baseDelay;
    baseR.offset.value = A.baseDelay;

    const delayDepth = ac.createGain();
    const delayDepthNeg = ac.createGain();
    shaper.connect(delayDepth);
    shaper.connect(delayDepthNeg);
    delayDepth.connect(delayL.delayTime);
    delayDepthNeg.connect(delayR.delayTime);
    baseL.connect(delayL.delayTime);
    baseR.connect(delayR.delayTime);

    // --- Tremolo (very subtle glue) ---
    const tremBase = ac.createConstantSource();
    tremBase.offset.value = 1.0;

    const tremDepth = ac.createGain();
    shaper.connect(tremDepth);
    tremDepth.connect(trem.gain);
    tremBase.connect(trem.gain);

    // Wire audio chain
    source.connect(splitter);
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);

    merger.connect(trem);
    trem.connect(panner);
    panner.connect(outGain);
    outGain.connect(ac.destination);

    outGain.gain.value = 1.0;

    // Start sources
    baseL.start();
    baseR.start();
    tremBase.start();
    lfo.start();

    // Resume on play (autoplay policies)
    const resume = async () => {
      if (ac.state !== "running") {
        try { await ac.resume(); } catch {}
      }
    };
    mediaEl.addEventListener("play", resume, { passive: true });

    A.pipelines.set(mediaEl, {
      ac, source, splitter, merger,
      delayL, delayR, trem, panner, outGain,
      lfo, shaper, panDepth, baseL, baseR,
      delayDepth, delayDepthNeg, tremBase, tremDepth
    });

    applyParamsToOne(mediaEl);

    // Cleanup when removed (but keep bypass-safe)
    const obs = new MutationObserver(() => {
      if (!document.contains(mediaEl)) {
        // don't hard-stop audio contexts; just forget pipeline
        // (the node graph will be GC'ed when element goes away)
        A.pipelines.delete(mediaEl);
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  function applyParamsToOne(mediaEl) {
    const p = A.pipelines.get(mediaEl);
    if (!p) return;

    p.lfo.frequency.value = A.speedHz;

    if (!A.enabled) {
      // BYPASS: keep audio flowing, but zero out effect
      p.panDepth.gain.value = 0;
      p.delayDepth.gain.value = 0;
      p.delayDepthNeg.gain.value = 0;
      p.tremDepth.gain.value = 0;
      p.panner.pan.value = 0;
      return;
    }

    // enabled
    const panAmt = A.maxPan * A.intensity;                 // <= 0.85
    const d = A.maxDelayDepth * A.intensity;               // Haas depth
    const trem = A.tremMax * A.intensity;                  // subtle

    p.panDepth.gain.value = panAmt;
    p.delayDepth.gain.value = d;
    p.delayDepthNeg.gain.value = -d;
    p.tremDepth.gain.value = trem;
  }

  function applyParamsToAll() {
    document.querySelectorAll("audio, video").forEach(applyParamsToOne);
  }

  function startWatching() {
    if (A.watcher) return;
    A.watcher = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.("audio, video")) ensurePipelineFor(node);
          node.querySelectorAll?.("audio, video").forEach(ensurePipelineFor);
        }
      }
    });
    A.watcher.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function loadSettings() {
    const res = await browser.storage.local.get({
      enabled: false,
      speedHz: 0.25,
      intensity: 0.7
    });
    A.enabled = !!res.enabled;
    A.speedHz = clamp(Number(res.speedHz) || 0.25, 0.05, 3.0);
    A.intensity = clamp(Number(res.intensity) ?? 0.7, 0.0, 1.0);
  }

  function initOrUpdate() {
    // Ensure we hook existing elements once, then just update params.
    document.querySelectorAll("audio, video").forEach(ensurePipelineFor);
    startWatching();
    applyParamsToAll();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "AURAPHASE") return;

    if (typeof msg.enabled === "boolean") A.enabled = msg.enabled;
    if (msg.speedHz != null) A.speedHz = clamp(Number(msg.speedHz) || 0.25, 0.05, 3.0);
    if (msg.intensity != null) A.intensity = clamp(Number(msg.intensity), 0.0, 1.0);

    initOrUpdate();
  });

  (async () => {
    await loadSettings();
    initOrUpdate();
  })();

  window.__AURAPHASE__ = A;
})();