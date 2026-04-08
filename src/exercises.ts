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
    const svgX = 20 + rng() * (SVG_W * 0.52 - 40);
    const svgY = 20 + rng() * (SVG_H - 40);
    if (depthFn(svgX, svgY) >= minDepth) {
      const { lat, lon } = svgToLatLon(svgX, svgY);
      return { lat, lon, x: svgX, y: svgY };
    }
  }
  // Last-resort scan: walk the chart until a water cell is found.
  for (let gx = 1; gx < 10; gx++) {
    for (let gy = 1; gy < 10; gy++) {
      const x = (gx / 10) * SVG_W * 0.5;
      const y = (gy / 10) * SVG_H;
      if (depthFn(x, y) >= minDepth) return { ...svgToLatLon(x, y), x, y };
    }
  }
  // Absolute last resort — centre of chart (accept whatever is there).
  const x = SVG_W * 0.25, y = SVG_H * 0.5;
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

// ensure SVG points lie within chart bounds (with margin)
function inBoundsSVG(p: { x: number; y: number }, margin = 20): boolean {
  return p.x >= margin && p.x <= SVG_W - margin && p.y >= margin && p.y <= SVG_H - margin;
}

// ── Exercise generators ───────────────────────────────────────────────────────

export function generateExercise1(cd: ChartData): Ex1DeadReckoning {
  const rng = seededRNG(cd.seed + 1001);

  let dep: LatLon & SVGPoint | null = null;
  let courseDeg = 0;
  let speedKn = 0;
  let timeMin = 0;
  let drPos: LatLon | null = null;
  let svgDR: SVGPoint | null = null;

  const tryPair = (cand: LatLon & SVGPoint, course: number, speed: number, time: number): boolean => {
    const dr = destinationPoint(cand.lat, cand.lon, course, speed * (time / 60));
    const svgDRCand = latLonToSVG(dr.lat, dr.lon);
    if (!inBoundsSVG(cand) || !inBoundsSVG(svgDRCand)) return false;
    if (cd.depthFn(svgDRCand.x, svgDRCand.y) < 5) return false;
    dep = cand; courseDeg = course; speedKn = speed; timeMin = time;
    drPos = dr; svgDR = svgDRCand;
    return true;
  };

  for (let i = 0; i < 400; i++) {
    const cand = randomInWater(cd.depthFn, rng);
    const candSpeed = 4 + rng() * 6;
    const candTime = 20 + Math.floor(rng() * 100);
    const candCourse = Math.floor(rng() * 360);
    if (tryPair(cand, candCourse, candSpeed, candTime)) break;
  }

  // Fallback: try every 10° course from multiple departure points until a valid pair is found.
  if (!dep) {
    outer: for (let attempt = 0; attempt < 200; attempt++) {
      const cand = randomInWater(cd.depthFn, rng);
      if (!inBoundsSVG(cand)) continue;
      const candSpeed = 4 + rng() * 6;
      const candTime = 20 + Math.floor(rng() * 100);
      for (let c = 0; c < 36; c++) {
        if (tryPair(cand, c * 10, candSpeed, candTime)) break outer;
      }
    }
  }

  const timeHours = Math.floor(timeMin / 60);
  const timeMinutes = timeMin % 60;
  const distance = speedKn * (timeMin / 60);
  const magCourse = ((courseDeg + (cd.variationDir === 'W' ? cd.variation : -cd.variation)) % 360 + 360) % 360;

  const ex = {
    id: 1,
    title: 'Dead Reckoning',
    departure: dep, courseDeg, speedKn, timeMin, drPos: drPos!, svgDR: svgDR!,
    infoHTML: `
      <h4>Exercise 1 — Dead Reckoning</h4>

      <p><b>What is Dead Reckoning?</b><br>
      Dead reckoning (DR) is estimating your current position by advancing a known past position using course, speed, and elapsed time. It assumes no current, leeway, or steering error — those effects are accounted for later by comparing the DR to an observed fix.</p>
      <br />
      <p><b>Given:</b></p>
      <ul>
        <li>Departure (⊕): ${formatLatLon(dep!.lat, dep!.lon)}</li>
        <li>True Course: <b>${courseDeg}°T</b></li>
        <li>Speed: <b>${speedKn.toFixed(1)} kn</b></li>
        <li>Time: <b>${timeHours}h ${String(timeMinutes).padStart(2, '0')}min</b> (${timeMin} min)</li>
        <li>Variation: <b>${cd.variation.toFixed(1)}°${cd.variationDir}</b></li>
      </ul>
      <br />
      <p><b>Step 1 — Calculate distance run:</b><br>
      <code>Distance = Speed × Time(h) = ${speedKn.toFixed(1)} × ${(timeMin/60).toFixed(2)} = <b>${distance.toFixed(2)} NM</b></code></p>
      <br />
      <p><b>Step 2 — Magnetic course (for the helmsman only):</b><br>
      Charts are plotted in TRUE. Variation converts true to magnetic so the helmsman can steer on the compass.<br>
      <code>Mag = True ${cd.variationDir === 'W' ? '+' : '−'} Var = ${courseDeg}° ${cd.variationDir === 'W' ? '+' : '−'} ${cd.variation.toFixed(1)}° = <b>${magCourse.toFixed(1)}°M</b></code><br>
      <em>Do NOT apply variation when plotting on the chart — plot the true course directly.</em></p>
      <br />
      <p><b>Step 3 — Set the plotter to ${courseDeg}°T:</b><br>
      Place the plotter centre on the compass rose. Rotate the body until the long-axis index aligns with <b>${courseDeg}° on the outer (TRUE) ring</b>. The inner magnetic ring is only used for compass steering.</p>
      <br />
      <p><b>Step 4 — Slide the plotter to the departure mark (⊕):</b><br>
      Keep the plotter's angle locked. Slide it across the chart — do not rotate — until the course-edge line passes through ⊕. Draw a light line along that edge.</p>
      <br />
      <p><b>Step 5 — Measure ${distance.toFixed(2)} NM along the course line:</b><br>
      Open the dividers on the <b>latitude scale</b> (left or right chart edge) to span <b>${distance.toFixed(2)} minutes of latitude = ${distance.toFixed(2)} NM</b>. One minute of latitude always equals exactly 1 NM. Place one point on ⊕ and step the dividers along the course line.</p>
      <br />
      <p><b>Step 6 — Mark and label the DR position:</b><br>
      The second divider point is your DR. Mark it with a small circle and label it <b>DR ${Math.floor(timeMin/60)}${String(timeMinutes).padStart(2,'0')}</b>. Then use the pencil tool to submit your mark.</p>
      <br />
      <p><b>Answer:</b> DR at ${formatLatLon(drPos!.lat, drPos!.lon)} — tolerance ±0.3 NM.</p>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Using the inner (magnetic) ring of the compass rose instead of the outer (true) ring.</li>
        <li>Applying variation when plotting — variation is never used on the chart, only for the compass.</li>
        <li>Measuring distance on the longitude scale — always use the latitude scale.</li>
        <li>Rotating the plotter while sliding it to the departure point.</li>
      </ul>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'dividers', 'plotter'],
  } as Ex1DeadReckoning;

  // Diagnostic test (disabled in production)
  // diagnosticEx1(ex);

  return ex;
}

export function generateExercise2(cd: ChartData): Ex2CourseToSteer {
  const rng = seededRNG(cd.seed + 2002);
  let dep = randomInWater(cd.depthFn, rng);
  let dest = randomInWater(cd.depthFn, rng);
  for (let i = 0; i < 400; i++) {
    const dCand = randomInWater(cd.depthFn, rng);
    const sCand = randomInWater(cd.depthFn, rng);
    if (inBoundsSVG(dCand) && inBoundsSVG(sCand) &&
        distanceNM(dCand.lat, dCand.lon, sCand.lat, sCand.lon) > 2) {
      dep = dCand; dest = sCand; break;
    }
  }
  const tc = trueBearing(dep.lat, dep.lon, dest.lat, dest.lon);
  const mc = ((tc + (cd.variationDir === 'W' ? cd.variation : -cd.variation)) % 360 + 360) % 360;

  const ex = {
    id: 2,
    title: 'Course to Steer',
    departure: dep, destination: dest,
    trueCourse: tc, magCourse: mc,
    infoHTML: `
      <h4>Exercise 2 — Course to Steer</h4>

      <p><b>Objective:</b> Find the true course from ⊕ to ⊗, then convert it to the magnetic course the helmsman steers by compass.</p>
      <br />
      <p><b>Given:</b></p>
      <ul>
        <li>Departure (⊕): ${formatLatLon(dep.lat, dep.lon)}</li>
        <li>Destination (⊗): ${formatLatLon(dest.lat, dest.lon)}</li>
        <li>Variation: <b>${cd.variation.toFixed(1)}°${cd.variationDir}</b></li>
      </ul>
      <br />
      <p><b>Step 1 — Read the true course from the chart:</b><br>
      Place the plotter so its long edge passes through both ⊕ and ⊗. Slide — without rotating — to the compass rose. Read the bearing on the <b>outer (TRUE) ring</b> where the edge crosses.<br>
      <b>True Course = ${tc.toFixed(1)}°T</b></p>
      <br />
      <p><b>Step 2 — Understand variation:</b><br>
      A magnetic compass points to Magnetic North, not True North. The difference is <b>variation</b>. On this chart: <b>${cd.variation.toFixed(1)}°${cd.variationDir}</b>.<br>
      Rule: <code>Magnetic = True ${cd.variationDir === 'W' ? '+' : '−'} Variation</code><br>
      (West variation adds; East variation subtracts.)</p>
      <br />
      <p><b>Step 3 — Convert to magnetic:</b><br>
      <code>${tc.toFixed(1)}° ${cd.variationDir === 'W' ? '+' : '−'} ${cd.variation.toFixed(1)}° = <b>${mc.toFixed(1)}°M</b></code><br>
      The helmsman steers <b>${mc.toFixed(1)}°M</b>. This is never plotted on the chart — it is only for the compass.</p>
      <br />
      <p><b>Step 4 — Enter in workbook:</b><br>
      True course: <b>${tc.toFixed(1)}°T</b> &nbsp;|&nbsp; Magnetic course: <b>${mc.toFixed(1)}°M</b></p>
      <br />
      <p><b>Memory aid — TVMDC:</b><br>
      <code>True → Variation → Magnetic → Deviation → Compass</code><br>
      Going left-to-right (T→C): West variation adds, East subtracts.<br>
      Going right-to-left (C→T): reverse the signs.</p>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Reading the inner (magnetic) ring of the compass rose instead of the outer (true) ring.</li>
        <li>Applying the wrong sign for variation direction.</li>
        <li>Plotting the magnetic course on the chart instead of the true course.</li>
      </ul>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter'],
  } as Ex2CourseToSteer;

  // Diagnostic test (disabled in production)
  // diagnosticEx2(ex);

  return ex;
}

export function generateExercise3(cd: ChartData): Ex3CrossBearing {
  const rng = seededRNG(cd.seed + 3003);
  let vessel = randomInWater(cd.depthFn, rng, 10);
  for (let i = 0; i < 200; i++) {
    const c = randomInWater(cd.depthFn, rng, 10);
    if (inBoundsSVG(c)) { vessel = c; break; }
  }
  const lms = cd.landmarks.slice(0, 3);

  const bearings: BearingInfo[] = lms.map(lm => {
    const { lat: lmLat, lon: lmLon } = svgToLatLon(lm.x, lm.y);
    const tb   = trueBearing(vessel.lat, vessel.lon, lmLat, lmLon);
    const err  = gaussianRandom() * 2;
    const signedVar = cd.variationDir === 'W' ? cd.variation : -cd.variation;
    const mag  = Math.round(((tb + signedVar + err) % 360 + 360) % 360 * 10) / 10;
    return { lm, lmLat, lmLon, trueBear: tb, magBear: mag };
  });

  return {
    id: 3,
    title: 'Fix by Cross Bearing',
    vessel, bearings,
    hazard: cd.shoals[0] ?? null,
    infoHTML: `
      <h4>Exercise 3 — Fix by Cross Bearing</h4>

      <p><b>What is a cross bearing fix?</b><br>
      By observing compass bearings to two or more charted landmarks simultaneously, you can draw position lines on the chart. Where they cross is your fix. Three bearings are preferred — the small triangle they form (the "cocked hat") shows the accuracy of your observations.</p>
      <br />
      <p><b>Given — magnetic bearings from vessel to landmarks:</b></p>
      ${bearings.map(b => `<p style="margin:2px 0"><b>${b.lm.name}:</b> ${b.magBear.toFixed(1)}°M</p>`).join('')}
      <p>Variation: <b>${cd.variation.toFixed(1)}°${cd.variationDir}</b></p>
      <br />
      <p><b>Step 1 — Convert each magnetic bearing to true:</b><br>
      <code>True = Magnetic ${cd.variationDir === 'W' ? '−' : '+'} Variation</code>
      (Reversing the TVMDC rule: going Mag→True, West subtracts, East adds.)</p>
      ${bearings.map(b => {
        const tb = ((b.trueBear + 360) % 360).toFixed(1);
        return `<p style="margin:2px 0">${b.lm.name}: ${b.magBear.toFixed(1)}° ${cd.variationDir === 'W' ? '−' : '+'} ${cd.variation.toFixed(1)}° = <b>${tb}°T</b></p>`;
      }).join('')}
      <br />
      <p><b>Step 2 — Find the reciprocal bearing for each line:</b><br>
      A compass bearing is <em>from the vessel to the landmark</em>. To plot on the chart you draw the line <em>from the landmark back toward the vessel</em> — that is the reciprocal.<br>
      <code>Reciprocal = True bearing + 180° (subtract 180° if result > 360°)</code></p>
      ${bearings.map(b => {
        const tb = (b.trueBear + 360) % 360;
        const recip = ((tb + 180) % 360).toFixed(1);
        return `<p style="margin:2px 0">${b.lm.name}: ${tb.toFixed(1)}°T → reciprocal <b>${recip}°T</b></p>`;
      }).join('')}
      <br />
      <p><b>Step 3 — Plot the position lines:</b><br>
      For each landmark, set the plotter to the reciprocal bearing and draw a line outward from the landmark. Use the outer (TRUE) ring of the compass rose.</p>
      <br />
      <p><b>Step 4 — Mark your fix:</b><br>
      The point where the lines intersect (or the centre of the cocked hat) is your position. Mark it and submit.</p>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Plotting the original bearing instead of the reciprocal — the line must come <em>from</em> the landmark.</li>
        <li>Applying the wrong variation sign when converting M→T.</li>
        <li>Using only two bearings — a third bearing reveals observation errors.</li>
      </ul>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter', 'compass'],
  };
}

export function generateExercise4(cd: ChartData): Ex4DistanceETA {
  const rng = seededRNG(cd.seed + 4004);
  let dep = randomInWater(cd.depthFn, rng);
  let dest = randomInWater(cd.depthFn, rng);
  for (let i = 0; i < 400; i++) {
    const dCand = randomInWater(cd.depthFn, rng);
    const sCand = randomInWater(cd.depthFn, rng);
    if (inBoundsSVG(dCand) && inBoundsSVG(sCand) &&
        distanceNM(dCand.lat, dCand.lon, sCand.lat, sCand.lon) > 1.5) {
      dep = dCand; dest = sCand; break;
    }
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
      <h4>Exercise 4 — Distance &amp; ETA</h4>

      <p><b>Objective:</b> Measure the distance between two points on the chart using dividers, calculate the time underway, and determine the ETA.</p>
      <br />
      <p><b>Given:</b></p>
      <ul>
        <li>Departure (⊕): ${formatLatLon(dep.lat, dep.lon)}</li>
        <li>Destination (⊗): ${formatLatLon(dest.lat, dest.lon)}</li>
        <li>Speed: <b>${speedKn.toFixed(1)} kn</b></li>
        <li>Departure time: <b>${depTime}</b></li>
      </ul>
      <br />
      <p><b>Step 1 — Measure distance with dividers:</b><br>
      Open the dividers to span the distance between ⊕ and ⊗ on the chart. Transfer that span to the <b>latitude scale</b> (the vertical degree scale on the left or right chart edge). Count the minutes of arc — each minute of latitude equals exactly <b>1 nautical mile</b>.<br>
      <em>Never use the longitude scale for distance — longitude degrees vary in size with latitude.</em></p>
      <br />
      <p><b>Step 2 — Calculate time underway:</b><br>
      <code>Time (h) = Distance (NM) ÷ Speed (kn)</code><br>
      Then convert to hours and minutes: multiply the decimal hours by 60 to get minutes.</p>
      <br />
      <p><b>Step 3 — Calculate ETA:</b><br>
      <code>ETA = Departure time + Time underway</code><br>
      Add the minutes first, then carry over into hours if needed. Use the STD panel on the right to assist with the arithmetic.</p>
      <br />
      <p><b>Step 4 — Enter in workbook and submit:</b><br>
      Record the measured distance (NM) and ETA (HH:MM), then press Submit.</p>
      <br />
      <p><b>Working solution:</b></p>
      <ul>
        <li>Distance: <b>${trueDist.toFixed(2)} NM</b></li>
        <li>Time underway: <b>${trueDist.toFixed(2)} ÷ ${speedKn.toFixed(1)} = ${(timeMin / 60).toFixed(3)} h = ${Math.floor(timeMin)}m ${Math.round((timeMin % 1) * 60)}s ≈ <b>${Math.round(timeMin)} min</b></li>
        <li>ETA: ${depTime} + ${Math.floor(timeMin)}m = <b>${eta}</b></li>
      </ul>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Measuring on the longitude scale instead of the latitude scale.</li>
        <li>Forgetting to convert decimal hours to minutes before adding to departure time.</li>
        <li>Not accounting for midnight roll-over if the voyage runs past 24:00.</li>
      </ul>
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
      <h4>Exercise 5 — Clearing Bearing</h4>

      <p><b>What is a clearing bearing?</b><br>
      A clearing bearing is a compass bearing that, when maintained, keeps your vessel safely clear of a hazard. If you keep the bearing to a landmark <em>greater than</em> or <em>less than</em> a critical value, you know you are on the safe side of a danger.</p>
      <br />
      <p><b>Given:</b></p>
      <ul>
        <li>Hazard: shoal marked on chart (red circle)</li>
        <li>Reference landmark: <b>${lm?.name ?? 'Landmark'}</b></li>
        <li>Variation: <b>${cd.variation.toFixed(1)}°${cd.variationDir}</b></li>
      </ul>
      <br />
      <p><b>Step 1 — Find the true bearing from the landmark to the hazard:</b><br>
      Place the plotter so its edge passes through the landmark and the hazard. Slide to the compass rose and read the <b>outer (TRUE) ring</b> in the direction from landmark toward hazard.</p>
      <br />
      <p><b>Step 2 — This is your clearing bearing:</b><br>
      The line from the landmark through the edge of the hazard is the critical boundary. Vessels on the seaward side of this line (bearing to landmark <em>not</em> crossing the hazard) are safe.</p>
      <br />
      <p><b>Step 3 — Convert to magnetic (for the compass watch):</b><br>
      <code>Magnetic = True ${cd.variationDir === 'W' ? '+' : '−'} ${cd.variation.toFixed(1)}°</code><br>
      At sea, the officer of the watch monitors the magnetic bearing to the landmark and ensures it stays on the correct side of the clearing value.</p>
      <br />
      <p><b>Step 4 — Draw and submit:</b><br>
      Draw the clearing bearing line from the landmark, label it with the true bearing value, and submit.</p>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Drawing the line in the wrong direction (from hazard to landmark instead of landmark to hazard).</li>
        <li>Confusing which side of the line is safe — always check on the chart which side is open water.</li>
        <li>Forgetting to convert to magnetic for the helmsman's watch.</li>
      </ul>
    `,
    enabledTools: ['pencil', 'parallel-rules', 'plotter'],
  };
}

export function generateExercise6(cd: ChartData): Ex6SetAndDrift {
  const rng = seededRNG(cd.seed + 6006);

  // Ensure departure, DR and fix positions are all inside the chart bounds.
  let dep: LatLon & SVGPoint | null = null;
  let courseDeg = 0;
  let speedKn = 0;
  let timeMin = 0;
  let timeHr = 0;
  let drPos: LatLon | null = null;
  let fixPos: LatLon | null = null;
  let setCurrent = 0;
  let driftRate = 0;

  const tryTriple = (
    cand: LatLon & SVGPoint, course: number, speed: number, time: number,
    set: number, drift: number,
  ): boolean => {
    const tHr = time / 60;
    const dr = destinationPoint(cand.lat, cand.lon, course, speed * tHr);
    const fix = destinationPoint(dr.lat, dr.lon, set, drift * tHr);
    const svgDRc = latLonToSVG(dr.lat, dr.lon);
    const svgFixc = latLonToSVG(fix.lat, fix.lon);
    if (!inBoundsSVG(cand) || !inBoundsSVG(svgDRc) || !inBoundsSVG(svgFixc)) return false;
    if (cd.depthFn(svgDRc.x, svgDRc.y) < 5 || cd.depthFn(svgFixc.x, svgFixc.y) < 5) return false;
    dep = cand; courseDeg = course; speedKn = speed; timeMin = time; timeHr = tHr;
    drPos = dr; fixPos = fix; setCurrent = set; driftRate = drift;
    return true;
  };

  for (let i = 0; i < 400; i++) {
    const cand = randomInWater(cd.depthFn, rng, 10);
    const candCourse = Math.floor(rng() * 360);
    const candSpeed = 4 + rng() * 4;
    const candTime = 30 + Math.floor(rng() * 60);
    const candSet = Math.floor(rng() * 360);
    const candDrift = 0.3 + rng() * 1.2;
    if (tryTriple(cand, candCourse, candSpeed, candTime, candSet, candDrift)) break;
  }

  // Fallback: sweep courses and set directions from multiple departure points.
  if (!dep) {
    outer6: for (let attempt = 0; attempt < 200; attempt++) {
      const cand = randomInWater(cd.depthFn, rng, 10);
      if (!inBoundsSVG(cand)) continue;
      const candSpeed = 4 + rng() * 4;
      const candTime = 30 + Math.floor(rng() * 60);
      const candDrift = 0.3 + rng() * 1.2;
      for (let c = 0; c < 36; c++) {
        for (let s = 0; s < 36; s++) {
          if (tryTriple(cand, c * 10, candSpeed, candTime, s * 10, candDrift)) break outer6;
        }
      }
    }
  }

  return {
    id: 6,
    title: 'Set and Drift',
    departure: dep!, courseDeg, speedKn, timeMin,
    drPos: drPos!, fixPos: fixPos!, setCurrent, driftRate,
    svgDR:  latLonToSVG(drPos!.lat, drPos!.lon),
    svgFix: latLonToSVG(fixPos!.lat, fixPos!.lon),
    infoHTML: `
      <h4>Exercise 6 — Set and Drift</h4>

      <p><b>What are set and drift?</b><br>
      <b>Set</b> is the direction the current is pushing your vessel (true bearing, °T). <b>Drift</b> is the speed of that current (knots). They are determined by comparing where the DR says you should be with where an observed fix shows you actually are.</p>
      <br />
      <p><b>Given:</b></p>
      <ul>
        <li>Departure (⊕): ${formatLatLon(dep!.lat, dep!.lon)}</li>
        <li>True course steered: <b>${courseDeg}°T</b></li>
        <li>Speed through water: <b>${speedKn.toFixed(1)} kn</b></li>
        <li>Time underway: <b>${timeMin} min (${(timeMin/60).toFixed(2)} h)</b></li>
        <li>Actual fix (⊗): shown on chart</li>
      </ul>
      <br />
      <p><b>Step 1 — Calculate the DR position:</b><br>
      <code>Distance = ${speedKn.toFixed(1)} kn × ${(timeMin/60).toFixed(2)} h = ${(speedKn*(timeMin/60)).toFixed(2)} NM</code><br>
      From ⊕, set the plotter to <b>${courseDeg}°T</b> and draw a course line. Step the dividers ${(speedKn*(timeMin/60)).toFixed(2)} NM along it to find the DR position. Mark it with a semicircle labelled "DR".</p>
      <br />
      <p><b>Step 2 — Draw the current vector (DR → Fix):</b><br>
      Draw a line from your DR position to the actual fix (⊗). This vector represents the displacement caused by current over the elapsed time.</p>
      <br />
      <p><b>Step 3 — Measure the set:</b><br>
      Place the plotter on the DR→Fix line and read the bearing on the outer (TRUE) ring in the direction from DR toward Fix. This is the <b>set</b> (direction current is flowing).</p>
      <br />
      <p><b>Step 4 — Calculate the drift:</b><br>
      Measure the length of the DR→Fix line with dividers against the latitude scale to get the distance in NM.<br>
      <code>Drift (kn) = Distance (NM) ÷ Time (h)</code></p>
      <br />
      <p><b>Step 5 — Record and submit:</b><br>
      Enter set (°T) and drift rate (kn) in the workbook and submit.</p>
      <br />
      <p><b>Common errors:</b></p>
      <ul>
        <li>Drawing the vector Fix→DR instead of DR→Fix — the direction must be from dead-reckoned position to actual fix.</li>
        <li>Using speed made good instead of speed through water when calculating the DR.</li>
        <li>Measuring the DR→Fix distance on the longitude scale instead of the latitude scale.</li>
      </ul>
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
  const subMag  = subTrue + (cd.variationDir === 'W' ? cd.variation : -cd.variation);
  const errT    = Math.abs(angleDiff(subTrue, ex.trueCourse));
  const errM    = Math.abs(angleDiff(subMag,  ex.magCourse));
  const passT   = errT <= 2;
  const passM   = errM <= 2;

  let html = `
    <p>True course: <b>${ex.trueCourse.toFixed(1)}°T</b> — you entered ${subTrue.toFixed(1)}°T
      <span class="${passT ? 'score-good' : 'score-bad'}">(error ${errT.toFixed(1)}°)</span></p>
    <p>Magnetic course: <b>${ex.magCourse.toFixed(1)}°M</b> — computed ${subMag.toFixed(1)}°M
      <span class="${passM ? 'score-good' : 'score-bad'}">(error ${errM.toFixed(1)}°)</span></p>
    <p><b>Chart verification:</b> True bearing from departure to destination should be <b>${ex.trueCourse.toFixed(1)}°</b>.</p>
  `;
  if (!passT) html += '<p class="score-bad">❌ Check your parallel rules alignment on the compass rose (use the OUTER ring for true bearing).</p>';
  if (!passM) html += '<p class="score-bad">❌ Magnetic = True + Variation (west variation adds when True→Magnetic).</p>';

  return { pass: passT && passM, html };
}

function scoreEx3(ex: Ex3CrossBearing, lines: DrawnLine[]): ScoreResult {
  if (!lines.length) {
    return { pass: false, html: '<p class="score-bad">No lines drawn. Plot position lines first.</p>' };
  }
  const posLines = lines.slice(-Math.min(3, lines.length));
  let html = `<p>Vessel: <b>${formatLatLon(ex.vessel.lat, ex.vessel.lon)}</b></p>`;
  let allPass = true;

  // For each expected bearing, find the best-matching drawn line (by minimum angular error)
  // This handles the case where lines are drawn in a different order than the landmarks
  const usedLineIdx = new Set<number>();

  for (let i = 0; i < ex.bearings.length; i++) {
    const trueBear = ex.bearings[i]?.trueBear ?? 0;
    const recip    = (trueBear + 180) % 360;

    let bestErr = Infinity;
    let bestIdx = -1;
    for (let j = 0; j < posLines.length; j++) {
      if (usedLineIdx.has(j)) continue;
      const line    = posLines[j]!;
      const bearing = svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2);
      const err     = Math.min(
        Math.abs(angleDiff(bearing, recip)),
        Math.abs(angleDiff(bearing, trueBear)),
      );
      if (err < bestErr) { bestErr = err; bestIdx = j; }
    }

    if (bestIdx === -1) {
      html += `<p>Line for ${ex.bearings[i]?.lm?.name ?? '?'}: <span class="score-bad">not drawn</span></p>`;
      allPass = false;
      continue;
    }

    usedLineIdx.add(bestIdx);
    const drawnBearing = svgLineBearing(posLines[bestIdx]!.svgX1, posLines[bestIdx]!.svgY1, posLines[bestIdx]!.svgX2, posLines[bestIdx]!.svgY2);
    const pass = bestErr <= 5;
    if (!pass) allPass = false;
    html += `<p>${ex.bearings[i]?.lm?.name ?? '?'}: reciprocal ${recip.toFixed(0)}°T, you drew ${drawnBearing.toFixed(0)}°T
      <span class="${pass ? 'score-good' : 'score-bad'}">(error ${bestErr.toFixed(1)}°)</span></p>`;
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

/**
 * Test: Verify that a true bearing from departure to destination
 * actually points toward the destination when plotted on the SVG chart.
 */
export function testBearingIntersection(
  depLat: number, depLon: number,
  destLat: number, destLon: number,
  trueBearing: number,
): { pass: boolean; message: string; debug: Record<string, number> } {
  // Convert to SVG coordinates
  const depSVG = latLonToSVG(depLat, depLon);
  const destSVG = latLonToSVG(destLat, destLon);

  // Calculate the actual bearing from departure to destination in SVG space
  const dx = destSVG.x - depSVG.x;
  const dy = destSVG.y - depSVG.y;

  // SVG angle: atan2(dy, dx) where positive Y is downward
  const svgAngle = Math.atan2(dy, dx) * (180 / Math.PI);

  // Convert SVG angle back to true bearing
  // SVG: 0° = East, 90° = South
  // True: 0° = North, 90° = East
  // Formula: trueBear = 90° - svgAngle
  const actualBearing = (90 - svgAngle + 360) % 360;

  // Calculate error
  let error = actualBearing - trueBearing;
  if (error > 180) error -= 360;
  if (error < -180) error += 360;
  error = Math.abs(error);

  // Check if line from departure along the true bearing intersects destination
  // by extending a line from departure at the given bearing and checking if it passes near the destination
  const bearingRad = (trueBearing - 90) * (Math.PI / 180); // Convert true bearing to SVG angle
  const distToTarget = Math.sqrt(dx * dx + dy * dy);
  const extendedX = depSVG.x + distToTarget * Math.cos(bearingRad);
  const extendedY = depSVG.y + distToTarget * Math.sin(bearingRad);

  // Distance from extended point to actual destination
  const intersectionError = Math.sqrt(
    (extendedX - destSVG.x) ** 2 + (extendedY - destSVG.y) ** 2
  );

  const pass = error <= 2 && intersectionError <= 5; // Allow 2° bearing error, 5px intersection error

  return {
    pass,
    message: pass
      ? `✓ Bearing ${trueBearing.toFixed(1)}°T correctly points to destination`
      : `✗ Bearing error: ${error.toFixed(1)}° | Intersection error: ${intersectionError.toFixed(1)}px`,
    debug: {
      depSVG_x: depSVG.x,
      depSVG_y: depSVG.y,
      destSVG_x: destSVG.x,
      destSVG_y: destSVG.y,
      svgAngle,
      actualBearing: parseFloat(actualBearing.toFixed(1)),
      expectedBearing: trueBearing,
      bearingError: parseFloat(error.toFixed(1)),
      intersectionError: parseFloat(intersectionError.toFixed(1)),
      extendedX,
      extendedY,
    },
  };
}

/**
 * Test: Verify that a true course from departure for a given distance
 * actually points toward and reaches the DR position.
 * 
 * NOTE: We verify using GEODETIC calculations only (haversine), not SVG angles.
 * SVG is an equirectangular projection at 52°N which distorts bearings significantly,
 * so we cannot use SVG angles to verify true bearing. The exercise course is correct
 * if the geodetic bearing and distance match the input course/speed/time.
 */
export function testDeadReckoningIntersection(
  depLat: number, depLon: number,
  drLat: number, drLon: number,
  trueCourse: number,
  speedKn: number,
  timeMin: number,
): { pass: boolean; message: string; debug: Record<string, any> } {
  // Verify geodetic bearing and distance
  const actualBearing = trueBearing(depLat, depLon, drLat, drLon);
  
  let bearingError = actualBearing - trueCourse;
  if (bearingError > 180) bearingError -= 360;
  if (bearingError < -180) bearingError += 360;
  bearingError = Math.abs(bearingError);

  const expectedDistance = speedKn * (timeMin / 60);
  const actualDistance = distanceNM(depLat, depLon, drLat, drLon);
  const distanceError = Math.abs(actualDistance - expectedDistance);

  // For debugging: also show SVG angle (but don't use it for validation)
  const depSVG = latLonToSVG(depLat, depLon);
  const drSVG = latLonToSVG(drLat, drLon);
  const dx = drSVG.x - depSVG.x;
  const dy = drSVG.y - depSVG.y;
  
  const svgAngleRad = Math.atan2(dy, dx);
  let svgAngleDeg = svgAngleRad * (180 / Math.PI);
  while (svgAngleDeg < 0) svgAngleDeg += 360;
  svgAngleDeg = svgAngleDeg % 360;

  // Pass if: geodetic bearing/distance match (projection distortion is acceptable)
  const pass = bearingError <= 2 && distanceError <= 0.1;

  return {
    pass,
    message: pass
      ? `✓ DR position at ${trueCourse.toFixed(1)}°T for ${expectedDistance.toFixed(2)} NM is correct`
      : `✗ Bearing error: ${bearingError.toFixed(1)}° | Distance error: ${distanceError.toFixed(2)} NM`,
    debug: {
      actualBearing: parseFloat(actualBearing.toFixed(1)),
      expectedBearing: trueCourse,
      bearingError: parseFloat(bearingError.toFixed(1)),
      svgAngleDeg: parseFloat(svgAngleDeg.toFixed(2)),
      expectedDistance: parseFloat(expectedDistance.toFixed(2)),
      actualDistance: parseFloat(actualDistance.toFixed(2)),
      distanceError: parseFloat(distanceError.toFixed(2)),
      depSVG_x: Math.round(depSVG.x * 10) / 10,
      depSVG_y: Math.round(depSVG.y * 10) / 10,
      drSVG_x: Math.round(drSVG.x * 10) / 10,
      drSVG_y: Math.round(drSVG.y * 10) / 10,
    },
  };
}

/**
 * Run diagnostic tests on Exercise 1 to verify DR calculations
 */
export function diagnosticEx1(ex: Ex1DeadReckoning): void {
  // Test 1: Round-trip consistency
  const verifyBearing = trueBearing(ex.departure.lat, ex.departure.lon, ex.drPos.lat, ex.drPos.lon);
  const bearingDelta = Math.abs(verifyBearing - ex.courseDeg);
  
  console.log('=== EXERCISE 1 HAVERSINE CONSISTENCY TEST ===');
  console.log('Input course to destinationPoint: ' + ex.courseDeg.toFixed(1) + '°T');
  console.log('Calculated DR via haversine:      ' + `${ex.drPos.lat.toFixed(6)}°N, ${(-ex.drPos.lon).toFixed(6)}°W`);
  console.log('Bearing back to DR via trueBearing: ' + verifyBearing.toFixed(1) + '°T');
  console.log('Round-trip delta: ' + bearingDelta.toFixed(1) + '°');
  
  if (bearingDelta > 0.5) {
    console.error('❌ HAVERSINE FUNCTIONS ARE INCONSISTENT');
    console.error('This is a fundamental math issue - destinationPoint and trueBearing dont match');
  } else {
    console.log('✓ Haversine functions are self-consistent');
  }
  
  // Also run the full test as before
  const result = testDeadReckoningIntersection(
    ex.departure.lat, ex.departure.lon,
    ex.drPos.lat, ex.drPos.lon,
    ex.courseDeg,
    ex.speedKn,
    ex.timeMin,
  );

  console.log('=== Exercise 1 Dead Reckoning Test ===');
  console.log(result.message);
  console.log('Debug:', result.debug);
  
  if (!result.pass) {
    console.error('❌ DEAD RECKONING CALCULATION FAILED');
    console.log('Expected course:', ex.courseDeg.toFixed(1), '°T');
    console.log('Actual bearing to DR:', result.debug.actualBearing, '°T');
    console.log('Bearing error:', result.debug.bearingError, '°');
    console.log('Expected distance:', result.debug.expectedDistance, 'NM');
    console.log('Actual distance to DR:', result.debug.actualDistance, 'NM');
    console.log('Distance error:', result.debug.distanceError, 'NM');
    console.log('(Note: SVG angle differs from true bearing due to equirectangular projection distortion at 52°N)');
  }
}

/**
 * Run diagnostic tests on Exercise 2 to verify bearing calculations
 */
export function diagnosticEx2(ex: Ex2CourseToSteer): void {
  const result = testBearingIntersection(
    ex.departure.lat, ex.departure.lon,
    ex.destination.lat, ex.destination.lon,
    ex.trueCourse,
  );

  console.log('=== Exercise 2 Course to Steer Test ===');
  console.log(result.message);
  console.log('Debug:', result.debug);
  
  if (!result.pass) {
    console.error('❌ COURSE TO STEER CALCULATION FAILED');
  }
}
