import { createNoise2D, type Noise2D } from './noise.ts';
import { SVG_W, SVG_H, latLonToSVG, CHART_BOUNDS, svgToLatLon } from './coords.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LandmarkType = 'lighthouse' | 'church' | 'mast' | 'tower';

export interface Landmark {
  type: LandmarkType;
  x: number;    // SVG space
  y: number;
  name: string;
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
  islands: Array<Array<{ x: number; y: number }>>;
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
  islands: Array<Array<{ x: number; y: number }>>,
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

  // Pre-compute island polygons as point arrays for point-in-polygon tests
  const islandPolys = islands;

  const pointInIsland = (px: number, py: number): boolean => {
    for (const poly of islandPolys) {
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

function buildIslands(
  noise: Noise2D,
  rng: () => number,
  cfg: CoastConfig,
  coastPts: Array<{ x: number; y: number }>,
): Array<Array<{ x: number; y: number }>> {
  const islands: Array<Array<{ x: number; y: number }>> = [];
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
    if (islands.some(isl => {
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

    if (valid && poly.length === SIDES) islands.push(poly);
  }

  return islands;
}

// ── Soundings ─────────────────────────────────────────────────────────────────

function buildSoundings(depthFn: DepthFn, rng: () => number): Sounding[] {
  const soundings: Sounding[] = [];
  for (let attempt = 0; attempt < 600; attempt++) {
    const x = rng() * SVG_W;
    const y = rng() * SVG_H;
    const d = depthFn(x, y);
    if (d < 2) continue;
    if (x < 30 || x > SVG_W - 30 || y < 30 || y > SVG_H - 30) continue;
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
    const x = rng() * SVG_W;
    const y = rng() * SVG_H;
    const d = depthFn(x, y);
    if (d < 3 || d > 15) continue;
    shoals.push({ x, y, r: 8 + rng() * 20 });
  }
  return shoals;
}

// ── Landmarks ─────────────────────────────────────────────────────────────────

function placeLandmarks(
  coastPts: Array<{ x: number; y: number }>,
  depthFn: DepthFn,
  rng: () => number,
  cfg: CoastConfig,
): Landmark[] {
  const landmarks: Landmark[] = [];
  const types: LandmarkType[] = ['lighthouse', 'church', 'mast', 'tower'];

  for (const type of types) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const ci = Math.floor(rng() * (coastPts.length - 3));
      const cp = coastPts[ci]!;
      // Offset into land side
      let x: number, y: number;
      if (cfg.axis === 'vertical') {
        const sign = cfg.waterSide === 'left' ? 1 : -1;
        x = cp.x + sign * (15 + rng() * 120);
        y = cp.y + (rng() - 0.5) * 60;
      } else {
        x = cp.x + (rng() - 0.5) * 60;
        const sign = cfg.waterSide === 'top' ? 1 : -1;
        y = cp.y + sign * (15 + rng() * 120);
      }
      if (x < 0 || x > SVG_W || y < 0 || y > SVG_H) continue;
      if (depthFn(x, y) > 0) continue; // must be on land
      if (landmarks.some(l => Math.hypot(l.x - x, l.y - y) < 120)) continue;
      landmarks.push({ type, x, y, name: landmarkName(type, rng) });
      break;
    }
  }
  return landmarks;
}

function landmarkName(type: LandmarkType, rng: () => number): string {
  const names: Record<LandmarkType, string[]> = {
    lighthouse: ['Pt. Moran Lt', 'Breakwater Lt', 'Haven Lt', 'Old Head Lt', 'Black Rock Lt'],
    church:     ["St. Brendan's", 'All Saints', "St. Michael's", 'Chapel Hill', 'Old Church'],
    mast:       ['Radio Mast', 'TV Mast', 'Signal Mast', 'Comm. Tower'],
    tower:      ['Water Twr', 'Mill Tower', 'Old Tower', 'Barrow Twr'],
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

  const names = ['Port Carrig', 'Havenmouth', 'Dunmore Hbr', 'Cwm Harbour'] as const;
  return {
    entrance, portPier, stbdPier, portInner, stbdInner, buoys,
    name: names[Math.floor(rng() * names.length)]!,
  };
}

// ── Cardinal buoys ────────────────────────────────────────────────────────────

function buildCardinalBuoys(shoals: Shoal[]): CardinalBuoy[] {
  return shoals.slice(0, 3).map(s => ({
    x: s.x,
    y: s.y - 35,
    type: 'north' as const,
    name: 'N Card',
  }));
}

// ── Compass rose placement ────────────────────────────────────────────────────

function placeCompassRose(depthFn: DepthFn, rng: () => number): CompassRose {
  for (let attempt = 0; attempt < 500; attempt++) {
    const x = SVG_W * (0.05 + rng() * 0.9);
    const y = SVG_H * (0.05 + rng() * 0.9);
    if (depthFn(x, y) < 20) continue;
    if (x < 150 || y < 150 || x > SVG_W - 150 || y > SVG_H - 150) continue;
    return { x, y, r: 90 };
  }
  return { x: SVG_W * 0.18, y: SVG_H * 0.25, r: 90 };
}

// ── Anchorages ────────────────────────────────────────────────────────────────

function buildAnchorages(depthFn: DepthFn, rng: () => number): Anchorage[] {
  const anchorages: Anchorage[] = [];
  const names = ['Gull Roads', 'Blind Cove', 'The Haven', 'East Road'] as const;
  for (let attempt = 0; attempt < 400 && anchorages.length < 2; attempt++) {
    const x = rng() * SVG_W;
    const y = rng() * SVG_H;
    const d = depthFn(x, y);
    if (d < 5 || d > 20) continue;
    if (anchorages.some(a => Math.hypot(a.x - x, a.y - y) < 100)) continue;
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

function renderChart(svgEl: SVGSVGElement, data: ChartData): void {
  svgEl.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
  svgEl.setAttribute('width', String(SVG_W));
  svgEl.setAttribute('height', String(SVG_H));
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  const { coastPts, islands, cfg, soundings, contours, shoals, landmarks, harbour,
          cardinalBuoys, compassRose, anchorages, variation, variationDir, seed } = data;

  // Clip path
  const defs = el('defs', {}, svgEl);
  const clip = el('clipPath', { id: 'chartClip' }, defs);
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H }, clip);

  // Water
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H, fill: '#b8d4e8' }, svgEl);

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
  for (const islandPoly of islands) {
    el('polygon', {
      points: polyPts(islandPoly),
      fill: '#f5f0dc', stroke: '#8b7355', 'stroke-width': 1.5,
    }, landG);
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
  renderCompassRose(compassRose, svgEl, variation, variationDir);
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
  const { x, y } = b;
  el('rect', { x: x - 5, y: y - 20, width: 10, height: 10, fill: '#000000' }, parent);
  el('rect', { x: x - 5, y: y - 10, width: 10, height: 10, fill: '#ffcc00' }, parent);
  el('polygon', { points: `${x},${y - 32} ${x - 6},${y - 22} ${x + 6},${y - 22}`, fill: '#000' }, parent);
  el('polygon', { points: `${x},${y - 40} ${x - 6},${y - 30} ${x + 6},${y - 30}`, fill: '#000' }, parent);
  el('line', { x1: x, y1: y, x2: x, y2: y + 14, stroke: '#333', 'stroke-width': 1.5 }, parent);
  txt('N', { x: x + 9, y: y - 10, 'font-size': 9, fill: '#000', 'font-weight': 'bold' }, parent);
}

function drawLandmark(lm: Landmark, parent: Element): void {
  const { x, y, type, name } = lm;
  switch (type) {
    case 'lighthouse':
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
  }
  txt(name, {
    x: x + 12, y: y + 4,
    'font-size': 10, fill: '#1a5276',
    'font-family': 'Georgia, serif', 'font-style': 'italic',
  }, parent);
}

function renderGrid(svgEl: SVGSVGElement): void {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  const M = BORDER_MARGIN;
  const gG = grp('grid', svgEl);

  // ── Graticule grid lines (every 5′) ──────────────────────────────────────────
  const step = 5 / 60;

  for (let lat = Math.ceil(minLat / step) * step; lat <= maxLat + 1e-9; lat += step) {
    const { y } = latLonToSVG(lat, minLon);
    el('line', { x1: 0, y1: y, x2: SVG_W, y2: y, stroke: '#6699bb', 'stroke-width': 0.4, opacity: 0.5 }, gG);
  }
  for (let lon = Math.ceil(minLon / step) * step; lon <= maxLon + 1e-9; lon += step) {
    const { x } = latLonToSVG(minLat, lon);
    el('line', { x1: x, y1: 0, x2: x, y2: SVG_H, stroke: '#6699bb', 'stroke-width': 0.4, opacity: 0.5 }, gG);
  }

  // ── Chart frame ───────────────────────────────────────────────────────────────
  el('rect', { x: 0, y: 0, width: SVG_W, height: SVG_H, fill: 'none', stroke: '#1a3a5c', 'stroke-width': 2.5 }, gG);

  // ── Helper: degree + decimal-minutes → string ─────────────────────────────────
  const fmtLat = (lat: number): string => {
    const d = Math.floor(Math.abs(lat));
    const m = (Math.abs(lat) - d) * 60;
    const mWhole = Math.floor(m);
    const mFrac  = Math.round((m - mWhole) * 10);
    const hem = lat >= 0 ? 'N' : 'S';
    return mFrac > 0
      ? `${d}°${mWhole.toString().padStart(2,'0')}.${mFrac}'${hem}`
      : `${d}°${mWhole.toString().padStart(2,'0')}'${hem}`;
  };
  const fmtLon = (lon: number): string => {
    const d = Math.floor(Math.abs(lon));
    const m = (Math.abs(lon) - d) * 60;
    const mWhole = Math.floor(m);
    const mFrac  = Math.round((m - mWhole) * 10);
    const hem = lon >= 0 ? 'E' : 'W';
    return mFrac > 0
      ? `${d.toString().padStart(3,'0')}°${mWhole.toString().padStart(2,'0')}.${mFrac}'${hem}`
      : `${d.toString().padStart(3,'0')}°${mWhole.toString().padStart(2,'0')}'${hem}`;
  };

  const FONT = 'Georgia, serif';
  const COL  = '#1a3a5c';

  // Ticks and labels are drawn on the canvas overlay (see drawBorderTicks in canvas.ts)
}

function renderCompassRose(rose: CompassRose, svgEl: SVGSVGElement, variation: number, variationDir: 'E' | 'W'): void {
  const { x, y } = rose;
  const r = 160;
  const gG = grp('compass-rose', svgEl);

  // Background circle
  el('circle', { cx: x, cy: y, r: r + 8, fill: 'rgba(255,255,255,0.2)', stroke: '#c033c0', 'stroke-width': 1 }, gG);

  // ── Outer ring: 360 points at 1° increments with major marks every 10° ──
  for (let deg = 0; deg < 360; deg++) {
    const rad = ((deg - 90) * Math.PI) / 180;
    const isMajor = deg % 10 === 0; // every 10°
    const positionInGroup = deg % 10; // 0-9 within each 10° group
    const isMidMinor = isMajor ? false : positionInGroup === 5; // every 5th minor marker

    let len, width;
    if (isMajor) {
      len = r * 0.16;
      width = 1.2;
    } else if (isMidMinor) {
      len = r * 0.10; // medium minor marker
      width = 0.7;
    } else {
      len = r * 0.06; // small minor marker
      width = 0.4;
    }

    const innerX = x + (r + 2) * Math.cos(rad); // Start from outer radius edge
    const outerX = x + (r + 2 + len) * Math.cos(rad); // Extend outward
    const innerY = y + (r + 2) * Math.sin(rad);
    const outerY = y + (r + 2 + len) * Math.sin(rad);

    el('line', {
      x1: innerX, y1: innerY, x2: outerX, y2: outerY,
      stroke: '#c033c0', 'stroke-width': width, 'stroke-linecap': 'round',
    }, gG);

    // Label outer ring degrees (every 10°, excluding 0°)
    if (isMajor && deg !== 0) {
      const labelRad = ((deg - 90) * Math.PI) / 180;
      const labelDist = r + 28;
      const labelX = x + labelDist * Math.cos(labelRad);
      const labelY = y + labelDist * Math.sin(labelRad);
      txt(String(deg), {
        x: labelX, y: labelY,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 8, fill: '#c033c0', 'font-family': 'sans-serif',
      }, gG);
    }
  }

  // North star above the 0° point on outer ring
  const starRad = ((-90) * Math.PI) / 180;
  const starX = x + (r + 20) * Math.cos(starRad);
  const starY = y + (r + 20) * Math.sin(starRad);
  drawStar(starX, starY, 5, gG);

  // Label "T" for True North on outer ring
  txt('T', {
    x: x + (r - 8) * Math.cos(starRad),
    y: y + (r - 8) * Math.sin(starRad),
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-size': 10, fill: '#c033c0', 'font-family': 'sans-serif',
  }, gG);

  // ── Inner ring: 12 points at 30° increments (Magnetic North) ──
  // Rotate inner ring by variation amount so magnetic north aligns correctly
  const variationRad = variationDir === 'E' ? (variation * Math.PI) / 180 : -(variation * Math.PI) / 180;
  const innerRadius = r * 0.58;
  
  for (let i = 0; i < 12; i++) {
    const deg = i * 30;
    const rad = ((deg - 90) * Math.PI) / 180 + variationRad; // Add variation rotation
    const len = r * 0.10;

    const outerX = x + innerRadius * Math.cos(rad);
    const outerY = y + innerRadius * Math.sin(rad);
    const innerX = x + (innerRadius - len) * Math.cos(rad);
    const innerY = y + (innerRadius - len) * Math.sin(rad);

    el('line', {
      x1: innerX, y1: innerY, x2: outerX, y2: outerY,
      stroke: '#c033c0', 'stroke-width': 0.8, 'stroke-linecap': 'round',
    }, gG);

    // Label inner ring degrees (every 30°, excluding 0°)
    if (deg !== 0) {
      const labelRad = ((deg - 90) * Math.PI) / 180 + variationRad;
      const labelDist = innerRadius + 12;
      const labelX = x + labelDist * Math.cos(labelRad);
      const labelY = y + labelDist * Math.sin(labelRad);
      txt(String(deg), {
        x: labelX, y: labelY,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-size': 7, fill: '#c033c0', 'font-family': 'sans-serif',
      }, gG);
    }
  }

  // Inner circle outline
  el('circle', { cx: x, cy: y, r: innerRadius, fill: 'none', stroke: '#c033c0', 'stroke-width': 0.8 }, gG);

  // Magnetic North indicator (small "M" on inner ring at top, rotated by variation)
  const magRad = ((-90) * Math.PI) / 180 + variationRad;
  txt('M', {
    x: x + (innerRadius - 14) * Math.cos(magRad),
    y: y + (innerRadius - 14) * Math.sin(magRad),
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-size': 10, fill: '#c033c0', 'font-family': 'sans-serif',
  }, gG);

  // ── Central hub ──
  el('circle', { cx: x, cy: y, r: r * 0.04, fill: '#c033c0', stroke: '#c033c0', 'stroke-width': 0.8 }, gG);

  // ── Curved text: Variation ──
  const textRadius = r * 0.30;
  const variationText = `var ${variation.toFixed(1)}° ${variationDir}`;
  drawCurvedText(x, y, textRadius, variationText, gG, '#c033c0', 9);
}

/**
 * drawStar — simple 5-point star at (cx, cy) with size sz
 */
function drawStar(cx: number, cy: number, sz: number, parent: Element): void {
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 10; i++) {
    const rad = ((i * 36 - 90) * Math.PI) / 180;
    const radius = i % 2 === 0 ? sz : sz * 0.4;
    pts.push({
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    });
  }
  const ptStr = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  el('polygon', { points: ptStr, fill: '#c033c0', stroke: '#c033c0', 'stroke-width': 0.5 }, parent);
}

function renderScaleBar(svgEl: SVGSVGElement): void {
  const gG = grp('scale-bar', svgEl);
  
  // Calculate 1 NM at chart center latitude (52°15'N)
  const centerLat = 52.25;
  const { y: y0 } = latLonToSVG(centerLat, -4.0);
  const { y: y1 } = latLonToSVG(centerLat + 1 / 60, -4.0); // 1 minute = 1 NM
  const pxPerNM = Math.abs(y1 - y0);
  
  const bx = SVG_W * 0.04;
  const by = SVG_H - 40;
  const bw = pxPerNM * 5;

  el('rect', { x: bx, y: by - 8, width: bw, height: 8, fill: '#1a3a5c' }, gG);
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 1) {
      el('rect', { x: bx + i * pxPerNM, y: by - 8, width: pxPerNM, height: 8, fill: '#fff' }, gG);
    }
  }
  el('rect', { x: bx, y: by - 8, width: bw, height: 8, fill: 'none', stroke: '#1a3a5c', 'stroke-width': 1 }, gG);

  for (let nm = 0; nm <= 5; nm++) {
    const tx = bx + nm * pxPerNM;
    el('line', { x1: tx, y1: by - 10, x2: tx, y2: by, stroke: '#1a3a5c', 'stroke-width': 1 }, gG);
    txt(String(nm), { x: tx, y: by + 10, 'text-anchor': 'middle', 'font-size': 9, fill: '#1a3a5c', 'font-family': 'Georgia, serif' }, gG);
  }
  txt('Nautical Miles', {
    x: bx + bw / 2, y: by + 20,
    'text-anchor': 'middle', 'font-size': 9,
    fill: '#1a3a5c', 'font-style': 'italic', 'font-family': 'Georgia, serif',
  }, gG);
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
    [`Magnetic Variation: ${variation.toFixed(1)}°${variationDir} (2025)`, 9, '#884400', 'normal'],
    ['FOR TRAINING USE ONLY – NOT FOR NAVIGATION', 8, '#cc2222', 'bold'],
    [`Seed: ${seed}`, 8, '#888', 'normal'],
  ];

  let ly = by + 16;
  for (const [content, size, fill, weight] of lines) {
    txt(content, { x: bx + 8, y: ly, 'font-size': size, fill, 'font-weight': weight, 'font-family': 'Georgia, serif' }, gG);
    ly += size + 5;
  }
}

/**
 * drawCurvedText — render text along a circular arc
 */
function drawCurvedText(
  cx: number,
  cy: number,
  radius: number,
  text: string,
  parent: Element,
  color: string,
  fontSize: number,
): void {
  const defs = parent.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const pathId = `curve-${Math.random().toString(36).substr(2, 9)}`;
  const path = parent.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'path');

  // Semicircle at the bottom (below center)
  const startAngle = (-90 - (text.length * 2.5)) * (Math.PI / 180);
  const endAngle = (-90 + (text.length * 2.5)) * (Math.PI / 180);

  const startX = cx + radius * Math.cos(startAngle);
  const startY = cy + radius * Math.sin(startAngle);
  const endX = cx + radius * Math.cos(endAngle);
  const endY = cy + radius * Math.sin(endAngle);

  const largeArc = text.length > 15 ? 1 : 0;
  const d = `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`;

  path.setAttribute('id', pathId);
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  defs.appendChild(path);
  parent.appendChild(defs);

  // textPath element
  const textElement = parent.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'text') as SVGTextElement;
  textElement.setAttribute('font-size', String(fontSize));
  textElement.setAttribute('fill', color);
  textElement.setAttribute('font-family', 'sans-serif');
  textElement.setAttribute('text-anchor', 'middle');

  const textPath = parent.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'textPath') as SVGTextPathElement;



  textPath.setAttribute('href', `#${pathId}`);
  textPath.setAttribute('startOffset', '50%');
  textPath.textContent = text;

  textElement.appendChild(textPath);
  parent.appendChild(textElement);
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

  const variationValue = 3 + rng() * 2;
  const variationDir = rng() > 0.5 ? 'W' : 'E';

  const shoals = buildShoals(depthFn, rng);

  return {
    seed,
    variation: variationValue,
    variationDir,
    cfg,
    coastPts,
    islands,
    depthFn,
    soundings: buildSoundings(depthFn, rng),
    contours: buildContours(depthFn, [5, 10, 20]),
    shoals,
    landmarks: placeLandmarks(coastPts, depthFn, rng, cfg),
    harbour: buildHarbour(coastPts, rng, cfg),
    cardinalBuoys: buildCardinalBuoys(shoals),
    compassRose: placeCompassRose(depthFn, rng),
    anchorages: buildAnchorages(depthFn, rng),
  };
}

export function renderChartToSVG(svgEl: SVGSVGElement, data: ChartData): void {
  renderChart(svgEl, data);
}
