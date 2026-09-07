/**
 * Visualizer: Canvas timing lane, hit marker animations, audio level meter, and session statistics.
 */

import { BeatEvaluation } from '../audio/metronome';

interface AnimatedMarker {
  offsetMs: number;
  accuracy: BeatEvaluation['accuracy'];
  timestamp: number; // Date.now()
  alpha: number;
}

export class TimingVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private markers: AnimatedMarker[] = [];
  private currentLevel = 0;
  private animFrameId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas 2d context');
    this.ctx = ctx;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.startRenderLoop();
  }

  public resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  public setLevel(peak: number) {
    // Smooth level meter
    this.currentLevel = Math.max(peak, this.currentLevel * 0.88);
  }

  public addClapMarker(offsetMs: number, accuracy: BeatEvaluation['accuracy']) {
    this.markers.push({
      offsetMs,
      accuracy,
      timestamp: Date.now(),
      alpha: 1.0,
    });
    // Keep max 20 markers
    if (this.markers.length > 20) {
      this.markers.shift();
    }
  }

  private startRenderLoop() {
    const render = () => {
      this.draw();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  public destroy() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
    }
  }

  private draw() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#0f172a');
    bgGrad.addColorStop(1, '#020617');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const centerX = w / 2;
    const scale = w / 200; // Total display span: -100ms to +100ms (200ms total)

    // Zone: Perfect (+/- 15ms)
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.fillRect(centerX - 15 * scale, 0, 30 * scale, h);

    // Zone: Good (+/- 35ms)
    ctx.fillStyle = 'rgba(234, 179, 8, 0.06)';
    ctx.fillRect(centerX - 35 * scale, 0, 70 * scale, h);

    // Grid lines for reference (-75, -50, -25, 0, +25, +50, +75)
    const tickOffsets = [-75, -50, -25, 0, 25, 50, 75];
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#64748b';

    for (const tick of tickOffsets) {
      const x = centerX + tick * scale;
      ctx.beginPath();
      ctx.moveTo(x, 15);
      ctx.lineTo(x, h - 15);
      ctx.stroke();

      ctx.fillText(tick === 0 ? 'TARGET (0ms)' : `${tick > 0 ? '+' : ''}${tick}ms`, x, h - 4);
    }

    // Directional labels
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.fillText('← EARLY (Rushing)', 16, 20);
    ctx.textAlign = 'right';
    ctx.fillText('LATE (Dragging) →', w - 16, 20);

    // Center target line
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, h);
    ctx.stroke();

    // Render animated markers
    const now = Date.now();
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      const age = now - m.timestamp;
      const lifespan = 2800; // 2.8s fade
      m.alpha = Math.max(0, 1 - age / lifespan);

      if (m.alpha <= 0) {
        this.markers.splice(i, 1);
        continue;
      }

      // Clamp offset to display range (-100 to 100)
      const clampedOffset = Math.max(-95, Math.min(95, m.offsetMs));
      const x = centerX + clampedOffset * scale;

      let color = '#38bdf8'; // blue
      let badgeColor = 'rgba(56, 189, 248, 0.9)';
      if (m.accuracy === 'perfect') {
        color = '#10b981'; // emerald
        badgeColor = 'rgba(16, 185, 129, 0.95)';
      } else if (m.accuracy === 'good') {
        color = '#f59e0b'; // amber
        badgeColor = 'rgba(245, 158, 11, 0.95)';
      } else if (m.accuracy === 'early' || m.accuracy === 'late') {
        color = '#ef4444'; // red
        badgeColor = 'rgba(239, 68, 68, 0.95)';
      }

      ctx.save();
      ctx.globalAlpha = m.alpha;

      // Vertical indicator beam
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, 25);
      ctx.lineTo(x, h - 25);
      ctx.stroke();

      // Hit point diamond
      ctx.fillStyle = badgeColor;
      ctx.beginPath();
      ctx.arc(x, h / 2, 8, 0, 2 * Math.PI);
      ctx.fill();

      // Offset text badge
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      const text = `${m.offsetMs > 0 ? '+' : ''}${m.offsetMs}ms`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, x, h / 2 - 14);

      ctx.restore();
    }

    // Mini Live Mic Level bar at top
    const micMeterWidth = 120;
    const micMeterHeight = 4;
    const micX = centerX - micMeterWidth / 2;
    const micY = 6;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(micX, micY, micMeterWidth, micMeterHeight);
    
    const fillWidth = Math.min(micMeterWidth, this.currentLevel * micMeterWidth * 3);
    ctx.fillStyle = this.currentLevel > 0.4 ? '#ef4444' : '#10b981';
    ctx.fillRect(micX, micY, fillWidth, micMeterHeight);
  }
}

export class SessionStats {
  private offsets: number[] = [];
  private hits = 0;
  private misses = 0;
  private currentStreak = 0;
  private bestStreak = 0;

  public addResult(evaluation: BeatEvaluation) {
    if (evaluation.accuracy === 'missed') {
      this.misses++;
      this.currentStreak = 0;
      return;
    }

    this.hits++;
    this.offsets.push(evaluation.offsetMs);

    if (evaluation.accuracy === 'perfect' || evaluation.accuracy === 'good') {
      this.currentStreak++;
      if (this.currentStreak > this.bestStreak) {
        this.bestStreak = this.currentStreak;
      }
    } else {
      this.currentStreak = 0;
    }
  }

  public reset() {
    this.offsets = [];
    this.hits = 0;
    this.misses = 0;
    this.currentStreak = 0;
    this.bestStreak = 0;
  }

  public getSummary() {
    if (this.offsets.length === 0) {
      return {
        hits: this.hits,
        misses: this.misses,
        meanOffsetMs: 0,
        stdDevMs: 0,
        streak: this.currentStreak,
        bestStreak: this.bestStreak,
        perfectCount: 0,
        goodCount: 0,
        earlyCount: 0,
        lateCount: 0,
      };
    }

    const n = this.offsets.length;
    const sum = this.offsets.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    const variance = this.offsets.reduce((acc, val) => acc + (val - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    let perfectCount = 0;
    let goodCount = 0;
    let earlyCount = 0;
    let lateCount = 0;

    for (const off of this.offsets) {
      if (Math.abs(off) <= 15) perfectCount++;
      else if (Math.abs(off) <= 35) goodCount++;
      else if (off < -35) earlyCount++;
      else lateCount++;
    }

    return {
      hits: this.hits,
      misses: this.misses,
      meanOffsetMs: Math.round(mean),
      stdDevMs: Math.round(stdDev),
      streak: this.currentStreak,
      bestStreak: this.bestStreak,
      perfectCount,
      goodCount,
      earlyCount,
      lateCount,
    };
  }
}

export interface MusicianTier {
  id: 'pro' | 'trained' | 'good' | 'typical' | 'erratic' | 'pending';
  title: string;
  badgeLabel: string;
  badgeColor: string;
  description: string;
  comparison: string;
}

export function evaluateMusicianTier(stdDevMs: number, hits: number): MusicianTier {
  if (hits < 3) {
    const remaining = Math.max(0, 3 - hits);
    return {
      id: 'pending',
      title: 'Evaluating rhythm precision...',
      badgeLabel: `Need ${remaining} more ${remaining === 1 ? 'clap' : 'claps'}`,
      badgeColor: '#94a3b8',
      description: 'Clap on silent dropped beats. After 3 claps, we calculate your jitter (standard deviation) against scientific benchmarks.',
      comparison: 'Gathering timing samples...',
    };
  }

  if (stdDevMs <= 12) {
    return {
      id: 'pro',
      title: '🌟 Elite Jazz / Pro Pocket',
      badgeLabel: 'Pro Tier (Top 1%)',
      badgeColor: '#10b981',
      description: `Incredible clock stability (Jitter: ±${stdDevMs}ms). Matches elite jazz rhythm sections and top-tier studio drummers (Friberg & Sundström study).`,
      comparison: 'Faster & tighter than 98% of people tested in rhythmic studies.',
    };
  }

  if (stdDevMs <= 18) {
    return {
      id: 'trained',
      title: '🎵 Trained Musician',
      badgeLabel: 'Expert Musician',
      badgeColor: '#38bdf8',
      description: `High temporal precision (Jitter: ±${stdDevMs}ms). Typical of conservatory musicians and seasoned gigging performers.`,
      comparison: 'Well ahead of untrained listeners; strong internal timekeeper.',
    };
  }

  if (stdDevMs <= 28) {
    return {
      id: 'good',
      title: '🎸 Solid Groove / Good',
      badgeLabel: 'Good Timing',
      badgeColor: '#fbbf24',
      description: `Reliable rhythm stability (Jitter: ±${stdDevMs}ms). Easily locks into tempo with a band; above average accuracy.`,
      comparison: 'Outperforms typical non-musicians; solid rhythm foundation.',
    };
  }

  if (stdDevMs <= 42) {
    return {
      id: 'typical',
      title: '🥁 Typical Non-Musician',
      badgeLabel: 'Typical Human Baseline',
      badgeColor: '#f97316',
      description: `Natural timing variance (Jitter: ±${stdDevMs}ms). Typical human baseline without rhythmic training; tempo tends to drift when the click stops.`,
      comparison: 'Average synchronization accuracy for casual listeners.',
    };
  }

  return {
    id: 'erratic',
    title: '⚠️ Inconsistent / Needs Practice',
    badgeLabel: 'Developing',
    badgeColor: '#ef4444',
    description: `High timing variance (Jitter: ±${stdDevMs}ms). Claps wander early and late. Focus on feeling the pulse before speeding up.`,
    comparison: 'Below typical baseline; regular practice with silent drops will train this rapidly.',
  };
}

