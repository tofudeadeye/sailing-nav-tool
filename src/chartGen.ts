import { createNoise2D, type Noise2D } from './noise.ts';
import { SVG_W, SVG_H, latLonToSVG, CHART_BOUNDS } from './coords.ts';
import compassOuterSvg from '../compass-outer.svg?raw';
import compassInnerSvg from '../compass-inner.svg?raw';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LandmarkType = 'lighthouse' | 'church' | 'mast' | 'tower' | 'wreck' | 'rock';

export interface LightSector {
  fromDeg: number;   // true bearing FROM the lighthouse (0 = North, clockwise)
  toDeg: number;
  color: 'white' | 'red' | 'green';
}

export interface Landmark {
  type: LandmarkType;
  x: number;    // SVG space
  y: number;
  name: string;
  sectors?: LightSector[];  // lighthouses only
}

export interface Sounding {
  x: number;
  y: number;
  depth: number;
}

export interface ContourPoint {
  x: number;
  y: number;
}

export type ContourSegment = [ContourPoint, ContourPoint];

export interface Shoal {
  x: number;
  y: number;
  r: number;
}

export type BuoySide = 'port' | 'starboard';
export type CardinalDirection = 'north' | 'south' | 'east' | 'west';
export type SafeWaterMark = { x: number; y: number; name: string };
export type IsolatedDanger = { x: number; y: number; name: string };

export interface ChannelBuoy {
  x: number;
  y: number;
  side: BuoySide;
}

export interface CardinalBuoy {
  x: number;
  y: number;
  type: CardinalDirection;
  name: string;
}

export interface Harbour {
  entrance: { x: number; y: number };
  portPier:  { x: number; y: number };
  stbdPier:  { x: number; y: number };
  portInner: { x: number; y: number };
  stbdInner: { x: number; y: number };
  buoys: ChannelBuoy[];
  name: string;
}

export interface CompassRose {
  x: number;
  y: number;
  r: number;
}

export interface Anchorage {
  x: number;
  y: number;
  name: string;
}

/** Depth function: returns depth in metres, or -1 if the point is on land. */
export type DepthFn = (x: number, y: number) => number;

type CoastAxis = 'vertical' | 'horizontal';
type WaterSide = 'left' | 'right' | 'top' | 'bottom';

export interface CoastConfig {
  axis: CoastAxis;
  waterSide: WaterSide;
  baseOffset: number; // fraction along the perpendicular axis where coast sits
}

export interface ChartData {
  seed: number;
  variation: number;     // absolute value in degrees
  variationDir: 'E' | 'W'; // East or West
  coastPts: Array<{ x: number; y: number }>;
  islands: Array<{ poly: Array<{ x: number; y: number }>; name: string }>;
  cfg: CoastConfig;
  depthFn: DepthFn;
  soundings: Sounding[];
  contours: Record<number, ContourSegment[]>;
  shoals: Shoal[];
  landmarks: Landmark[];
  harbour: Harbour;
  cardinalBuoys: CardinalBuoy[];
  compassRose: CompassRose;
  anchorages: Anchorage[];
}

// ── Seeded PRNG ───────────────────────────────────────────────────────────────

function makeRNG(seed: number): () => number {
  let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
  return (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ── Coastline ─────────────────────────────────────────────────────────────────

function buildCoastlinePoints(
  noise: Noise2D,
  cfg: CoastConfig,
): Array<{ x: number; y: number }> {
  const STEPS = 400;
  const pts: Array<{ x: number; y: number }> = [];

  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const n1 = noise(t * 3, 0.5) * 0.15;
    const n2 = noise(t * 7, 1.5) * 0.06;
    const n3 = noise(t * 15, 3.0) * 0.025;
    const wobble = n1 + n2 + n3 + 0.05 * Math.sin(t * Math.PI * 2.5);

    if (cfg.axis === 'vertical') {
      // baseOffset = water fraction; coast x = waterFrac if waterSide='left', else 1-waterFrac
      const coastFrac = cfg.waterSide === 'left' ? cfg.baseOffset : 1 - cfg.baseOffset;
      const raw = SVG_W * (coastFrac + wobble);
      pts.push({
        x: Math.max(SVG_W * 0.12, Math.min(SVG_W * 0.88, raw)),
        y: t * SVG_H,
      });
    } else {
      const coastFrac = cfg.waterSide === 'top' ? cfg.baseOffset : 1 - cfg.baseOffset;
      const raw = SVG_H * (coastFrac + wobble);
      pts.push({
        x: t * SVG_W,
        y: Math.max(SVG_H * 0.12, Math.min(SVG_H * 0.88, raw)),
      });
    }
  }

  return pts;
}

// ── Depth field ───────────────────────────────────────────────────────────────

function buildDepthField(
  coastPts: Array<{ x: number; y: number }>,
  noise: Noise2D,
  cfg: CoastConfig,
  islands: Array<{ poly: Array<{ x: number; y: number }>; name: string }>,
): DepthFn {
  const maxIdx = coastPts.length - 3;

  // Build lookup: for vertical axis, lookup coast x by row; for horizontal, coast y by col
  const lookupV = new Float32Array(SVG_H + 1);
  const lookupH = new Float32Array(SVG_W + 1);

  if (cfg.axis === 'vertical') {
    for (let yi = 0; yi <= SVG_H; yi++) {
      const idx = Math.min(Math.round((yi / SVG_H) * maxIdx), maxIdx);
      lookupV[yi] = coastPts[idx]!.x;
    }
  } else {
    for (let xi = 0; xi <= SVG_W; xi++) {
      const idx = Math.min(Math.round((xi / SVG_W) * maxIdx), maxIdx);
      lookupH[xi] = coastPts[idx]!.y;
    }
  }

  const pointInIsland = (px: number, py: number): boolean => {
    for (const { poly } of islands) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i]!.x, yi = poly[i]!.y;
        const xj = poly[j]!.x, yj = poly[j]!.y;
        const intersect = ((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };

  return (x: number, y: number): number => {
    // Island land check first
    if (pointInIsland(x, y)) return -1;

    let dist: number;
    if (cfg.axis === 'vertical') {
      const yi = Math.max(0, Math.min(SVG_H, Math.round(y)));
      const coastX = lookupV[yi]!;
      dist = cfg.waterSide === 'left' ? coastX - x : x - coastX;
    } else {
      const xi = Math.max(0, Math.min(SVG_W, Math.round(x)));
      const coastY = lookupH[xi]!;
      dist = cfg.waterSide === 'top' ? coastY - y : y - coastY;
    }

    if (dist <= 0) return -1;
    const maxDist = cfg.axis === 'vertical' ? SVG_W * cfg.baseOffset : SVG_H * cfg.baseOffset;
    const base = Math.min(60, (dist / maxDist) * 70);
    const n = noise(x / 300, y / 300) * 8;
    return Math.max(2, base + n);
  };
}

// ── Islands ───────────────────────────────────────────────────────────────────

const ISLAND_NAME_PARTS = {
  prefix: ['North', 'South', 'East', 'West', 'Great', 'Little', 'Black', 'White', 'Red', 'Grey', 'Low', 'High'],
  root:   ['Heron', 'Gannet', 'Kelp', 'Tern', 'Gull', 'Skerry', 'Anvil', 'Seal', 'Wreck', 'Cairn', 'Fern', 'Crow'],
  suffix: ['Island', 'Isle', 'Rock', 'Islet', 'Bank', 'Cay', 'Key'],
};

function islandName(rng: () => number): string {
  const usePrefix = rng() < 0.45;
  const prefix = usePrefix ? ISLAND_NAME_PARTS.prefix[Math.floor(rng() * ISLAND_NAME_PARTS.prefix.length)]! + ' ' : '';
  const root = ISLAND_NAME_PARTS.root[Math.floor(rng() * ISLAND_NAME_PARTS.root.length)]!;
  const suffix = ' ' + ISLAND_NAME_PARTS.suffix[Math.floor(rng() * ISLAND_NAME_PARTS.suffix.length)]!;
  return prefix + root + suffix;
}

function buildIslands(
  noise: Noise2D,
  rng: () => number,
  cfg: CoastConfig,
  coastPts: Array<{ x: number; y: number }>,
): Array<{ poly: Array<{ x: number; y: number }>; name: string }> {
  const islands: Array<{ poly: Array<{ x: number; y: number }>; name: string }> = [];
  const count = 2 + Math.floor(rng() * 3); // 2–4 islands

  // Build a fast coast lookup to check if a point is in water
  const maxIdx = coastPts.length - 3;
  const lookupV = new Float32Array(SVG_H + 1);
  const lookupH = new Float32Array(SVG_W + 1);
  if (cfg.axis === 'vertical') {
    for (let yi = 0; yi <= SVG_H; yi++) {
      const idx = Math.min(Math.round((yi / SVG_H) * maxIdx), maxIdx);
      lookupV[yi] = coastPts[idx]!.x;
    }
  } else {
    for (let xi = 0; xi <= SVG_W; xi++) {
      const idx = Math.min(Math.round((xi / SVG_W) * maxIdx), maxIdx);
      lookupH[xi] = coastPts[idx]!.y;
    }
  }

  const isWater = (x: number, y: number): boolean => {
    if (x < 0 || x > SVG_W || y < 0 || y > SVG_H) return false;
    if (cfg.axis === 'vertical') {
      const coastX = lookupV[Math.round(Math.min(y, SVG_H))]!;
      return cfg.waterSide === 'left' ? x < coastX : x > coastX;
    } else {
      const coastY = lookupH[Math.round(Math.min(x, SVG_W))]!;
      return cfg.waterSide === 'top' ? y < coastY : y > coastY;
    }
  };

  // Water region: place centre well inside water, away from coast and edges
  const margin = 160;
  const coastClearance = 200; // keep islands away from main coast

  for (let attempt = 0; attempt < 400 && islands.length < count; attempt++) {
    const cx = margin + rng() * (SVG_W - margin * 2);
    const cy = margin + rng() * (SVG_H - margin * 2);

    // Centre must be in water
    if (!isWater(cx, cy)) continue;

    // Must be far enough from existing islands
    if (islands.some(({ poly: isl }) => {
      const ic = isl[Math.floor(isl.length / 2)]!;
      return Math.hypot(ic.x - cx, ic.y - cy) < 280;
    })) continue;

    // Build island polygon with noise
    const r = 55 + rng() * 70;
    const SIDES = 24;
    const poly: Array<{ x: number; y: number }> = [];
    let valid = true;

    for (let i = 0; i < SIDES; i++) {
      const angle = (i / SIDES) * Math.PI * 2;
      const nr = r * (0.65 + noise(cx / 400 + Math.cos(angle) * 0.6, cy / 400 + Math.sin(angle) * 0.6) * 0.5 + 0.15);
      const px = cx + Math.cos(angle) * nr;
      const py = cy + Math.sin(angle) * nr;

      // Every vertex of the island must be in water (not on land)
      if (!isWater(px, py)) { valid = false; break; }

      // Keep away from coast
      if (cfg.axis === 'vertical') {
        const coastX = lookupV[Math.round(Math.max(0, Math.min(SVG_H, py)))]!;
        const distToCoast = cfg.waterSide === 'left' ? coastX - px : px - coastX;
        if (distToCoast < coastClearance) { valid = false; break; }
      } else {
        const coastY = lookupH[Math.round(Math.max(0, Math.min(SVG_W, px)))]!;
        const distToCoast = cfg.waterSide === 'top' ? coastY - py : py - coastY;
        if (distToCoast < coastClearance) { valid = false; break; }
      }

      poly.push({ x: px, y: py });
    }

    if (valid && poly.length === SIDES) islands.push({ poly, name: islandName(rng) });
  }

  return islands;
}

// ── Soundings ─────────────────────────────────────────────────────────────────

function buildSoundings(
  depthFn: DepthFn,
  rng: () => number,
  contours: Record<number, ContourSegment[]>,
): Sounding[] {
  // Flatten all contour segment endpoints for proximity checks
  const contourPts: Array<{ x: number; y: number }> = [];
  for (const segs of Object.values(contours)) {
    for (const seg of segs) {
      contourPts.push(seg[0], seg[1]);
    }
  }

  const NEAR_CONTOUR = 120; // px — soundings must be within this distance of a contour

  const isNearContour = (x: number, y: number): boolean => {
    for (const p of contourPts) {
      if (Math.hypot(p.x - x, p.y - y) < NEAR_CONTOUR) return true;
    }
    return false;
  };

  const soundings: Sounding[] = [];
  for (let attempt = 0; attempt < 600; attempt++) {
    const x = rng() * SVG_W;
    const y = rng() * SVG_H;
    const d = depthFn(x, y);
    if (d < 2) continue;
    if (x < 100 || x > SVG_W - 100 || y < 100 || y > SVG_H - 100) continue;
    if (!isNearContour(x, y) && rng() > 0.15) continue;
    soundings.push({ x, y, depth: Math.round(d) });
  }
  return soundings;
}

// ── Depth contours (marching squares) ────────────────────────────────────────

function buildContours(
  depthFn: DepthFn,
  thresholds: number[],
): Record<number, ContourSegment[]> {
  const GRID = 30;
  const cols = Math.floor(SVG_W / GRID);
  const rows = Math.floor(SVG_H / GRID);
  const results: Record<number, ContourSegment[]> = {};

  for (const thr of thresholds) {
    const segments: ContourSegment[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const x0 = c * GRID, y0 = r * GRID;
        const x1 = x0 + GRID, y1 = y0 + GRID;
        const v: [number, number, number, number] = [
          depthFn(x0, y0), depthFn(x1, y0),
          depthFn(x1, y1), depthFn(x0, y1),
        ];
        const above = v.map(d => d >= thr && d >= 0) as [boolean, boolean, boolean, boolean];
        const idx =
          (above[0] ? 8 : 0) | (above[1] ? 4 : 0) |
          (above[2] ? 2 : 0) | (above[3] ? 1 : 0);
        if (idx === 0 || idx === 15) continue;

        const lerp = (a: number, b: number, va: number, vb: number): number =>
          a + (b - a) * ((thr - va) / (vb - va));

        const pts = {
          T: { x: lerp(x0, x1, v[0], v[1]), y: y0 },
          R: { x: x1, y: lerp(y0, y1, v[1], v[2]) },
          B: { x: lerp(x0, x1, v[3], v[2]), y: y1 },
          L: { x: x0, y: lerp(y0, y1, v[0], v[3]) },
        };

        const edgeMap: Record<number, ContourSegment> = {
          1:  [pts.B, pts.L],  2:  [pts.R, pts.B],  3:  [pts.R, pts.L],
          4:  [pts.T, pts.R],  5:  [pts.T, pts.R],  6:  [pts.T, pts.B],
          7:  [pts.T, pts.L],  8:  [pts.T, pts.L],  9:  [pts.T, pts.B],
          10: [pts.L, pts.B],  11: [pts.R, pts.T],  12: [pts.R, pts.L],
          13: [pts.B, pts.R],  14: [pts.L, pts.B],
        };
        const seg = edgeMap[idx];
        if (seg) segments.push(seg);
      }
    }
    results[thr] = segments;
  }
  return results;
}

// ── Shoals ────────────────────────────────────────────────────────────────────

function buildShoals(depthFn: DepthFn, rng: () => number): Shoal[] {
  const shoals: Shoal[] = [];
  for (let attempt = 0; attempt < 400 && shoals.length < 6; attempt++) {
    const x = 100 + rng() * (SVG_W - 200);
    const y = 100 + rng() * (SVG_H - 200);
    const d = depthFn(x, y);
    if (d < 3 || d > 15) continue;
    shoals.push({ x, y, r: 8 + rng() * 20 });
  }
  return shoals;
}

// ── Light sectors ─────────────────────────────────────────────────────────────

/**
 * Estimate the seaward bearing from a lighthouse position by sampling depthFn
 * at 36 equally-spaced directions. The direction with the most/deepest water
 * samples is returned as a true bearing (0=N, clockwise).
 */
function seawardBearingFromPos(x: number, y: number, depthFn: DepthFn): number {
  const STEPS = 36;
  let bestBearing = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < STEPS; i++) {
    const trueBear = (i / STEPS) * 360;
    const svgAngle = ((trueBear - 90) * Math.PI) / 180;
    let score = 0;
    // Sample at several distances along this radial (80, 140, 200 SVG units)
    for (const r of [80, 140, 200]) {
      const d = depthFn(x + r * Math.cos(svgAngle), y + r * Math.sin(svgAngle));
      score += d; // positive = water, -1 = land
    }
    if (score > bestScore) { bestScore = score; bestBearing = trueBear; }
  }
  return bestBearing;
}

/**
 * Generate a plausible set of light sectors for a lighthouse.
 * Real lighthouses divide the horizon into coloured arcs: white over safe
 * water, red to port of a hazard, green to starboard of a hazard.
 * We always produce at least one white arc and optionally flank it with red
 * and green danger sectors.
 */
function genLightSectors(x: number, y: number, depthFn: DepthFn, rng: () => number): LightSector[] {
  // Centre the white arc on the actual seaward direction
  const seawardBearing = seawardBearingFromPos(x, y, depthFn);

  // White arc half-width: 40–80°
  const whiteHalf = 40 + Math.floor(rng() * 40);

  const sectors: LightSector[] = [];

  const hasRed   = rng() > 0.25;
  const hasGreen = rng() > 0.25;

  // Red sector to the left (port) of safe water
  if (hasRed) {
    const redWidth = 15 + Math.floor(rng() * 25);
    const from = (seawardBearing - whiteHalf - redWidth + 360) % 360;
    const to   = (seawardBearing - whiteHalf + 360) % 360;
    sectors.push({ fromDeg: from, toDeg: to, color: 'red' });
  }

  // White safe-water arc
  sectors.push({
    fromDeg: (seawardBearing - whiteHalf + 360) % 360,
    toDeg:   (seawardBearing + whiteHalf) % 360,
    color: 'white',
  });

  // Green sector to the right (starboard) of safe water
  if (hasGreen) {
    const greenWidth = 15 + Math.floor(rng() * 25);
    const from = (seawardBearing + whiteHalf) % 360;
    const to   = (seawardBearing + whiteHalf + greenWidth) % 360;
    sectors.push({ fromDeg: from, toDeg: to, color: 'green' });
  }

  return sectors;
}

// ── Landmarks ─────────────────────────────────────────────────────────────────

function placeLandmarks(
  coastPts: Array<{ x: number; y: number }>,
  depthFn: DepthFn,
  rng: () => number,
  cfg: CoastConfig,
  islands: Array<{ poly: Array<{ x: number; y: number }>; name: string }>,
): Landmark[] {
  const landmarks: Landmark[] = [];

  // Lighthouses: 2–4 total, placed on islands first then coast
  const lighthouseTarget = 2 + Math.floor(rng() * 3); // 2, 3, or 4
  let lighthousesPlaced = 0;

  for (const { poly } of islands) {
    if (lighthousesPlaced >= lighthouseTarget) break;
    if (rng() > 0.5) continue;
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
    if (landmarks.some(l => Math.hypot(l.x - cx, l.y - cy) < 90)) continue;
    const sectors = genLightSectors(cx, cy, depthFn, rng);
    landmarks.push({ type: 'lighthouse', x: cx, y: cy, name: landmarkName('lighthouse', rng), sectors });
    lighthousesPlaced++;
  }

  // Fill remaining lighthouses from coast
  for (let attempt = 0; attempt < 600 && lighthousesPlaced < lighthouseTarget; attempt++) {
    const ci = Math.floor(rng() * (coastPts.length - 3));
    const cp = coastPts[ci]!;
    let x: number, y: number;
    if (cfg.axis === 'vertical') {
      const sign = cfg.waterSide === 'left' ? 1 : -1;
      x = cp.x + sign * (15 + rng() * 160);
      y = cp.y + (rng() - 0.5) * 80;
    } else {
      x = cp.x + (rng() - 0.5) * 80;
      const sign = cfg.waterSide === 'top' ? 1 : -1;
      y = cp.y + sign * (15 + rng() * 160);
    }
    if (x < 100 || x > SVG_W - 100 || y < 100 || y > SVG_H - 100) continue;
    if (depthFn(x, y) > 0) continue;
    if (landmarks.some(l => Math.hypot(l.x - x, l.y - y) < 90)) continue;
    const sectors = genLightSectors(x, y, depthFn, rng);
    landmarks.push({ type: 'lighthouse', x, y, name: landmarkName('lighthouse', rng), sectors });
    lighthousesPlaced++;
  }

  // Land-based types: place near coastline on the land side
  const landTypes: { type: LandmarkType; count: number }[] = [
    { type: 'church',     count: 6 },
    { type: 'mast',       count: 4 },
    { type: 'tower',      count: 4 },
  ];

  for (const { type, count } of landTypes) {
    let placed = 0;
    for (let attempt = 0; attempt < 600 && placed < count; attempt++) {
      const ci = Math.floor(rng() * (coastPts.length - 3));
      const cp = coastPts[ci]!;
      let x: number, y: number;
      if (cfg.axis === 'vertical') {
        const sign = cfg.waterSide === 'left' ? 1 : -1;
        x = cp.x + sign * (15 + rng() * 160);
        y = cp.y + (rng() - 0.5) * 80;
      } else {
        x = cp.x + (rng() - 0.5) * 80;
        const sign = cfg.waterSide === 'top' ? 1 : -1;
        y = cp.y + sign * (15 + rng() * 160);
      }
      if (x < 100 || x > SVG_W - 100 || y < 100 || y > SVG_H - 100) continue;
      if (depthFn(x, y) > 0) continue; // must be on land
      if (landmarks.some(l => Math.hypot(l.x - x, l.y - y) < 90)) continue;
      const sectors = type === 'lighthouse' ? genLightSectors(x, y, depthFn, rng) : undefined;
      landmarks.push({ type, x, y, name: landmarkName(type, rng), sectors });
      placed++;
    }
  }

  // Water-based: wrecks and rocks scattered in shallow/mid water
  const waterTypes: { type: LandmarkType; count: number; minD: number; maxD: number }[] = [
    { type: 'wreck', count: 5, minD: 2, maxD: 25 },
    { type: 'rock',  count: 6, minD: 0, maxD: 8  },
  ];

  for (const { type, count, minD, maxD } of waterTypes) {
    let placed = 0;
    for (let attempt = 0; attempt < 800 && placed < count; attempt++) {
      const x = 100 + rng() * (SVG_W - 200);
      const y = 100 + rng() * (SVG_H - 200);
      const d = depthFn(x, y);
      if (d < minD || d > maxD) continue;
      if (landmarks.some(l => Math.hypot(l.x - x, l.y - y) < 80)) continue;
      landmarks.push({ type, x, y, name: landmarkName(type, rng) });
      placed++;
    }
  }

  return landmarks;
}

function landmarkName(type: LandmarkType, rng: () => number): string {
  const names: Record<LandmarkType, string[]> = {
    lighthouse: ['Pt. Moran Lt', 'Breakwater Lt', 'Haven Lt', 'Old Head Lt', 'Black Rock Lt',
                 'Gull Point Lt', 'Tern Rock Lt', 'South Head Lt', 'Lord Howe Lt', 'Dunmore Lt'],
    church:     ["St. Brendan's", 'All Saints', "St. Michael's", 'Chapel Hill', 'Old Church',
                 "St. David's", "St. Ciaran's", 'Holy Trinity', 'Abbey Ruins', "St. Ita's"],
    mast:       ['Radio Mast', 'TV Mast', 'Signal Mast', 'Comm. Tower', 'Coast Gd. Mast', 'Relay Mast'],
    tower:      ['Water Twr', 'Mill Tower', 'Old Tower', 'Barrow Twr', 'Martello Twr', 'Watch Twr'],
    wreck:      ['Wk (2003)', 'Wk (1944)', 'Wk (1917)', 'Wk (1982)', 'Wk (1861)'],
    rock:       ["Mermaid's Stone", 'Black Rock', 'Gull Rock', 'Seal Rock', 'Badger Stone', 'The Anvil'],
  };
  const arr = names[type];
  return arr[Math.floor(rng() * arr.length)]!;
}

// ── Harbour ───────────────────────────────────────────────────────────────────

function buildHarbour(
  coastPts: Array<{ x: number; y: number }>,
  rng: () => number,
  cfg: CoastConfig,
): Harbour {
  const ci = Math.min(
    Math.floor(coastPts.length * 0.35 + rng() * coastPts.length * 0.3),
    coastPts.length - 3,
  );
  const entrance = coastPts[ci]!;
  const hw = 40 + rng() * 30;
  const depth = 60 + rng() * 60;

  // Piers and inner points extend into land, buoys extend into water
  let portPier, stbdPier, portInner, stbdInner;
  const buoys: ChannelBuoy[] = [];

  if (cfg.axis === 'vertical') {
    const landSign = cfg.waterSide === 'left' ? 1 : -1;
    const waterSign = -landSign;
    portPier  = { x: entrance.x + landSign * 10, y: entrance.y - hw };
    stbdPier  = { x: entrance.x + landSign * 10, y: entrance.y + hw };
    portInner = { x: entrance.x + landSign * depth, y: entrance.y - hw * 0.3 };
    stbdInner = { x: entrance.x + landSign * depth, y: entrance.y + hw * 0.3 };
    for (let i = 1; i <= 4; i++) {
      const t = i / 4.5;
      const cx = entrance.x + waterSign * t * SVG_W * 0.18;
      buoys.push(
        { x: cx, y: entrance.y - 22, side: 'port' },
        { x: cx, y: entrance.y + 22, side: 'starboard' },
      );
    }
  } else {
    const landSign = cfg.waterSide === 'top' ? 1 : -1;
    const waterSign = -landSign;
    portPier  = { x: entrance.x - hw, y: entrance.y + landSign * 10 };
    stbdPier  = { x: entrance.x + hw, y: entrance.y + landSign * 10 };
    portInner = { x: entrance.x - hw * 0.3, y: entrance.y + landSign * depth };
    stbdInner = { x: entrance.x + hw * 0.3, y: entrance.y + landSign * depth };
    for (let i = 1; i <= 4; i++) {
      const t = i / 4.5;
      const cy = entrance.y + waterSign * t * SVG_H * 0.18;
      buoys.push(
        { x: entrance.x - 22, y: cy, side: 'port' },
        { x: entrance.x + 22, y: cy, side: 'starboard' },
      );
    }
  }

  const names = ['Port Carrig', 'Havenmouth', 'Dunmore Hbr', 'Lazy Harbour'] as const;
  return {
    entrance, portPier, stbdPier, portInner, stbdInner, buoys,
    name: names[Math.floor(rng() * names.length)]!,
  };
}

// ── Cardinal buoys ────────────────────────────────────────────────────────────

function buildCardinalBuoys(shoals: Shoal[]): CardinalBuoy[] {
  const dirs: CardinalDirection[] = ['north', 'south', 'east', 'west'];
  const offsets: Record<CardinalDirection, { dx: number; dy: number }> = {
    north: { dx: 0,   dy: -40 },
    south: { dx: 0,   dy:  40 },
    east:  { dx:  40, dy: 0   },
    west:  { dx: -40, dy: 0   },
  };
  const buoys: CardinalBuoy[] = [];
  for (let i = 0; i < shoals.length && i < 8; i++) {
    const s = shoals[i]!;
    const dir = dirs[i % dirs.length]!;
    const off = offsets[dir];
    buoys.push({ x: s.x + off.dx, y: s.y + off.dy, type: dir, name: `${dir.charAt(0).toUpperCase()} Card` });
  }
  return buoys;
}

// ── Compass rose placement ────────────────────────────────────────────────────

type Poly = Array<{ x: number; y: number }>;

/** True if circle (cx,cy,r) overlaps polygon — checks vertex containment and edge intersections. */
function circleIntersectsPoly(cx: number, cy: number, r: number, poly: Poly): boolean {
  const r2 = r * r;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    // Vertex inside circle
    if ((a.x - cx) ** 2 + (a.y - cy) ** 2 < r2) return true;
    // Closest point on edge segment to circle centre
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / lenSq));
    const nearX = a.x + t * dx, nearY = a.y + t * dy;
    if ((nearX - cx) ** 2 + (nearY - cy) ** 2 < r2) return true;
  }
  // Centre inside polygon (ray-cast)
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]!.x, yi = poly[i]!.y;
    const xj = poly[j]!.x, yj = poly[j]!.y;
    if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function placeCompassRose(
  depthFn: DepthFn,
  rng: () => number,
  islands: Array<{ poly: Poly }>,
): CompassRose {
  const ROSE_R = 270;
  const MARGIN = ROSE_R;
  const MIN_DEPTH = 35;
  const N_RING = 24;

  const isValid = (x: number, y: number): boolean => {
    if (x < MARGIN || x > SVG_W - MARGIN || y < MARGIN || y > SVG_H - MARGIN) return false;
    if (depthFn(x, y) < MIN_DEPTH) return false;
    // Perimeter depth check
    for (let i = 0; i < N_RING; i++) {
      const angle = (i / N_RING) * Math.PI * 2;
      if (depthFn(x + ROSE_R * Math.cos(angle), y + ROSE_R * Math.sin(angle)) < 5) return false;
    }
    // Exact circle-vs-polygon collision for every island
    for (const { poly } of islands) {
      if (circleIntersectsPoly(x, y, ROSE_R, poly)) return false;
    }
    return true;
  };

  for (let attempt = 0; attempt < 1000; attempt++) {
    const x = MARGIN + rng() * (SVG_W - MARGIN * 2);
    const y = MARGIN + rng() * (SVG_H - MARGIN * 2);
    if (isValid(x, y)) return { x, y, r: 90 };
  }
  // Fallback: grid-scan for deepest valid position
  let bestX = SVG_W * 0.25, bestY = SVG_H * 0.25, bestDepth = -1;
  for (let gx = MARGIN; gx <= SVG_W - MARGIN; gx += 60) {
    for (let gy = MARGIN; gy <= SVG_H - MARGIN; gy += 60) {
      const d = depthFn(gx, gy);
      if (d > bestDepth && isValid(gx, gy)) {
        bestDepth = d; bestX = gx; bestY = gy;
      }
    }
  }
  return { x: bestX, y: bestY, r: 90 };
}

// ── Anchorages ────────────────────────────────────────────────────────────────

function buildAnchorages(depthFn: DepthFn, rng: () => number): Anchorage[] {
  const anchorages: Anchorage[] = [];
  const names = ['Gull Roads', 'Blind Cove', 'The Haven', 'East Road',
                 'West Anchorage', 'Seal Bay', 'Long Roads', 'North Cove'] as const;
  for (let attempt = 0; attempt < 800 && anchorages.length < 6; attempt++) {
    const x = 100 + rng() * (SVG_W - 200);
    const y = 100 + rng() * (SVG_H - 200);
    const d = depthFn(x, y);
    if (d < 4 || d > 22) continue;
    if (anchorages.some(a => Math.hypot(a.x - x, a.y - y) < 150)) continue;
    anchorages.push({ x, y, name: names[anchorages.length] ?? 'Anchorage' });
  }
  return anchorages;
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number>;

function el(
  tag: string,
  attrs: Attrs,
  parent?: Element,
): SVGElement {
  const e = document.createElementNS(NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function txt(
  content: string,
  attrs: Attrs,
  parent?: Element,
): SVGTextElement {
  const e = document.createElementNS(NS, 'text') as SVGTextElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.textContent = content;
  parent?.appendChild(e);
  return e;
}

function polyPts(pts: Array<{ x: number; y: number }>): string {
  return pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function grp(id: string, parent: Element): SVGGElement {
  const g = document.createElementNS(NS, 'g') as SVGGElement;
  if (id) g.id = id;
  parent.appendChild(g);
  return g;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const BORDER_MARGIN = 50; // px outside the chart frame for the graduated border

function renderChart(svgEl: SVGSVGElement, data: ChartData, compassSvgs: { outer: string; inner: string } | null = null): void {
  svgEl.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
  svgEl.setAttribute('width', String(SVG_W));
  svgEl.setAttribute('height', String(SVG_H));
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  const { coastPts, islands, cfg, depthFn, soundings, contours, shoals, landmarks, harbour,
          cardinalBuoys, compassRose, anchorages, variation, variationDir, seed } = data;

  // Clip path
  const defs = el('defs', {}, svgEl);
  const clip = el('clipPath', { id: 'chartClip' }, defs);
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H }, clip);

  // Water — off-white base for deep water, blue tint for shallow zones
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H, fill: '#ffffff' }, svgEl);

  // Shallow depth fill: grid cells coloured by depth band (deep→shallow = faint→blue)
  const depthFillG = grp('depth-fill', svgEl);
  const DFILL_GRID = 12;
  const depthFillColors: Array<{ maxD: number; fill: string }> = [
    { maxD:  5, fill: '#a8cfe0' },
    { maxD: 10, fill: '#bcd9e8' },
    { maxD: 20, fill: '#d0e6f0' },
    { maxD: 40, fill: '#e2eff5' },
  ];
  for (let gy = 0; gy < SVG_H; gy += DFILL_GRID) {
    for (let gx = 0; gx < SVG_W; gx += DFILL_GRID) {
      const d = depthFn(gx + DFILL_GRID / 2, gy + DFILL_GRID / 2);
      if (d <= 0) continue; // land
      const band = depthFillColors.find(b => d <= b.maxD);
      if (!band) continue; // deep water — leave off-white
      el('rect', { x: gx, y: gy, width: DFILL_GRID, height: DFILL_GRID, fill: band.fill }, depthFillG);
    }
  }


  // Land — close polygon on the land side depending on topology
  const landG = grp('land', svgEl);
  let landClosing: Array<{ x: number; y: number }>;
  if (cfg.axis === 'vertical') {
    if (cfg.waterSide === 'left') {
      landClosing = [{ x: SVG_W, y: SVG_H }, { x: SVG_W, y: 0 }];
    } else {
      landClosing = [{ x: 0, y: SVG_H }, { x: 0, y: 0 }];
    }
  } else {
    if (cfg.waterSide === 'top') {
      landClosing = [{ x: SVG_W, y: SVG_H }, { x: 0, y: SVG_H }];
    } else {
      landClosing = [{ x: SVG_W, y: 0 }, { x: 0, y: 0 }];
    }
  }
  const landPoly = [...coastPts, ...landClosing];
  el('polygon', {
    points: polyPts(landPoly),
    fill: '#f5f0dc', stroke: '#8b7355', 'stroke-width': 1.5,
  }, landG);

  // Islands
  for (const { poly: islandPoly, name: islandName } of islands) {
    el('polygon', {
      points: polyPts(islandPoly),
      fill: '#f5f0dc', stroke: '#8b7355', 'stroke-width': 1.5,
    }, landG);
    // Label: centroid of the polygon
    const cx = islandPoly.reduce((s, p) => s + p.x, 0) / islandPoly.length;
    const cy = islandPoly.reduce((s, p) => s + p.y, 0) / islandPoly.length;
    // If a lighthouse sits at this island's centroid, offset the label below it
    const hasLighthouse = landmarks.some(l => l.type === 'lighthouse' && Math.hypot(l.x - cx, l.y - cy) < 20);
    el('text', {
      x: cx, y: hasLighthouse ? cy + 33 : cy,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-family': 'Georgia, serif', 'font-size': 11,
      'font-style': 'italic', fill: '#5a3e1b', opacity: 0.85,
    }, landG).textContent = islandName;
  }

  // Depth contours
  const contourColors: Record<number, string> = { 5: '#7aafc8', 10: '#5b9ab5', 20: '#3d7fa0' };
  const contourG = grp('contours', svgEl);
  for (const [thrStr, segs] of Object.entries(contours)) {
    const color = contourColors[Number(thrStr)] ?? '#5b9ab5';
    for (const seg of segs) {
      el('line', {
        x1: seg[0].x, y1: seg[0].y, x2: seg[1].x, y2: seg[1].y,
        stroke: color, 'stroke-width': 0.8, 'stroke-dasharray': '4,3', opacity: 0.7,
      }, contourG);
    }
  }

  // Shoals
  const shoalG = grp('shoals', svgEl);
  for (const s of shoals) {
    el('ellipse', {
      cx: s.x, cy: s.y, rx: s.r * 1.4, ry: s.r * 0.9,
      fill: 'none', stroke: '#8b7355', 'stroke-width': 1, 'stroke-dasharray': '3,2',
    }, shoalG);
    txt('*', {
      x: s.x, y: s.y + 4,
      'text-anchor': 'middle', 'font-size': 14, fill: '#8b5e3c', 'font-style': 'italic',
    }, shoalG);
  }

  // Soundings
  const sdG = grp('soundings', svgEl);
  for (const s of soundings) {
    txt(String(s.depth), {
      x: s.x, y: s.y,
      'text-anchor': 'middle', 'font-size': 10, 'font-style': 'italic',
      fill: '#1a5276', 'font-family': 'Georgia, serif',
    }, sdG);
  }

  // Harbour
  const harbG = grp('harbour', svgEl);
  el('line', {
    x1: harbour.portPier.x,  y1: harbour.portPier.y,
    x2: harbour.portInner.x, y2: harbour.portInner.y,
    stroke: '#4a4a4a', 'stroke-width': 4, 'stroke-linecap': 'round',
  }, harbG);
  el('line', {
    x1: harbour.stbdPier.x,  y1: harbour.stbdPier.y,
    x2: harbour.stbdInner.x, y2: harbour.stbdInner.y,
    stroke: '#4a4a4a', 'stroke-width': 4, 'stroke-linecap': 'round',
  }, harbG);
  txt(harbour.name, {
    x: harbour.entrance.x + 80, y: harbour.entrance.y + 14,
    'text-anchor': 'middle', 'font-size': 11,
    fill: '#1a3a5c', 'font-style': 'italic', 'font-family': 'Georgia, serif',
  }, harbG);

  // Buoys
  const buoyG = grp('buoys', svgEl);
  for (const b of harbour.buoys)  drawChannelBuoy(b, buoyG);
  for (const b of cardinalBuoys)  drawCardinalBuoy(b, buoyG);

  // Anchorages
  const anchG = grp('anchorages', svgEl);
  for (const a of anchorages) {
    el('circle', { cx: a.x, cy: a.y, r: 10, fill: 'none', stroke: '#1a5276', 'stroke-width': 1.5 }, anchG);
    el('line', { x1: a.x, y1: a.y - 10, x2: a.x, y2: a.y + 10, stroke: '#1a5276', 'stroke-width': 1.5 }, anchG);
    el('line', { x1: a.x - 8, y1: a.y + 6, x2: a.x + 8, y2: a.y + 6, stroke: '#1a5276', 'stroke-width': 1.5 }, anchG);
    txt(a.name, {
      x: a.x + 14, y: a.y + 4,
      'font-size': 10, fill: '#1a5276', 'font-style': 'italic', 'font-family': 'Georgia, serif',
    }, anchG);
  }

  // Landmarks
  const lmG = grp('landmarks', svgEl);
  for (const lm of landmarks) drawLandmark(lm, lmG);

  // Grid, rose, scale bar, title
  renderGrid(svgEl);
  renderCompassRose(compassRose, svgEl, variation, variationDir, compassSvgs);
  // Scale bar drawn on canvas overlay (see drawScaleBar in canvas.ts)
  renderTitleBlock(svgEl, variation, variationDir, seed);
}

function drawChannelBuoy(b: ChannelBuoy, parent: Element): void {
  if (b.side === 'port') {
    el('rect', { x: b.x - 7, y: b.y - 12, width: 14, height: 16, rx: 3, fill: '#cc2222', stroke: '#881111', 'stroke-width': 1 }, parent);
    el('line', { x1: b.x, y1: b.y + 4, x2: b.x, y2: b.y + 18, stroke: '#cc2222', 'stroke-width': 1.5 }, parent);
  } else {
    const pts = `${b.x},${b.y - 14} ${b.x - 8},${b.y + 4} ${b.x + 8},${b.y + 4}`;
    el('polygon', { points: pts, fill: '#22aa44', stroke: '#116622', 'stroke-width': 1 }, parent);
    el('line', { x1: b.x, y1: b.y + 4, x2: b.x, y2: b.y + 18, stroke: '#22aa44', 'stroke-width': 1.5 }, parent);
  }
}

function drawCardinalBuoy(b: CardinalBuoy, parent: Element): void {
  const { x, y, type, name } = b;
  const K = '#000000', Y = '#ffcc00';
  // Body bands: north = black/yellow, south = yellow/black, east = black/yellow/black, west = yellow/black/yellow
  if (type === 'north') {
    el('rect', { x: x - 5, y: y - 20, width: 10, height: 10, fill: K }, parent);
    el('rect', { x: x - 5, y: y - 10, width: 10, height: 10, fill: Y }, parent);
  } else if (type === 'south') {
    el('rect', { x: x - 5, y: y - 20, width: 10, height: 10, fill: Y }, parent);
    el('rect', { x: x - 5, y: y - 10, width: 10, height: 10, fill: K }, parent);
  } else if (type === 'east') {
    el('rect', { x: x - 5, y: y - 20, width: 10, height: 7, fill: K }, parent);
    el('rect', { x: x - 5, y: y - 13, width: 10, height: 6, fill: Y }, parent);
    el('rect', { x: x - 5, y: y -  7, width: 10, height: 7, fill: K }, parent);
  } else { // west
    el('rect', { x: x - 5, y: y - 20, width: 10, height: 7, fill: Y }, parent);
    el('rect', { x: x - 5, y: y - 13, width: 10, height: 6, fill: K }, parent);
    el('rect', { x: x - 5, y: y -  7, width: 10, height: 7, fill: Y }, parent);
  }
  el('line', { x1: x, y1: y, x2: x, y2: y + 14, stroke: '#333', 'stroke-width': 1.5 }, parent);
  // Topmarks differ per cardinal direction
  if (type === 'north') {
    el('polygon', { points: `${x},${y - 32} ${x - 6},${y - 22} ${x + 6},${y - 22}`, fill: '#000' }, parent);
    el('polygon', { points: `${x},${y - 42} ${x - 6},${y - 32} ${x + 6},${y - 32}`, fill: '#000' }, parent);
  } else if (type === 'south') {
    el('polygon', { points: `${x},${y - 22} ${x - 6},${y - 32} ${x + 6},${y - 32}`, fill: '#000' }, parent);
    el('polygon', { points: `${x},${y - 32} ${x - 6},${y - 42} ${x + 6},${y - 42}`, fill: '#000' }, parent);
  } else if (type === 'west') {
    el('polygon', { points: `${x},${y - 32} ${x - 6},${y - 22} ${x + 6},${y - 22}`, fill: '#000' }, parent);
    el('polygon', { points: `${x},${y - 32} ${x - 6},${y - 42} ${x + 6},${y - 42}`, fill: '#000' }, parent);
  } else { // east
    el('polygon', { points: `${x},${y - 22} ${x - 6},${y - 32} ${x + 6},${y - 32}`, fill: '#000' }, parent);
    el('polygon', { points: `${x},${y - 42} ${x - 6},${y - 32} ${x + 6},${y - 32}`, fill: '#000' }, parent);
  }
}

/**
 * Build an SVG arc-sector path.
 * fromDeg / toDeg are TRUE bearings (0=North, clockwise).
 * SVG angles: 0=East, clockwise. Conversion: svgAngle = trueBearing - 90.
 */
function sectorPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  // Convert true bearing → SVG angle (radians)
  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const a1 = toRad(fromDeg);
  const a2 = toRad(toDeg);

  // Normalise so arc always goes clockwise from a1 to a2
  let sweep = toDeg - fromDeg;
  if (sweep <= 0) sweep += 360;
  const largeArc = sweep > 180 ? 1 : 0;

  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const x2 = cx + r * Math.cos(a2);
  const y2 = cy + r * Math.sin(a2);

  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`;
}

const SECTOR_FILL: Record<LightSector['color'], string> = {
  white: 'rgba(255,255,255,0.55)',
  red:   'rgba(210,30,30,0.35)',
  green: 'rgba(20,160,60,0.35)',
};
const SECTOR_STROKE: Record<LightSector['color'], string> = {
  white: 'rgba(200,200,180,0.7)',
  red:   'rgba(180,20,20,0.6)',
  green: 'rgba(10,130,40,0.6)',
};

function drawLandmark(lm: Landmark, parent: Element): void {
  const { x, y, type, name } = lm;
  switch (type) {
    case 'lighthouse': {
      const R = 120; // sector radius in SVG units
      if (lm.sectors?.length) {
        for (const s of lm.sectors) {
          el('path', {
            d: sectorPath(x, y, R, s.fromDeg, s.toDeg),
            fill: SECTOR_FILL[s.color],
            stroke: SECTOR_STROKE[s.color],
            'stroke-width': 0.8,
          }, parent);
        }
        // Dashed boundary lines at each sector edge
        for (const s of lm.sectors) {
          for (const deg of [s.fromDeg, s.toDeg]) {
            const rad = ((deg - 90) * Math.PI) / 180;
            el('line', {
              x1: x, y1: y,
              x2: x + R * Math.cos(rad),
              y2: y + R * Math.sin(rad),
              stroke: '#556', 'stroke-width': 0.6, 'stroke-dasharray': '4,3', opacity: 0.6,
            }, parent);
          }
        }
      }
      el('circle', { cx: x, cy: y, r: 8, fill: '#cc44aa', stroke: '#881177', 'stroke-width': 1.5 }, parent);
      for (let a = 0; a < 360; a += 45) {
        const rad = (a * Math.PI) / 180;
        el('line', {
          x1: x + 9 * Math.cos(rad),  y1: y + 9 * Math.sin(rad),
          x2: x + 15 * Math.cos(rad), y2: y + 15 * Math.sin(rad),
          stroke: '#cc44aa', 'stroke-width': 1.5,
        }, parent);
      }
      break;
    }
    case 'church':
      el('line', { x1: x, y1: y - 12, x2: x, y2: y + 8,  stroke: '#333', 'stroke-width': 2.5 }, parent);
      el('line', { x1: x - 7, y1: y - 4, x2: x + 7, y2: y - 4, stroke: '#333', 'stroke-width': 2.5 }, parent);
      break;
    case 'mast':
      el('line', { x1: x, y1: y - 14, x2: x, y2: y + 6,  stroke: '#333', 'stroke-width': 2 }, parent);
      el('line', { x1: x - 8, y1: y - 8, x2: x + 8, y2: y - 8, stroke: '#333', 'stroke-width': 2 }, parent);
      el('line', { x1: x - 5, y1: y, x2: x + 5, y2: y,   stroke: '#333', 'stroke-width': 1.5 }, parent);
      el('circle', { cx: x, cy: y - 14, r: 3, fill: '#333' }, parent);
      break;
    case 'tower':
      el('circle', { cx: x, cy: y - 10, r: 6, fill: 'none', stroke: '#333', 'stroke-width': 2 }, parent);
      el('line', { x1: x, y1: y - 4, x2: x, y2: y + 6, stroke: '#333', 'stroke-width': 2 }, parent);
      break;
    case 'wreck':
      // Standard Admiralty wreck symbol: hull outline with mast
      el('ellipse', { cx: x, cy: y, rx: 12, ry: 5, fill: 'none', stroke: '#555', 'stroke-width': 1.5, 'stroke-dasharray': '3,2' }, parent);
      el('line', { x1: x, y1: y - 5, x2: x, y2: y - 14, stroke: '#555', 'stroke-width': 1.5 }, parent);
      el('line', { x1: x - 6, y1: y - 10, x2: x + 6, y2: y - 10, stroke: '#555', 'stroke-width': 1 }, parent);
      break;
    case 'rock':
      // Admiralty rock awash symbol: asterisk/cross
      el('line', { x1: x - 7, y1: y, x2: x + 7, y2: y, stroke: '#333', 'stroke-width': 2 }, parent);
      el('line', { x1: x, y1: y - 7, x2: x, y2: y + 7, stroke: '#333', 'stroke-width': 2 }, parent);
      el('line', { x1: x - 5, y1: y - 5, x2: x + 5, y2: y + 5, stroke: '#333', 'stroke-width': 1.5 }, parent);
      el('line', { x1: x + 5, y1: y - 5, x2: x - 5, y2: y + 5, stroke: '#333', 'stroke-width': 1.5 }, parent);
      el('circle', { cx: x, cy: y, r: 2.5, fill: '#333' }, parent);
      break;
  }
  txt(name, {
    x: x + 12, y: y + 4,
    'font-size': 10, fill: '#1a5276',
    'font-family': 'Georgia, serif', 'font-style': 'italic',
  }, parent);
}

function renderGrid(svgEl: SVGSVGElement): void {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  const gG = grp('grid', svgEl);

  // ── Graticule grid lines (every 5′ latitude; longitude step scaled so cells are square) ──
  const latStep = 5 / 60;
  const midLat = (minLat + maxLat) / 2;
  const lonStep = latStep / Math.cos((midLat * Math.PI) / 180);

  for (let lat = Math.ceil(minLat / latStep) * latStep; lat <= maxLat + 1e-9; lat += latStep) {
    const { y } = latLonToSVG(lat, minLon);
    el('line', { x1: 0, y1: y, x2: SVG_W, y2: y, stroke: '#6699bb', 'stroke-width': 0.4, opacity: 0.5 }, gG);
  }
  for (let lon = Math.ceil(minLon / lonStep) * lonStep; lon <= maxLon + 1e-9; lon += lonStep) {
    const { x } = latLonToSVG(minLat, lon);
    el('line', { x1: x, y1: 0, x2: x, y2: SVG_H, stroke: '#6699bb', 'stroke-width': 0.4, opacity: 0.5 }, gG);
  }

  // ── Chart frame ───────────────────────────────────────────────────────────────
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H, fill: 'none', stroke: '#1a3a5c', 'stroke-width': 2.5 }, gG);

  // Ticks and labels are drawn on the canvas overlay (see drawBorderTicks in canvas.ts)
}

/**
 * Format variation as degrees and whole minutes, e.g. "4°15'W"
 */
export function FormatVariation(variation: number, dir: 'E' | 'W'): string {
  const deg = Math.floor(variation);
  const min = Math.round((variation - deg) * 60);
  return `${deg}°${String(min).padStart(2, '0')}'${dir}`;
}

function renderCompassRose(rose: CompassRose, svgEl: SVGSVGElement, variation: number, variationDir: 'E' | 'W', compassSvgs: { outer: string; inner: string } | null = null): void {
  const { x, y } = rose;
  const r = 270;
  const gG = grp('compass-rose', svgEl);

  // ── Embedded compass SVGs ─────────────────────────────────────────────────
  // Both SVGs share the same coordinate space: 1103×1163, center (550.02, 592.06),
  // outer tick-ring radius ~482.75 px. We scale to chart rose radius (160 px).
  if (compassSvgs !== null) {
    const SVG_CX = 550.02, SVG_CY = 592.06, SVG_OR = 482.75;
    const scale = r / SVG_OR;
    const tx = x - SVG_CX * scale;
    const ty = y - SVG_CY * scale;

    const stripSvgWrapper = (svg: string): string =>
      svg
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!DOCTYPE[^>]*>/g, '')
        .replace(/<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '')
        .replace(/<defs[^/]*\/>/g, '');

    // Outer ring — static, no rotation
    const outerG = document.createElementNS(NS, 'g') as SVGGElement;
    outerG.setAttribute('transform', `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(6)})`);
    outerG.innerHTML = stripSvgWrapper(compassSvgs.outer);
    gG.appendChild(outerG);

    // Inner ring — rotated so magnetic north aligns correctly.
    // The inner SVG's north needle is drawn at bearing 355.751°, meaning it has
    // ~4.249° of westerly variation baked in. We correct for that offset first,
    // then apply the chart's actual variation (E = clockwise, W = counter-clockwise).
    const INNER_BAKED_OFFSET = 4.249;
    const varDeg = variationDir === 'E'
      ? INNER_BAKED_OFFSET + variation
      : INNER_BAKED_OFFSET - variation;
    const innerG = document.createElementNS(NS, 'g') as SVGGElement;
    innerG.setAttribute('transform',
      `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(6)}) rotate(${varDeg.toFixed(4)},${SVG_CX},${SVG_CY})`
    );
    innerG.innerHTML = stripSvgWrapper(compassSvgs.inner);
    gG.appendChild(innerG);

    // ── Dynamic variation label ───────────────────────────────────────────────
    // Overlays the static text8247 path (which is hidden in compass-outer.svg).
    // Arc geometry derived from text8247: radius 89.6 SVG units, centered at
    // (550.02, 592.06), bottom of compass, text reads L→R concave-up.
    const VAR_ARC_R = 89.6;
    const arcPathId = `var-arc-${Math.random().toString(36).slice(2, 7)}`;
    const varLabel = "VARIATION " + FormatVariation(variation, variationDir);

    // Arc path: bottom semicircle from left to right in SVG coordinate space.
    // M = left point, A = arc to right point (sweep-flag=0 → bottom arc, concave up).
    const arcLeft  = `${(SVG_CX - VAR_ARC_R).toFixed(3)},${SVG_CY.toFixed(3)}`;
    const arcRight = `${(SVG_CX + VAR_ARC_R).toFixed(3)},${SVG_CY.toFixed(3)}`;
    const arcD = `M ${arcLeft} A ${VAR_ARC_R} ${VAR_ARC_R} 0 0 1 ${arcRight}`;

    // Group uses same transform as outer so coordinates stay in SVG space
    const varG = document.createElementNS(NS, 'g') as SVGGElement;
    varG.setAttribute('transform', `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(6)})`);

    const defs = document.createElementNS(NS, 'defs');
    const arcPath = document.createElementNS(NS, 'path');
    arcPath.setAttribute('id', arcPathId);
    arcPath.setAttribute('d', arcD);
    arcPath.setAttribute('fill', 'none');
    defs.appendChild(arcPath);
    varG.appendChild(defs);

    const textEl = document.createElementNS(NS, 'text') as SVGTextElement;
    textEl.setAttribute('class', 'compass-var-text');
    const textPath = document.createElementNS(NS, 'textPath') as SVGTextPathElement;
    textPath.setAttribute('href', `#${arcPathId}`);
    textPath.setAttribute('startOffset', '50%');
    textPath.textContent = varLabel;
    textEl.appendChild(textPath);
    varG.appendChild(textEl);

    gG.appendChild(varG);

    return;
  }
}



function renderTitleBlock(svgEl: SVGSVGElement, variation: number, variationDir: 'E' | 'W', seed: number): void {
  const gG = grp('title-block', svgEl);
  const bx = SVG_W - 320, by = SVG_H - 120;
  el('rect', { x: bx, y: by, width: 310, height: 110, fill: 'rgba(255,255,250,0.85)', stroke: '#1a3a5c', 'stroke-width': 1.5 }, gG);

  const lines: Array<[string, number, string, string]> = [
    ['FICTIONAL TRAINING CHART', 14, '#1a3a5c', 'bold'],
    [`Chart No. FTC-${(seed % 9999) + 1000}`, 10, '#1a3a5c', 'normal'],
    ["Datum WGS84", 9, '#1a3a5c', 'normal'],
    ["Lat 52°00'N – 52°30'N,  Lon 004°53'W – 003°47'W", 8, '#334455', 'normal'],
    // [`Magnetic Variation: ${variation.toFixed(1)}°${variationDir} (2025)`, 9, '#884400', 'normal'],
    [`Magnetic Variation: ${FormatVariation(variation, variationDir)} (2025)`, 9, '#884400', 'normal'],
    ['FOR TRAINING USE ONLY – NOT FOR NAVIGATION', 8, '#cc2222', 'bold'],
    [`Seed: ${seed}`, 8, '#888', 'normal'],
  ];

  let ly = by + 16;
  for (const [content, size, fill, weight] of lines) {
    txt(content, { x: bx + 8, y: ly, 'font-size': size, fill, 'font-weight': weight, 'font-family': 'Georgia, serif' }, gG);
    ly += size + 5;
  }
}


export function generateChart(seed: number): ChartData {
  const rng = makeRNG(seed);
  const noise = createNoise2D(seed + 1);

  // Pick topology
  const axis: CoastAxis = rng() > 0.5 ? 'vertical' : 'horizontal';
  const waterSide: WaterSide = axis === 'vertical'
    ? (rng() > 0.5 ? 'left' : 'right')
    : (rng() > 0.5 ? 'top' : 'bottom');
  const baseOffset = 0.65 + rng() * 0.10; // coast at 65–75%, giving ~70% water
  const cfg: CoastConfig = { axis, waterSide, baseOffset };

  const coastPts = buildCoastlinePoints(noise, cfg);
  const islands  = buildIslands(noise, rng, cfg, coastPts);
  const depthFn  = buildDepthField(coastPts, noise, cfg, islands);

  const variationValue = 1 + rng() * 5;
  const variationDir = rng() > 0.5 ? 'W' : 'E';

  const shoals = buildShoals(depthFn, rng);
  const contours = buildContours(depthFn, [5, 10, 20]);

  return {
    seed,
    variation: variationValue,
    variationDir,
    cfg,
    coastPts,
    islands,
    depthFn,
    soundings: buildSoundings(depthFn, rng, contours),
    contours,
    shoals,
    landmarks: placeLandmarks(coastPts, depthFn, rng, cfg, islands),
    harbour: buildHarbour(coastPts, rng, cfg),
    cardinalBuoys: buildCardinalBuoys(shoals),
    compassRose: placeCompassRose(depthFn, rng, islands),
    anchorages: buildAnchorages(depthFn, rng),
  };
}

export function renderChartToSVG(svgEl: SVGSVGElement, data: ChartData): void {
  renderChart(svgEl, data, { outer: compassOuterSvg, inner: compassInnerSvg });
}
