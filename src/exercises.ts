/**
 * exercises.ts — ground truth generation, scoring, and canvas overlay rendering
 */

import {
  distanceNM, trueBearing, destinationPoint, formatLatLon,
  latLonToSVG, svgToLatLon, svgToScreen, SVG_W, SVG_H,
  type LatLon, type SVGPoint,
} from './coords.ts';
import type { ChartData, Landmark, Shoal } from './chartGen.ts';
import { state, svgLineBearing, type DrawnLine } from './tools.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkbookValues {
  course: number;
  eta: string;
  distance: number;
  speed: number;
}

export interface ScoreResult {
  pass: boolean;
  html: string;
  trueSVG?: SVGPoint;
  submittedSVG?: SVGPoint;
  trueSVGDR?: SVGPoint;
  trueSVGFix?: SVGPoint;
}

export interface BearingInfo {
  lm: Landmark;
  lmLat: number;
  lmLon: number;
  trueBear: number;
  magBear: number;
}

// Discriminated union for all exercise types
export type Exercise =
  | Ex1DeadReckoning
  | Ex2CourseToSteer
  | Ex3CrossBearing
  | Ex4DistanceETA
  | Ex5ClearingBearing
  | Ex6SetAndDrift;

interface BaseExercise {
  title: string;
  infoHTML: string;
  enabledTools: string[];
}

export interface Ex1DeadReckoning extends BaseExercise {
  id: 1;
  departure: LatLon & SVGPoint;
  courseDeg: number;
  speedKn: number;
  timeMin: number;
  drPos: LatLon;
  svgDR: SVGPoint;
}

export interface Ex2CourseToSteer extends BaseExercise {
  id: 2;
  departure:   LatLon & SVGPoint;
  destination: LatLon & SVGPoint;
  trueCourse: number;
  magCourse:  number;
}

export interface Ex3CrossBearing extends BaseExercise {
  id: 3;
  vessel:   LatLon & SVGPoint;
  bearings: BearingInfo[];
  hazard:   Shoal | null;
}

export interface Ex4DistanceETA extends BaseExercise {
  id: 4;
  departure:   LatLon & SVGPoint;
  destination: LatLon & SVGPoint;
  trueDist: number;
  speedKn:  number;
  depTime:  string;
  eta:      string;
  timeMin:  number;
}

export interface Ex5ClearingBearing extends BaseExercise {
  id: 5;
  hazard: Shoal;
  lm:     Landmark | null;
  hazLat: number; hazLon: number;
  lmLat:  number; lmLon:  number;
  clearingBearing: number;
}

export interface Ex6SetAndDrift extends BaseExercise {
  id: 6;
  departure: LatLon & SVGPoint;
  courseDeg: number;
  speedKn:   number;
  timeMin:   number;
  drPos:  LatLon;
  fixPos: LatLon;
  setCurrent: number;
  driftRate:  number;
  svgDR:  SVGPoint;
  svgFix: SVGPoint;
}

// ── Seeded PRNG ───────────────────────────────────────────────────────────────

function seededRNG(seed: number): () => number {
  let s = ((seed ^ 0x12345678) >>> 0) || 1;
  return (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomInWater(
  depthFn: (x: number, y: number) => number,
  rng: () => number,
  minDepth = 5,
): LatLon & SVGPoint {
  for (let i = 0; i < 500; i++) {
    const svgX = rng() * SVG_W * 0.52;
    const svgY = 50 + rng() * (SVG_H - 100);
    if (depthFn(svgX, svgY) >= minDepth) {
      const { lat, lon } = svgToLatLon(svgX, svgY);
      return { lat, lon, x: svgX, y: svgY };
    }
  }
  const x = SVG_W * 0.15, y = SVG_H * 0.5;
  return { ...svgToLatLon(x, y), x, y };
}

function gaussianRandom(): number {
  const u = Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function angleDiff(a: number, b: number): number {
  let d = ((a - b) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

// ── Exercise generators ───────────────────────────────────────────────────────

export function generateExercise1(cd: ChartData): Ex1DeadReckoning {
  const rng = seededRNG(cd.seed + 1001);
  const dep = randomInWater(cd.depthFn, rng);
  const courseDeg = Math.floor(rng() * 360);
  const speedKn   = 4 + rng() * 6;
  const timeMin   = 20 + Math.floor(rng() * 100);
  const drPos     = destinationPoint(dep.lat, dep.lon, courseDeg, speedKn * (timeMin / 60));
  const svgDR     = latLonToSVG(drPos.lat, drPos.lon);

  return {
    id: 1,
    title: 'Dead Reckoning',
    departure: dep, courseDeg, speedKn, timeMin, drPos, svgDR,
    infoHTML: `
      <h4>Exercise 1: Dead Reckoning</h4>
      <p>Departure position marked on chart (⊕).</p>
      <p><b>Course:</b> ${courseDeg}°T &nbsp; <b>Speed:</b> ${speedKn.toFixed(1)} kn</p>
      <p><b>Time underway:</b> ${Math.floor(timeMin / 60)}h ${timeMin % 60}min</p>
      <p>Plot the DR position and mark it, then click <b>Submit</b>.</p>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'dividers', 'plotter'],
  };
}

export function generateExercise2(cd: ChartData): Ex2CourseToSteer {
  const rng = seededRNG(cd.seed + 2002);
  const dep = randomInWater(cd.depthFn, rng);
  let dest = randomInWater(cd.depthFn, rng);
  for (let i = 0; i < 100; i++) {
    const c = randomInWater(cd.depthFn, rng);
    if (distanceNM(dep.lat, dep.lon, c.lat, c.lon) > 2) { dest = c; break; }
  }
  const tc = trueBearing(dep.lat, dep.lon, dest.lat, dest.lon);
  const mc = ((tc + cd.variation) % 360 + 360) % 360;

  return {
    id: 2,
    title: 'Course to Steer',
    departure: dep, destination: dest,
    trueCourse: tc, magCourse: mc,
    infoHTML: `
      <h4>Exercise 2: Course to Steer</h4>
      <p>Departure (⊕) and destination (⊗) marked on chart.</p>
      <p>1. Read the true course using parallel rules or plotter.</p>
      <p>2. Apply variation (${cd.variation}°W) → magnetic course.</p>
      <p>3. Enter both values in the workbook, then click <b>Submit</b>.</p>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter'],
  };
}

export function generateExercise3(cd: ChartData): Ex3CrossBearing {
  const rng = seededRNG(cd.seed + 3003);
  const vessel = randomInWater(cd.depthFn, rng, 10);
  const lms = cd.landmarks.slice(0, 3);

  const bearings: BearingInfo[] = lms.map(lm => {
    const { lat: lmLat, lon: lmLon } = svgToLatLon(lm.x, lm.y);
    const tb   = trueBearing(vessel.lat, vessel.lon, lmLat, lmLon);
    const err  = gaussianRandom() * 2;
    const mag  = Math.round(((tb + cd.variation + err) % 360 + 360) % 360 * 10) / 10;
    return { lm, lmLat, lmLon, trueBear: tb, magBear: mag };
  });

  return {
    id: 3,
    title: 'Fix by Cross Bearing',
    vessel, bearings,
    hazard: cd.shoals[0] ?? null,
    infoHTML: `
      <h4>Exercise 3: Fix by Cross Bearing</h4>
      <p>Magnetic bearings from vessel to landmarks:</p>
      ${bearings.map(b => `<p><b>${b.lm.name}:</b> ${b.magBear.toFixed(1)}°M</p>`).join('')}
      <p>Variation: ${cd.variation}°W</p>
      <p>1. Convert to true. 2. Plot reciprocal bearing lines from each landmark.
      3. Mark fix at cocked hat. Then click <b>Submit</b>.</p>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter', 'compass'],
  };
}

export function generateExercise4(cd: ChartData): Ex4DistanceETA {
  const rng = seededRNG(cd.seed + 4004);
  const dep = randomInWater(cd.depthFn, rng);
  let dest = randomInWater(cd.depthFn, rng);
  for (let i = 0; i < 100; i++) {
    const c = randomInWater(cd.depthFn, rng);
    if (distanceNM(dep.lat, dep.lon, c.lat, c.lon) > 1.5) { dest = c; break; }
  }
  const trueDist = distanceNM(dep.lat, dep.lon, dest.lat, dest.lon);
  const speedKn  = 4 + rng() * 6;
  const depHour  = 8 + Math.floor(rng() * 8);
  const depMinArr = ['00', '15', '30', '45'] as const;
  const depTime  = `${depHour}:${depMinArr[Math.floor(rng() * 4)]!}`;
  const [hh = 9, mm = 0] = depTime.split(':').map(Number);
  const timeMin  = (trueDist / speedKn) * 60;
  const etaMins  = hh * 60 + mm + timeMin;
  const etaH     = Math.floor(etaMins / 60) % 24;
  const etaM     = Math.round(etaMins % 60);
  const eta      = `${String(etaH).padStart(2, '0')}:${String(etaM).padStart(2, '0')}`;

  return {
    id: 4,
    title: 'Distance & ETA',
    departure: dep, destination: dest,
    trueDist, speedKn, depTime, eta, timeMin,
    infoHTML: `
      <h4>Exercise 4: Distance &amp; ETA</h4>
      <p>Course line from ⊕ to ⊗ is shown.</p>
      <p><b>Speed:</b> ${speedKn.toFixed(1)} kn &nbsp; <b>Departure:</b> ${depTime}</p>
      <p>1. Measure distance with dividers against latitude scale.</p>
      <p>2. Use S-T-D calculator to get time underway.</p>
      <p>3. Add to departure time → enter ETA in workbook, then click <b>Submit</b>.</p>
    `,
    enabledTools: ['dividers', 'std'],
  };
}

export function generateExercise5(cd: ChartData): Ex5ClearingBearing {
  const fallbackShoal: Shoal = { x: SVG_W * 0.3, y: SVG_H * 0.5, r: 20 };
  const hazard = cd.shoals[0] ?? fallbackShoal;
  const { lat: hazLat, lon: hazLon } = svgToLatLon(hazard.x, hazard.y);

  const lm = cd.landmarks[0] ?? null;
  const lmPos = lm
    ? svgToLatLon(lm.x, lm.y)
    : { lat: hazLat + 0.05, lon: hazLon + 0.05 };

  const clearingBearing = Math.round(
    trueBearing(lmPos.lat, lmPos.lon, hazLat, hazLon) * 10,
  ) / 10;

  return {
    id: 5,
    title: 'Clearing Bearing',
    hazard, lm,
    hazLat, hazLon,
    lmLat: lmPos.lat, lmLon: lmPos.lon,
    clearingBearing,
    infoHTML: `
      <h4>Exercise 5: Clearing Bearing</h4>
      <p>Hazard (shoal) marked on chart.</p>
      <p>Landmark: <b>${lm?.name ?? 'Landmark'}</b>.</p>
      <p>Draw a clearing bearing line such that maintaining a bearing
      <b>less than</b> the clearing bearing from the landmark keeps you clear.</p>
      <p>State the clearing bearing value, then click <b>Submit</b>.</p>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter'],
  };
}

export function generateExercise6(cd: ChartData): Ex6SetAndDrift {
  const rng = seededRNG(cd.seed + 6006);
  const dep = randomInWater(cd.depthFn, rng, 10);
  const courseDeg = Math.floor(rng() * 360);
  const speedKn   = 4 + rng() * 4;
  const timeMin   = 30 + Math.floor(rng() * 60);
  const timeHr    = timeMin / 60;

  const drPos = destinationPoint(dep.lat, dep.lon, courseDeg, speedKn * timeHr);
  const setCurrent = Math.floor(rng() * 360);
  const driftRate  = 0.3 + rng() * 1.2;
  const fixPos     = destinationPoint(drPos.lat, drPos.lon, setCurrent, driftRate * timeHr);

  return {
    id: 6,
    title: 'Set and Drift',
    departure: dep, courseDeg, speedKn, timeMin,
    drPos, fixPos, setCurrent, driftRate,
    svgDR:  latLonToSVG(drPos.lat, drPos.lon),
    svgFix: latLonToSVG(fixPos.lat, fixPos.lon),
    infoHTML: `
      <h4>Exercise 6: Set and Drift</h4>
      <p>Dep (⊕) — course ${courseDeg}°T, speed ${speedKn.toFixed(1)} kn, ${timeMin} min.</p>
      <p>Fix (⊗) is shown after elapsed time.</p>
      <p>1. Plot DR position. 2. Draw vector DR→Fix.
      3. Measure set (direction) and drift rate. Then click <b>Submit</b>.</p>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'dividers', 'plotter'],
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function generateExercise(id: number, cd: ChartData): Exercise | null {
  switch (id) {
    case 1: return generateExercise1(cd);
    case 2: return generateExercise2(cd);
    case 3: return generateExercise3(cd);
    case 4: return generateExercise4(cd);
    case 5: return generateExercise5(cd);
    case 6: return generateExercise6(cd);
    default: return null;
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export function scoreExercise(
  ex: Exercise,
  cd: ChartData,
  lines: DrawnLine[],
  wbValues: WorkbookValues,
): ScoreResult {
  switch (ex.id) {
    case 1: return scoreEx1(ex, lines);
    case 2: return scoreEx2(ex, cd, wbValues);
    case 3: return scoreEx3(ex, lines);
    case 4: return scoreEx4(ex, wbValues);
    case 5: return scoreEx5(ex, lines);
    case 6: return scoreEx6(ex, lines);
  }
}

function scoreEx1(ex: Ex1DeadReckoning, lines: DrawnLine[]): ScoreResult {
  if (!lines.length) {
    return { pass: false, html: '<p class="score-bad">No lines drawn. Plot the DR position first.</p>' };
  }
  const last = lines[lines.length - 1]!;
  const { lat, lon } = svgToLatLon(last.svgX2, last.svgY2);
  const err = distanceNM(lat, lon, ex.drPos.lat, ex.drPos.lon);
  const cls     = err < 0.1 ? 'score-good' : err < 0.3 ? 'score-ok' : 'score-bad';
  const verdict = err < 0.1 ? 'Excellent'  : err < 0.3 ? 'Good'     : 'Retry';

  return {
    pass: err < 0.3,
    html: `
      <p>True DR: <b>${formatLatLon(ex.drPos.lat, ex.drPos.lon)}</b></p>
      <p>Your mark: <b>${formatLatLon(lat, lon)}</b></p>
      <p class="${cls}">Error: ${err.toFixed(2)} NM — ${verdict}</p>
      ${err > 0.3 ? '<p>Check your course, speed, and time calculations.</p>' : ''}
    `,
    trueSVG: ex.svgDR,
    submittedSVG: { x: last.svgX2, y: last.svgY2 },
  };
}

function scoreEx2(ex: Ex2CourseToSteer, cd: ChartData, wbValues: WorkbookValues): ScoreResult {
  const subTrue = wbValues.course;
  const subMag  = subTrue + cd.variation;
  const errT    = Math.abs(angleDiff(subTrue, ex.trueCourse));
  const errM    = Math.abs(angleDiff(subMag,  ex.magCourse));
  const passT   = errT <= 1;
  const passM   = errM <= 2;

  let html = `
    <p>True course: <b>${ex.trueCourse.toFixed(1)}°T</b> — you entered ${subTrue.toFixed(1)}°T
      <span class="${passT ? 'score-good' : 'score-bad'}">(error ${errT.toFixed(1)}°)</span></p>
    <p>Magnetic: <b>${ex.magCourse.toFixed(1)}°M</b> — computed ${subMag.toFixed(1)}°M
      <span class="${passM ? 'score-good' : 'score-bad'}">(error ${errM.toFixed(1)}°)</span></p>
  `;
  if (!passT) html += '<p class="score-bad">Check your parallel rules alignment on the compass rose.</p>';
  if (!passM) html += '<p class="score-bad">Magnetic = True + Variation (°W adds).</p>';

  return { pass: passT && passM, html };
}

function scoreEx3(ex: Ex3CrossBearing, lines: DrawnLine[]): ScoreResult {
  if (!lines.length) {
    return { pass: false, html: '<p class="score-bad">No lines drawn. Plot position lines first.</p>' };
  }
  const posLines = lines.slice(-Math.min(3, lines.length));
  let html = `<p>Vessel: <b>${formatLatLon(ex.vessel.lat, ex.vessel.lon)}</b></p>`;
  let allPass = true;

  for (let i = 0; i < posLines.length; i++) {
    const line     = posLines[i]!;
    const bearing  = svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2);
    const expected = ex.bearings[i]?.trueBear ?? 0;
    const recip    = (expected + 180) % 360;
    const err      = Math.min(
      Math.abs(angleDiff(bearing, recip)),
      Math.abs(angleDiff(bearing, expected)),
    );
    const pass = err <= 4;
    if (!pass) allPass = false;
    html += `<p>Line ${i + 1} (${ex.bearings[i]?.lm?.name ?? '?'}): expected ${recip.toFixed(0)}°T, you drew ${bearing.toFixed(0)}°T
      <span class="${pass ? 'score-good' : 'score-bad'}">(error ${err.toFixed(1)}°)</span></p>`;
  }
  return { pass: allPass, html };
}

function scoreEx4(ex: Ex4DistanceETA, wbValues: WorkbookValues): ScoreResult {
  const distErr = Math.abs(wbValues.distance - ex.trueDist);
  let etaErr = Infinity;
  if (wbValues.eta?.includes(':')) {
    const [sh = 0, sm = 0] = wbValues.eta.split(':').map(Number);
    const [th = 0, tm = 0] = ex.eta.split(':').map(Number);
    etaErr = Math.abs(sh * 60 + sm - (th * 60 + tm));
  }
  const passD = distErr <= 0.1;
  const passT = etaErr <= 2;

  return {
    pass: passD && passT,
    html: `
      <p>True distance: <b>${ex.trueDist.toFixed(2)} NM</b> — you measured ${wbValues.distance.toFixed(2)} NM
        <span class="${passD ? 'score-good' : 'score-bad'}">(error ${distErr.toFixed(2)} NM)</span></p>
      <p>True ETA: <b>${ex.eta}</b> — you entered ${wbValues.eta || '—'}
        <span class="${passT ? 'score-good' : 'score-bad'}">(error ${isFinite(etaErr) ? etaErr + ' min' : '?'})</span></p>
    `,
  };
}

function scoreEx5(ex: Ex5ClearingBearing, lines: DrawnLine[]): ScoreResult {
  if (!lines.length) {
    return { pass: false, html: '<p class="score-bad">Draw the clearing bearing line first.</p>' };
  }
  const line    = lines[lines.length - 1]!;
  const bearing = svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2);
  const err     = Math.abs(angleDiff(bearing, ex.clearingBearing));
  const pass    = err <= 2;

  return {
    pass,
    html: `
      <p>Clearing bearing: <b>${ex.clearingBearing.toFixed(1)}°T</b></p>
      <p>Your line: ${bearing.toFixed(1)}°T
        <span class="${pass ? 'score-good' : 'score-bad'}">(error ${err.toFixed(1)}°)</span></p>
      <p>Safe side: bearings <b>less than ${ex.clearingBearing.toFixed(1)}°T</b> from landmark.</p>
    `,
  };
}

function scoreEx6(ex: Ex6SetAndDrift, lines: DrawnLine[]): ScoreResult {
  if (!lines.length) {
    return { pass: false, html: '<p class="score-bad">Draw the set/drift vector first.</p>' };
  }
  const line      = lines[lines.length - 1]!;
  const setBearing = svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2);
  const { lat: vLat1, lon: vLon1 } = svgToLatLon(line.svgX1, line.svgY1);
  const { lat: vLat2, lon: vLon2 } = svgToLatLon(line.svgX2, line.svgY2);
  const driftDist = distanceNM(vLat1, vLon1, vLat2, vLon2);
  const driftRate = driftDist / (ex.timeMin / 60);

  const setErr   = Math.abs(angleDiff(setBearing, ex.setCurrent));
  const driftErr = Math.abs(driftRate - ex.driftRate);
  const passSet  = setErr   <= 5;
  const passDrift = driftErr <= 0.1;

  return {
    pass: passSet && passDrift,
    html: `
      <p>True set: <b>${ex.setCurrent}°T</b> — you drew ${setBearing.toFixed(0)}°T
        <span class="${passSet ? 'score-good' : 'score-bad'}">(error ${setErr.toFixed(0)}°)</span></p>
      <p>True drift: <b>${ex.driftRate.toFixed(2)} kn</b> — computed ${driftRate.toFixed(2)} kn
        <span class="${passDrift ? 'score-good' : 'score-bad'}">(error ${driftErr.toFixed(2)} kn)</span></p>
    `,
    trueSVGDR:  ex.svgDR,
    trueSVGFix: ex.svgFix,
  };
}

// ── Canvas overlays ───────────────────────────────────────────────────────────

export function drawExerciseOverlays(
  ctx: CanvasRenderingContext2D,
  ex: Exercise,
): void {
  ctx.save();

  const mark = (svgX: number, svgY: number, style: string, label?: string): void => {
    const sc = svgToScreen(svgX, svgY);
    ctx.strokeStyle = style;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    if (label) {
      ctx.fillStyle = style;
      ctx.font = '11px Courier New';
      ctx.fillText(label, sc.x + 10, sc.y - 5);
    }
  };

  const cross = (svgX: number, svgY: number, style: string, label?: string): void => {
    const sc = svgToScreen(svgX, svgY);
    const s = 8;
    ctx.strokeStyle = style;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sc.x - s, sc.y - s); ctx.lineTo(sc.x + s, sc.y + s);
    ctx.moveTo(sc.x + s, sc.y - s); ctx.lineTo(sc.x - s, sc.y + s);
    ctx.stroke();
    if (label) {
      ctx.fillStyle = style;
      ctx.font = '11px Courier New';
      ctx.fillText(label, sc.x + 10, sc.y - 5);
    }
  };

  switch (ex.id) {
    case 1: {
      const svg = latLonToSVG(ex.departure.lat, ex.departure.lon);
      cross(svg.x, svg.y, '#22aaff',
        `Dep (${ex.courseDeg}°T ${ex.speedKn.toFixed(1)}kn ${ex.timeMin}min)`);
      break;
    }
    case 2: {
      const svgD  = latLonToSVG(ex.departure.lat, ex.departure.lon);
      const svgDt = latLonToSVG(ex.destination.lat, ex.destination.lon);
      cross(svgD.x,  svgD.y,  '#22aaff', 'Dep');
      mark(svgDt.x, svgDt.y, '#22aaff', 'Dest');
      break;
    }
    case 3: {
      for (const b of ex.bearings) {
        const svgLm = latLonToSVG(b.lmLat, b.lmLon);
        mark(svgLm.x, svgLm.y, '#ff8800', b.lm.name);
      }
      break;
    }
    case 4: {
      const svgD  = latLonToSVG(ex.departure.lat, ex.departure.lon);
      const svgDt = latLonToSVG(ex.destination.lat, ex.destination.lon);
      cross(svgD.x, svgD.y,  '#22aaff', 'Dep');
      mark(svgDt.x, svgDt.y, '#22aaff', 'Dest');
      const sc1 = svgToScreen(svgD.x, svgD.y);
      const sc2 = svgToScreen(svgDt.x, svgDt.y);
      ctx.strokeStyle = '#22aaff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(sc1.x, sc1.y); ctx.lineTo(sc2.x, sc2.y); ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 5: {
      const sc = svgToScreen(ex.hazard.x, ex.hazard.y);
      ctx.strokeStyle = '#ff2222';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sc.x, sc.y, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ff2222';
      ctx.font = '11px Courier New';
      ctx.fillText('HAZARD', sc.x + 14, sc.y - 5);
      break;
    }
    case 6: {
      const svgD  = latLonToSVG(ex.departure.lat, ex.departure.lon);
      const svgFix = latLonToSVG(ex.fixPos.lat, ex.fixPos.lon);
      cross(svgD.x,  svgD.y,  '#22aaff', 'Dep');
      mark(svgFix.x, svgFix.y, '#22aaff', 'Fix');
      break;
    }
  }
  ctx.restore();
}

export function drawExerciseFeedbackOverlay(
  ctx: CanvasRenderingContext2D,
  result: ScoreResult,
): void {
  ctx.save();

  if (result.trueSVG) {
    const sc = svgToScreen(result.trueSVG.x, result.trueSVG.y);
    ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff3333'; ctx.font = '11px Courier New';
    ctx.fillText('TRUE', sc.x + 12, sc.y - 4);
  }
  if (result.submittedSVG) {
    const sc = svgToScreen(result.submittedSVG.x, result.submittedSVG.y);
    ctx.strokeStyle = '#3399ff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, 10, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#3399ff'; ctx.font = '11px Courier New';
    ctx.fillText('YOURS', sc.x + 12, sc.y - 4);
  }
  if (result.trueSVGDR && result.trueSVGFix) {
    const sc1 = svgToScreen(result.trueSVGDR.x,  result.trueSVGDR.y);
    const sc2 = svgToScreen(result.trueSVGFix.x, result.trueSVGFix.y);
    ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(sc1.x, sc1.y); ctx.lineTo(sc2.x, sc2.y); ctx.stroke();
    ctx.fillStyle = '#ff3333'; ctx.font = '11px Courier New';
    ctx.fillText('DR',  sc1.x + 8, sc1.y - 4);
    ctx.fillText('Fix', sc2.x + 8, sc2.y - 4);
  }
  ctx.restore();
}
