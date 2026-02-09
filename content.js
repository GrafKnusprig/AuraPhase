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
    direction: "right",
    spinEnabled: true,
    monoEnabled: false,

    lfoStartTime: null,

    ctx: null,
    pipelines: new WeakMap(),
    watcher: null,

    // caps / tuning
    maxPan: 0.7,           // never hard L/R
    baseDelay: 0.004,      // 4ms
    maxDelayDepth: 0.004,  // +/- 4ms => 0..8ms swing
    tremMax: 0.08,         // subtle

    // shape: <1 lingers at extremes; >1 lingers near center
    // 0.55 spends more time left/right without hard edges
    shapeGamma: 0.55
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

  function applyGateCurve(shaper) {
    const N = 2048;
    const curve = new Float32Array(N);
    const edge = 0.03;

    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1; // -1..1
      let y = 0;
      if (x <= -edge) y = 0;
      else if (x >= edge) y = 1;
      else y = (x + edge) / (2 * edge);
      curve[i] = y;
    }
    shaper.curve = curve;
    shaper.oversample = "4x";
  }

  function getPanPosition() {
    if (!A.enabled || !A.speedHz) return 0.5;
    const t = A.ctx ? A.ctx.currentTime : performance.now() / 1000;
    const phase = 2 * Math.PI * A.speedHz * t;
    const x = Math.sin(phase);
    const shaped = Math.sign(x) * Math.pow(Math.abs(x), A.shapeGamma);
    const dirSign = A.direction === "left" ? 1 : -1;
    return clamp((shaped * dirSign + 1) / 2, 0, 1);
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
    const inputGain = ac.createGain();
    const monoSplitter = ac.createChannelSplitter(2);
    const monoGainL = ac.createGain();
    const monoGainR = ac.createGain();
    const monoSum = ac.createGain();
    const monoMerger = ac.createChannelMerger(2);
    const monoSelect = ac.createGain();
    const stereoSelect = ac.createGain();
    const merger = ac.createChannelMerger(2);

    const delayL = ac.createDelay(0.05);
    const delayR = ac.createDelay(0.05);

    const trem = ac.createGain();
    const panner = ac.createStereoPanner();
    const limiter = ac.createDynamicsCompressor();
    const outGain = ac.createGain();
    const dryGain = ac.createGain();

    // LFO (orbit)
    const lfo = ac.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = A.speedHz;

    // Shape LFO so it lingers at extremes
    const shaper = makeShaper(ac);
    lfo.connect(shaper);

    // Direction gain: flips motion without biasing left/right energy
    const dirGain = ac.createGain();
    shaper.connect(dirGain);

    // Quadrature delay for ITD (90-degree phase shift)
    const quadDelay = ac.createDelay(30.0);
    const gateSign = ac.createGain();
    const gateShape = ac.createWaveShaper();
    const gateGain = ac.createGain();
    applyGateCurve(gateShape);

    // --- PAN (ILD) ---
    const panDepth = ac.createGain();
    // actual value set in applyParams()
    dirGain.connect(panDepth);
    panDepth.connect(panner.pan);

    // --- ITD (Haas) ---
    const baseL = ac.createConstantSource();
    const baseR = ac.createConstantSource();
    baseL.offset.value = A.baseDelay;
    baseR.offset.value = A.baseDelay;

    const delayDepth = ac.createGain();
    const delayDepthNeg = ac.createGain();
    dirGain.connect(quadDelay);
    quadDelay.connect(gateSign);
    gateSign.connect(gateShape);
    gateShape.connect(gateGain.gain);
    quadDelay.connect(gateGain);
    gateGain.connect(delayDepth);
    gateGain.connect(delayDepthNeg);
    delayDepth.connect(delayL.delayTime);
    delayDepthNeg.connect(delayR.delayTime);
    baseL.connect(delayL.delayTime);
    baseR.connect(delayR.delayTime);

    // --- Tremolo (very subtle glue) ---
    const tremBase = ac.createConstantSource();
    tremBase.offset.value = 1.0;

    const tremDepth = ac.createGain();
    dirGain.connect(tremDepth);
    tremDepth.connect(trem.gain);
    tremBase.connect(trem.gain);

    // Mono path (L+R summed to dual-mono)
    monoGainL.gain.value = 0.5;
    monoGainR.gain.value = 0.5;
    inputGain.connect(monoSplitter);
    monoSplitter.connect(monoGainL, 0);
    monoSplitter.connect(monoGainR, 1);
    monoGainL.connect(monoSum);
    monoGainR.connect(monoSum);
    monoSum.connect(monoMerger, 0, 0);
    monoSum.connect(monoMerger, 0, 1);
    monoMerger.connect(monoSelect);
    monoSelect.connect(splitter);

    // Stereo path (original)
    inputGain.connect(stereoSelect);
    stereoSelect.connect(splitter);

    // Wire audio chain
    source.connect(inputGain);
    source.connect(dryGain);
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);

    merger.connect(trem);
    trem.connect(panner);
    panner.connect(limiter);
    limiter.connect(outGain);
    outGain.connect(ac.destination);
    dryGain.connect(ac.destination);

    outGain.gain.value = 1.0;
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;

    // Start sources
    baseL.start();
    baseR.start();
    tremBase.start();
    lfo.start();
    if (A.lfoStartTime == null) A.lfoStartTime = ac.currentTime;

    // Resume on play (autoplay policies)
    const resume = async () => {
      if (ac.state !== "running") {
        try { await ac.resume(); } catch {}
      }
    };
    mediaEl.addEventListener("play", resume, { passive: true });

    A.pipelines.set(mediaEl, {
      ac, source, splitter, merger,
      inputGain, monoSplitter, monoGainL, monoGainR, monoSum, monoMerger,
      monoSelect, stereoSelect,
      delayL, delayR, trem, panner, limiter, outGain, dryGain,
      lfo, shaper, dirGain, quadDelay, gateSign, gateShape, gateGain,
      panDepth, baseL, baseR,
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
    p.dirGain.gain.value = A.direction === "left" ? 1 : -1;
    p.quadDelay.delayTime.value = Math.min(30, 0.25 / Math.max(0.001, A.speedHz));
    p.gateSign.gain.value = A.direction === "left" ? -1 : 1;
    if (!A.enabled) {
      // True bypass: dry path only.
      p.outGain.gain.value = 0;
      p.dryGain.gain.value = 1;
      // Bypass mono to restore original stereo when disabled.
      p.monoSelect.gain.value = 0;
      p.stereoSelect.gain.value = 1;
      // BYPASS: keep audio flowing, but zero out effect
      p.panDepth.gain.value = 0;
      p.delayDepth.gain.value = 0;
      p.delayDepthNeg.gain.value = 0;
      p.tremDepth.gain.value = 0;
      p.panner.pan.value = 0;
      return;
    }

    // Enabled: wet path only.
    const trem = A.tremMax * A.intensity;
    const panAmt = A.maxPan * A.intensity;                 // <= 0.85
    const panComp = A.monoEnabled ? 1 : 1 + panAmt * 0.35;
    const wetComp = 1 / (panComp + trem);
    p.outGain.gain.value = wetComp;
    p.dryGain.gain.value = 0;

    // Enabled: allow mono toggle with unity level.
    p.monoSelect.gain.value = A.monoEnabled ? 1 : 0;
    p.stereoSelect.gain.value = A.monoEnabled ? 0 : 1;

    // enabled
    const d = A.maxDelayDepth * A.intensity;               // Haas depth
    const tremDepth = trem;                                // subtle

    p.panDepth.gain.value = panAmt;
    const delayDepth = A.spinEnabled ? d : 0;
    p.delayDepth.gain.value = delayDepth;
    p.delayDepthNeg.gain.value = -delayDepth;
    p.tremDepth.gain.value = tremDepth;
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
      monoEnabled: false,
      speedHz: 0.25,
      intensity: 0.7,
      direction: "right",
      spinEnabled: true
    });
    A.enabled = !!res.enabled;
    A.monoEnabled = !!res.monoEnabled;
    A.speedHz = clamp(Number(res.speedHz) || 0.25, 0.01, 1.0);
    A.intensity = clamp(Number(res.intensity) ?? 0.7, 0.0, 1.0);
    A.direction = res.direction === "left" ? "left" : "right";
    A.spinEnabled = res.spinEnabled !== false;
  }

  function initOrUpdate() {
    // Ensure we hook existing elements once, then just update params.
    document.querySelectorAll("audio, video").forEach(ensurePipelineFor);
    startWatching();
    applyParamsToAll();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type !== "AURAPHASE") return;

    if (typeof msg.enabled === "boolean") A.enabled = msg.enabled;
    if (msg.monoEnabled != null) A.monoEnabled = !!msg.monoEnabled;
    if (msg.speedHz != null) A.speedHz = clamp(Number(msg.speedHz) || 0.25, 0.01, 1.0);
    if (msg.intensity != null) A.intensity = clamp(Number(msg.intensity), 0.0, 1.0);
    if (msg.direction != null) A.direction = msg.direction === "left" ? "left" : "right";
    if (msg.spinEnabled != null) A.spinEnabled = !!msg.spinEnabled;

    initOrUpdate();
  });

  (async () => {
    await loadSettings();
    initOrUpdate();
  })();

  window.__AURAPHASE__ = A;
})();