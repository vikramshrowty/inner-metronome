import './style.css';
import { AcousticCalibrator } from './audio/chirp';
import { ClapDetector } from './audio/clapDetector';
import { Metronome, BeatEvaluation, DropMode } from './audio/metronome';
import { TimingVisualizer, SessionStats, evaluateMusicianTier } from './ui/visualizer';

let audioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let calibrator: AcousticCalibrator | null = null;
let clapDetector: ClapDetector | null = null;
let metronome: Metronome | null = null;
let visualizer: TimingVisualizer | null = null;
const sessionStats = new SessionStats();

let calibratedLatencyMs = 60; // Default fallback
let currentDropMode: DropMode = 'random_10'; // 10% default as requested

// Views & Navigation
const viewCalibration = document.getElementById('viewCalibration') as HTMLElement;
const viewTrainer = document.getElementById('viewTrainer') as HTMLElement;
const btnOpenSettings = document.getElementById('btnOpenSettings') as HTMLButtonElement;
const headerOffsetBadge = document.getElementById('headerOffsetBadge') as HTMLElement;
const postCalibActions = document.getElementById('postCalibActions') as HTMLElement;
const btnContinueToTrainer = document.getElementById('btnContinueToTrainer') as HTMLButtonElement;
const btnSkipCalibration = document.getElementById('btnSkipCalibration') as HTMLButtonElement;
const calibSuccessTitle = document.getElementById('calibSuccessTitle') as HTMLElement;

// Verification Elements (Hero & Modal)
const btnVerifyCalib = document.getElementById('btnVerifyCalib') as HTMLButtonElement | null;
const verifyResultPanel = document.getElementById('verifyResultPanel') as HTMLElement | null;
const verifyResultText = document.getElementById('verifyResultText') as HTMLElement | null;
const btnAutoTrim = document.getElementById('btnAutoTrim') as HTMLButtonElement | null;
const btnModalVerify = document.getElementById('btnModalVerify') as HTMLButtonElement | null;
const modalVerifyResult = document.getElementById('modalVerifyResult') as HTMLElement | null;

// Calibration Elements (Hero)
const btnCalibrate = document.getElementById('btnCalibrate') as HTMLButtonElement;
const calibBadge = document.getElementById('calibBadge') as HTMLElement;
const calibStatus = document.getElementById('calibStatus') as HTMLElement;

// Settings Modal Elements
const settingsModal = document.getElementById('settingsModal') as HTMLElement;
const btnCloseSettings = document.getElementById('btnCloseSettings') as HTMLButtonElement;
const btnSaveSettings = document.getElementById('btnSaveSettings') as HTMLButtonElement;
const btnModalCalibrate = document.getElementById('btnModalCalibrate') as HTMLButtonElement;
const modalCalibStatus = document.getElementById('modalCalibStatus') as HTMLElement;
const modalLatencySlider = document.getElementById('modalLatencySlider') as HTMLInputElement;
const modalLatencyDisplay = document.getElementById('modalLatencyDisplay') as HTMLElement;
const dropModeSelect = document.getElementById('dropModeSelect') as HTMLSelectElement;
const sensSlider = document.getElementById('sensSlider') as HTMLInputElement;
const sensVal = document.getElementById('sensVal') as HTMLElement;

// Trainer Elements
const btnMetroSettings = document.getElementById('btnMetroSettings') as HTMLButtonElement;
const currentDropModeDisplay = document.getElementById('currentDropModeDisplay') as HTMLElement;
const sessionInstructions = document.getElementById('sessionInstructions') as HTMLElement;
const instructionIcon = document.getElementById('instructionIcon') as HTMLElement;
const instructionTitle = document.getElementById('instructionTitle') as HTMLElement;
const instructionBody = document.getElementById('instructionBody') as HTMLElement;

const btnTogglePlay = document.getElementById('btnTogglePlay') as HTMLButtonElement;
const bpmSlider = document.getElementById('bpmSlider') as HTMLInputElement;
const bpmValue = document.getElementById('bpmValue') as HTMLElement;
const btnBpmMinus = document.getElementById('btnBpmMinus') as HTMLButtonElement;
const btnBpmPlus = document.getElementById('btnBpmPlus') as HTMLButtonElement;

const dots = [
  document.getElementById('dot1') as HTMLElement,
  document.getElementById('dot2') as HTMLElement,
  document.getElementById('dot3') as HTMLElement,
  document.getElementById('dot4') as HTMLElement,
];
const dropBanner = document.getElementById('dropBanner') as HTMLElement;
const resultBanner = document.getElementById('resultBanner') as HTMLElement;
const canvas = document.getElementById('timingLane') as HTMLCanvasElement;

// Benchmark Card Elements
const tierTitle = document.getElementById('tierTitle') as HTMLElement;
const tierBadge = document.getElementById('tierBadge') as HTMLElement;
const tierDesc = document.getElementById('tierDesc') as HTMLElement;
const scaleNeedle = document.getElementById('scaleNeedle') as HTMLElement;
const needleBubble = document.getElementById('needleBubble') as HTMLElement;

// Stats elements
const statBias = document.getElementById('statBias') as HTMLElement;
const statJitter = document.getElementById('statJitter') as HTMLElement;
const statStreak = document.getElementById('statStreak') as HTMLElement;
const statBestStreak = document.getElementById('statBestStreak') as HTMLElement;
const statAccuracy = document.getElementById('statAccuracy') as HTMLElement;
const btnResetStats = document.getElementById('btnResetStats') as HTMLButtonElement;

// Initialize Audio Context & Hardware Stream
async function ensureAudio(): Promise<{ ctx: AudioContext; stream: MediaStream }> {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
      });
    } catch (err) {
      console.warn('Raw mic constraints rejected, retrying with standard audio:', err);
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }
  return { ctx: audioCtx, stream: micStream };
}

// Setup Timing Visualizer
visualizer = new TimingVisualizer(canvas);

// View Transition Helpers
function transitionToTrainer() {
  viewCalibration.classList.add('hidden');
  viewTrainer.classList.remove('hidden');
  btnOpenSettings.classList.remove('hidden');
  visualizer?.resize();
}

function updateCalibratedOffset(ms: number) {
  calibratedLatencyMs = ms;
  modalLatencySlider.value = ms.toString();
  modalLatencyDisplay.innerText = `${ms} ms`;
  headerOffsetBadge.innerText = `Offset: ${ms}ms`;
  if (metronome) {
    metronome.setLatencyOffsetMs(ms);
  }
}

// Drop Mode Label Management
const dropModeLabels: Record<DropMode, string> = {
  random_10: 'Random (~10% drops)',
  random_25: 'Moderate (~25% drops)',
  random_33: 'Frequent (~33% drops)',
  bar4_silent: 'Bar 4 Silent',
  every4th: 'Every 4th Beat',
  none: 'Continuous (No Drops)',
};

function updateDropModeUI(mode: DropMode) {
  currentDropMode = mode;
  if (currentDropModeDisplay) {
    currentDropModeDisplay.innerText = dropModeLabels[mode] || mode;
  }
  if (dropModeSelect) {
    dropModeSelect.value = mode;
  }
  if (metronome) {
    metronome.setDropMode(mode);
  }
}

// Initialize default mode
updateDropModeUI('random_10');

// 1. HERO CALIBRATION WORKFLOW
async function executeCalibration(
  btn: HTMLButtonElement,
  statusEl: HTMLElement,
  isHero: boolean
) {
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color: var(--accent);">Initializing microphone & audio...</span>';

  try {
    const { ctx, stream } = await ensureAudio();
    calibrator = new AcousticCalibrator(ctx, stream);

    statusEl.innerHTML = '<span style="color: #fbbf24;">Calibrating system... Please keep the room quiet.</span>';

    const result = await calibrator.calibrate(3, (trial, total) => {
      statusEl.innerText = `Testing tone ${trial} of ${total}...`;
    });

    updateCalibratedOffset(result.latencyMs);

    if (isHero) {
      calibSuccessTitle.innerText = `✓ System Calibrated`;
      calibBadge.className = 'badge badge-success';
      calibBadge.innerText = `Calibrated`;
      postCalibActions.classList.remove('hidden');
      statusEl.innerHTML = `<span style="color: #34d399;">System calibration complete (${result.latencyMs}ms offset)!</span>`;
    } else {
      statusEl.innerHTML = `<span style="color: #34d399;">System re-calibrated successfully (${result.latencyMs}ms offset).</span>`;
    }
  } catch (err) {
    console.error('Calibration error:', err);
    statusEl.innerHTML = `<span style="color: #ef4444;">Calibration failed: ${(err as Error).message}. Check microphone permissions.</span>`;
  } finally {
    btn.disabled = false;
  }
}

// Verification Test Runner (Closed-Loop Ground Truth Check)
async function runVerificationTest(statusEl: HTMLElement, autoTrimBtn?: HTMLButtonElement | null) {
  if (autoTrimBtn) autoTrimBtn.classList.add('hidden');
  statusEl.innerHTML = '<span style="color: var(--accent);">Emitting test pulse to verify speaker-to-mic loopback...</span>';

  try {
    const { ctx, stream } = await ensureAudio();
    if (!calibrator) {
      calibrator = new AcousticCalibrator(ctx, stream);
    }

    const res = await calibrator.verifyCalibration(calibratedLatencyMs);
    const sign = res.residualErrorMs > 0 ? '+' : '';

    if (res.passed) {
      statusEl.innerHTML = `<span style="color: #34d399; font-weight: 600;">✓ Verification Passed:</span> Loopback arrival measured at <strong>${res.measuredLatencyMs}ms</strong> (Offset: ${res.calibratedOffsetMs}ms). Residual error is only <strong>${sign}${res.residualErrorMs}ms</strong> (accurate to ±4ms).`;
    } else {
      statusEl.innerHTML = `<span style="color: #fbbf24; font-weight: 600;">⚠️ Discrepancy detected:</span> Measured acoustic arrival is <strong>${res.measuredLatencyMs}ms</strong> (Offset was set to ${res.calibratedOffsetMs}ms &mdash; drift: <strong>${sign}${res.residualErrorMs}ms</strong>).`;
      if (autoTrimBtn) {
        autoTrimBtn.classList.remove('hidden');
        autoTrimBtn.innerText = `Auto-Trim to ${res.measuredLatencyMs}ms`;
        autoTrimBtn.onclick = () => {
          updateCalibratedOffset(res.measuredLatencyMs);
          statusEl.innerHTML = `<span style="color: #34d399;">✓ Offset updated to ${res.measuredLatencyMs}ms (Residual error now 0ms).</span>`;
          autoTrimBtn.classList.add('hidden');
        };
      }
    }
  } catch (err) {
    statusEl.innerHTML = `<span style="color: #ef4444;">Verification failed: ${(err as Error).message}</span>`;
  }
}

btnVerifyCalib?.addEventListener('click', () => {
  if (verifyResultPanel && verifyResultText) {
    verifyResultPanel.classList.remove('hidden');
    runVerificationTest(verifyResultText, btnAutoTrim);
  }
});

btnModalVerify?.addEventListener('click', () => {
  if (modalVerifyResult) {
    modalVerifyResult.classList.remove('hidden');
    runVerificationTest(modalVerifyResult);
  }
});

btnCalibrate.addEventListener('click', () => {
  executeCalibration(btnCalibrate, calibStatus, true);
});

btnContinueToTrainer.addEventListener('click', () => {
  transitionToTrainer();
});

btnSkipCalibration.addEventListener('click', () => {
  updateCalibratedOffset(60);
  transitionToTrainer();
});

// 2. SETTINGS MODAL HANDLERS
function openSettingsModal() {
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

btnOpenSettings.addEventListener('click', openSettingsModal);
btnMetroSettings.addEventListener('click', openSettingsModal);
btnCloseSettings.addEventListener('click', closeSettingsModal);
btnSaveSettings.addEventListener('click', closeSettingsModal);

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    closeSettingsModal();
  }
});

btnModalCalibrate.addEventListener('click', () => {
  executeCalibration(btnModalCalibrate, modalCalibStatus, false);
});

modalLatencySlider.addEventListener('input', () => {
  const val = parseInt(modalLatencySlider.value, 10);
  updateCalibratedOffset(val);
});

dropModeSelect.addEventListener('change', () => {
  updateDropModeUI(dropModeSelect.value as DropMode);
});

sensSlider.addEventListener('input', () => {
  const val = parseFloat(sensSlider.value);
  sensVal.innerText = `${val.toFixed(1)}x`;
  if (clapDetector) {
    clapDetector.setSensitivity(val);
  }
});

// 3. METRONOME CONTROLS
function updateBpm(newBpm: number) {
  const clamped = Math.max(50, Math.min(200, newBpm));
  bpmSlider.value = clamped.toString();
  bpmValue.innerText = `${clamped} BPM`;
  if (metronome) {
    metronome.setBpm(clamped);
  }
}

bpmSlider.addEventListener('input', () => {
  updateBpm(parseInt(bpmSlider.value, 10));
});

btnBpmMinus.addEventListener('click', () => {
  updateBpm(parseInt(bpmSlider.value, 10) - 5);
});

btnBpmPlus.addEventListener('click', () => {
  updateBpm(parseInt(bpmSlider.value, 10) + 5);
});

// 4. METRONOME & CLAP DETECTION SESSION
let isPlaying = false;

async function startSession() {
  const { ctx, stream } = await ensureAudio();

  if (!metronome) {
    metronome = new Metronome(ctx);
    metronome.setBpm(parseInt(bpmSlider.value, 10));
    metronome.setDropMode(currentDropMode);
    metronome.setLatencyOffsetMs(calibratedLatencyMs);

    metronome.onBeat((beat, _measure, isDropped) => {
      dots.forEach((d) => d.classList.remove('active', 'dropped-active'));

      const dot = dots[beat - 1];
      if (dot) {
        if (isDropped) {
          dot.classList.add('dropped-active');
          dropBanner.innerHTML = `⚠️ BEAT ${beat} DROPPED &mdash; CLAP NOW!`;
          instructionIcon.innerText = '⚡';
          instructionTitle.innerText = `Beat ${beat} dropped silent! Keep clapping!`;
          instructionBody.innerText = 'Listening for your clap to test your inner metronome timing...';
        } else {
          dot.classList.add('active');
          dropBanner.innerHTML = '';
        }
      }
    });

    metronome.onEvaluation((evaluation: BeatEvaluation) => {
      sessionStats.addResult(evaluation);
      visualizer?.addClapMarker(evaluation.offsetMs, evaluation.accuracy);
      renderEvaluationResult(evaluation);
      updateStatsDisplay();
    });
  }

  if (!clapDetector) {
    clapDetector = new ClapDetector(ctx, stream);
    clapDetector.setSensitivity(parseFloat(sensSlider.value));
    clapDetector.onLevel((lvl) => {
      visualizer?.setLevel(lvl);
    });
    clapDetector.onClap((event) => {
      metronome?.processClap(event.timestamp);
    });
  }

  clapDetector.start();
  metronome.start();
  isPlaying = true;

  // Informative instruction update
  sessionInstructions.classList.add('playing');
  instructionIcon.innerText = '🎧';
  instructionTitle.innerText = 'Metronome running — clap along in sync with the clicks!';
  instructionBody.innerText = 'Lock into the beat. Keep clapping steadily when random clicks go silent — the metronome will tell you how on-beat you are!';

  btnTogglePlay.className = 'btn btn-danger btn-large';
  btnTogglePlay.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
    Stop Metronome
  `;
}

function stopSession() {
  if (metronome) {
    metronome.stop();
  }
  if (clapDetector) {
    clapDetector.stop();
  }
  isPlaying = false;
  dots.forEach((d) => d.classList.remove('active', 'dropped-active'));
  dropBanner.innerHTML = '';

  // Reset instruction text
  sessionInstructions.classList.remove('playing');
  instructionIcon.innerText = '👏';
  instructionTitle.innerText = 'Clap along with each click!';
  instructionBody.innerText = 'Keep clapping steadily in rhythm. When clicks randomly drop, keep your tempo — the metronome will measure how on-beat you are.';

  btnTogglePlay.className = 'btn btn-success btn-large';
  btnTogglePlay.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
    Start Metronome
  `;
}

btnTogglePlay.addEventListener('click', () => {
  if (isPlaying) {
    stopSession();
  } else {
    startSession().catch((err) => {
      console.error('Failed to start session:', err);
      alert(`Could not start audio: ${err.message}`);
    });
  }
});

function renderEvaluationResult(ev: BeatEvaluation) {
  if (ev.accuracy === 'missed') {
    resultBanner.innerHTML = `<span style="color: #ef4444;">❌ MISSED: Beat ${ev.beatNumber} dropped, but no clap was registered</span>`;
    instructionIcon.innerText = '❌';
    instructionTitle.innerText = 'No clap detected on dropped beat';
    instructionBody.innerText = 'Be sure to clap audibly on every beat, including silent ones.';
    return;
  }

  const sign = ev.offsetMs > 0 ? '+' : '';
  const dir = ev.offsetMs < 0 ? 'rushing' : ev.offsetMs > 0 ? 'dragging' : 'dead center';
  const absMs = Math.abs(ev.offsetMs);

  if (absMs <= 12) {
    resultBanner.innerHTML = `<span style="color: #10b981;">🌟 PRO POCKET: ${sign}${ev.offsetMs} ms (${dir}) &bull; Jazz Master precision</span>`;
    instructionIcon.innerText = '🌟';
    instructionTitle.innerText = `Elite Pocket! (${sign}${ev.offsetMs} ms)`;
    instructionBody.innerText = `Within ±12ms: Elite jazz rhythm section standard (Friberg & Sundström study). Impeccable timing!`;
  } else if (absMs <= 22) {
    resultBanner.innerHTML = `<span style="color: #38bdf8;">🎵 TRAINED MUSICIAN: ${sign}${ev.offsetMs} ms (${dir}) &bull; Excellent</span>`;
    instructionIcon.innerText = '🎵';
    instructionTitle.innerText = `Trained Musician Timing (${sign}${ev.offsetMs} ms)`;
    instructionBody.innerText = `Within ±22ms: Consistent with active performing musicians. Great internal pocket!`;
  } else if (absMs <= 35) {
    resultBanner.innerHTML = `<span style="color: #fbbf24;">🎸 GOOD: ${sign}${ev.offsetMs} ms (${dir}) &bull; Solid groove</span>`;
    instructionIcon.innerText = '🎸';
    instructionTitle.innerText = `Good Timing! (${sign}${ev.offsetMs} ms)`;
    instructionBody.innerText = `Within ±35ms: Solid rhythm foundation. Ahead of typical untrained listeners.`;
  } else if (absMs <= 50) {
    resultBanner.innerHTML = `<span style="color: #f97316;">🥁 TYPICAL NON-MUSICIAN: ${sign}${ev.offsetMs} ms (${dir})</span>`;
    instructionIcon.innerText = '🥁';
    instructionTitle.innerText = `Typical Human Variance (${sign}${ev.offsetMs} ms)`;
    instructionBody.innerText = ev.offsetMs < 0
      ? `You rushed ahead by ${absMs}ms. Non-musicians frequently anticipate the click—stay relaxed and let the pulse arrive.`
      : `You dragged behind by ${absMs}ms. Non-musicians frequently hesitate on silent drops—anticipate the pulse with confidence.`;
  } else {
    resultBanner.innerHTML = `<span style="color: #ef4444;">⚠️ POOR: ${sign}${ev.offsetMs} ms (${dir}) &bull; Significant drift</span>`;
    instructionIcon.innerText = '⚠️';
    instructionTitle.innerText = `Timing Drift: ${sign}${ev.offsetMs} ms (${dir})`;
    instructionBody.innerText = `More than 50ms off the beat. Focus closely on locking into the audible clicks before the drops.`;
  }
}

function updateStatsDisplay() {
  const summary = sessionStats.getSummary();

  if (summary.hits === 0 && summary.misses === 0) {
    statBias.innerText = '--';
    statJitter.innerText = '--';
    statAccuracy.innerText = '--';
  } else {
    const sign = summary.meanOffsetMs > 0 ? '+' : '';
    statBias.innerText = `${sign}${summary.meanOffsetMs} ms`;
    statBias.style.color = Math.abs(summary.meanOffsetMs) <= 12 ? '#10b981' : Math.abs(summary.meanOffsetMs) <= 25 ? '#38bdf8' : Math.abs(summary.meanOffsetMs) <= 40 ? '#fbbf24' : '#ef4444';

    statJitter.innerText = `±${summary.stdDevMs} ms`;
    statJitter.style.color = summary.stdDevMs <= 12 ? '#10b981' : summary.stdDevMs <= 18 ? '#38bdf8' : summary.stdDevMs <= 28 ? '#fbbf24' : '#ef4444';

    const totalEvaluated = summary.hits + summary.misses;
    const accurateCount = summary.perfectCount + summary.goodCount;
    const accPct = totalEvaluated > 0 ? Math.round((accurateCount / totalEvaluated) * 100) : 0;
    statAccuracy.innerText = `${accPct}%`;
  }

  statStreak.innerText = summary.streak.toString();
  statBestStreak.innerText = summary.bestStreak.toString();

  // Update Musician Benchmark Tier & Scale
  const tier = evaluateMusicianTier(summary.stdDevMs, summary.hits);
  if (tierTitle) tierTitle.innerText = tier.title;
  if (tierBadge) {
    tierBadge.innerText = tier.badgeLabel;
    tierBadge.style.color = tier.badgeColor;
    tierBadge.style.borderColor = tier.badgeColor;
  }
  if (tierDesc) {
    tierDesc.innerHTML = `${tier.description} <strong style="color: var(--text-main); display: block; margin-top: 4px;">${tier.comparison}</strong>`;
  }

  // Update Scale needle position (0 to 60ms scale)
  if (scaleNeedle && needleBubble) {
    if (summary.hits >= 3) {
      scaleNeedle.classList.remove('hidden');
      const maxMs = 60;
      const pct = Math.min(97, Math.max(3, (summary.stdDevMs / maxMs) * 100));
      scaleNeedle.style.left = `${pct}%`;
      needleBubble.innerText = `You: ±${summary.stdDevMs}ms`;
    } else {
      scaleNeedle.classList.add('hidden');
    }
  }
}

btnResetStats.addEventListener('click', () => {
  sessionStats.reset();
  updateStatsDisplay();
  resultBanner.innerHTML = '<span style="color: var(--text-muted); font-size: 1rem; font-weight: normal;">Session stats reset. Clap along with the groove!</span>';
});
