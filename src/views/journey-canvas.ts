/**
 * The Journey backdrop: a hand-rolled canvas particle field. One particle per
 * project *visit* in the command history — real data, not decoration. As the
 * reader scrolls, the field morphs between scenes (a single seed → a timeline
 * rain → a dense cloud → project constellations → the agent fleet → a calm
 * starfield). No chart/animation library: a small state machine that lerps
 * every particle toward a per-scene target each frame.
 *
 * Zero dependencies, matches the app's zero-framework ethos, and deliberately
 * cheap: ~1.6k particles, one fill per particle per frame, full clear (no
 * per-frame allocations). Respects prefers-reduced-motion.
 */

export interface VisitSeed {
  t: number; // birth time, normalized 0..1 across the whole span
  projectRank: number; // 0 = busiest project … (for color + constellation well)
  weight: number; // 0..1, relative size (lines typed that visit)
}

export interface FleetBucket {
  color: [number, number, number];
  share: number; // 0..1 of the fleet
}

export type SceneId =
  | "seed"
  | "accumulate"
  | "cloud"
  | "constellation"
  | "fleet"
  | "starfield";

interface Particle {
  t: number;
  weight: number;
  well: number; // constellation well index
  bucket: number; // fleet bucket index
  j1: number; // stable jitters
  j2: number;
  j3: number;
  base: [number, number, number]; // project color
  // runtime state (normalized 0..1 space)
  x: number;
  y: number;
  r: number;
  a: number;
  cr: number;
  cg: number;
  cb: number;
}

const PROJECT_RAMP: [number, number, number][] = [
  [0xc9, 0x8a, 0x3c], // accent gold
  [0x5a, 0xa9, 0xe6], // blue
  [0xb0, 0x72, 0xd6], // purple
  [0x4f, 0xc2, 0x4f], // green
  [0x22, 0xb5, 0xc4], // cyan
  [0xf2, 0xd0, 0x35], // yellow
  [0xe5, 0x66, 0x2c], // orange
  [0xe5, 0x36, 0x6e], // rose
];
const DIM: [number, number, number] = [0x5b, 0x64, 0x72];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export interface JourneyField {
  setScene(scene: SceneId, progress: number): void;
  setVisible(v: boolean): void;
  resize(): void;
  destroy(): void;
}

export function createJourneyField(
  canvas: HTMLCanvasElement,
  seeds: VisitSeed[],
  fleet: FleetBucket[],
): JourneyField {
  const ctx = canvas.getContext("2d")!;
  const reduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Build particles with stable per-particle randomness.
  const rng = mulberry32(0x9e3779b9);
  const particles: Particle[] = seeds.map((s) => {
    const base = PROJECT_RAMP[Math.min(s.projectRank, PROJECT_RAMP.length - 1)] ?? DIM;
    const col = s.projectRank < PROJECT_RAMP.length ? base : DIM;
    // Assign a fleet bucket by weighted share (stable per particle).
    let roll = rng();
    let bucket = 0;
    for (let i = 0; i < fleet.length; i++) {
      roll -= fleet[i].share;
      if (roll <= 0) {
        bucket = i;
        break;
      }
      bucket = i;
    }
    return {
      t: s.t,
      weight: s.weight,
      well: s.projectRank,
      bucket,
      j1: rng(),
      j2: rng(),
      j3: rng(),
      base: col,
      x: 0.5,
      y: 0.5,
      r: 1,
      a: 0,
      cr: col[0],
      cg: col[1],
      cb: col[2],
    };
  });

  const N = particles.length;
  const WELLS = Math.min(8, PROJECT_RAMP.length);

  let scene: SceneId = "seed";
  let progress = 0;
  let visible = true;
  let curOpacity = 0;
  let dpr = 1;
  let W = 1;
  let H = 1;
  let raf = 0;
  let t0 = 0;

  function resize(): void {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Per-scene target for one particle, in normalized 0..1 space.
  function target(p: Particle, time: number): { x: number; y: number; r: number; a: number; col: [number, number, number] } {
    const drift = reduced ? 0 : 1;
    switch (scene) {
      case "seed": {
        // Day one: a single bright seed; the rest barely-there sparks nearby.
        const isFirst = p.t < 0.012;
        const ang = p.j1 * Math.PI * 2;
        const rad = isFirst ? 0 : 0.04 + p.j2 * 0.5;
        return {
          x: 0.5 + Math.cos(ang) * rad * (0.6 + 0.4 * Math.sin(time * 0.4 + p.j3 * 6)),
          y: 0.5 + Math.sin(ang) * rad * 0.5,
          r: isFirst ? 4.5 + Math.sin(time * 2) * 1.2 : 1.1,
          a: isFirst ? 1 : 0.06 + p.j2 * 0.05,
          col: isFirst ? PROJECT_RAMP[0] : DIM,
        };
      }
      case "accumulate": {
        // Timeline rain: time sweeps left→right as you scroll; particles land
        // on a time axis and only appear once their birth time is reached.
        const reveal = clamp01(progress * 1.05);
        const shown = p.t <= reveal;
        const x = 0.06 + p.t * 0.88;
        const band = 0.22 + p.j1 * 0.56;
        const wob = drift * 0.012 * Math.sin(time * 0.6 + p.j2 * 9);
        return {
          x,
          y: band + wob,
          r: shown ? 1.4 + p.weight * 3.2 : 1,
          a: shown ? 0.5 + p.weight * 0.5 : 0,
          col: p.base,
        };
      }
      case "cloud": {
        // A dense breathing cloud filling the field — the sheer scale.
        const ang = p.j1 * Math.PI * 2;
        const rad = Math.sqrt(p.j2) * (0.34 + 0.05 * Math.sin(time * 0.5 + p.j3 * 6) * drift);
        const breath = 1 + 0.06 * Math.sin(time * 0.7) * drift;
        return {
          x: 0.5 + Math.cos(ang) * rad * 1.5 * breath,
          y: 0.5 + Math.sin(ang) * rad * breath,
          r: 1.3 + p.weight * 2.4,
          a: 0.4 + p.weight * 0.45,
          col: p.base,
        };
      }
      case "constellation": {
        // Particles gather into project wells — the work spreading across repos.
        const w = p.well % WELLS;
        const cols = 4;
        const cx = 0.16 + (w % cols) * 0.227;
        const cy = 0.3 + Math.floor(w / cols) * 0.4;
        const ang = p.j1 * Math.PI * 2 + time * 0.15 * drift * (p.well < WELLS ? 1 : 0);
        const spread = p.well < WELLS ? 0.018 + p.j2 * 0.075 : 0.05 + p.j2 * 0.4;
        return {
          x: p.well < WELLS ? cx + Math.cos(ang) * spread * 1.4 : 0.5 + (p.j1 - 0.5) * 1.3,
          y: p.well < WELLS ? cy + Math.sin(ang) * spread : 0.5 + (p.j2 - 0.5) * 0.9,
          r: 1.3 + p.weight * 2.6,
          a: p.well < WELLS ? 0.55 + p.weight * 0.45 : 0.12,
          col: p.well < WELLS ? p.base : DIM,
        };
      }
      case "fleet": {
        // The climax: particles recolor to the agent palette and orbit a row of
        // swarm centers, each center a subagent type sized by its share.
        const nB = Math.max(1, fleet.length);
        const b = p.bucket % nB;
        const cx = (b + 0.5) / nB;
        const cy = 0.5 + (p.j3 - 0.5) * 0.06;
        const orbit = 0.05 + p.j2 * 0.11;
        const spin = time * (0.5 + p.j1 * 0.7) * drift + p.j1 * Math.PI * 2;
        const fc = fleet[b]?.color ?? DIM;
        return {
          x: cx + Math.cos(spin) * orbit * 0.85,
          y: cy + Math.sin(spin) * orbit,
          r: 1.5 + p.weight * 2.4,
          a: 0.6 + p.weight * 0.4,
          col: fc,
        };
      }
      case "starfield":
      default: {
        // Hand-off: a calm, low field that recedes behind the interactive map.
        return {
          x: p.j1,
          y: 0.1 + p.j2 * 0.8,
          r: 1.1,
          a: 0.16 + p.j3 * 0.12,
          col: DIM,
        };
      }
    }
  }

  function frame(now: number): void {
    if (!t0) t0 = now;
    const time = (now - t0) / 1000;
    // Ease the whole field in/out so scene text can own the screen at the edges.
    const wantOp = visible ? 1 : 0;
    curOpacity = lerp(curOpacity, wantOp, 0.08);

    ctx.clearRect(0, 0, W, H);
    if (curOpacity > 0.01) {
      const lf = reduced ? 1 : 0.12; // lerp factor toward target
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < N; i++) {
        const p = particles[i];
        const tg = target(p, time);
        p.x = lerp(p.x, tg.x, lf);
        p.y = lerp(p.y, tg.y, lf);
        p.r = lerp(p.r, tg.r, lf);
        p.a = lerp(p.a, tg.a, lf);
        p.cr = lerp(p.cr, tg.col[0], lf);
        p.cg = lerp(p.cg, tg.col[1], lf);
        p.cb = lerp(p.cb, tg.col[2], lf);
        const a = p.a * curOpacity;
        if (a < 0.01) continue;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${p.cr | 0},${p.cg | 0},${p.cb | 0},${a.toFixed(3)})`;
        ctx.arc(p.x * W, p.y * H, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }
    raf = requestAnimationFrame(frame);
  }

  resize();
  raf = requestAnimationFrame(frame);

  return {
    setScene(s: SceneId, prog: number): void {
      scene = s;
      progress = easeInOut(clamp01(prog));
    },
    setVisible(v: boolean): void {
      visible = v;
    },
    resize,
    destroy(): void {
      cancelAnimationFrame(raf);
    },
  };
}
