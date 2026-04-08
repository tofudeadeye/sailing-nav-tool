/**
 * main.ts — application bootstrap, pan/zoom, event routing, render loop
 */

import {
  transform, svgToScreen, screenToSVG, svgToLatLon,
  latLonToSVG, formatLatLon, SVG_W, SVG_H,
} from './coords.ts';
import { generateChart, renderChartToSVG, FormatVariation } from './chartGen.ts';
import type { ChartData, Landmark } from './chartGen.ts';
import {
  state, wb,
  initCanvas, resizeCanvas, redrawCanvas,
  setEraseMode, clearAllLines,
  spawnDividers, handleDividersPointerDown, handleDividersPointerMove, handleDividersPointerUp,
  spawnPlotter, handlePlotterPointerDown, handlePlotterPointerMove, handlePlotterPointerUp,
  spawnParallelRules, drawParallelRules, handleRulesPointerDown, handleRulesPointerMove, handleRulesPointerUp,
  takeBearing, createSTDPanel,
  drawAllToolOverlays,
  hitTestPlotter, hitTestPlotterZone, hitTestDividers, hitTestParallelRules,
  type ToolName,
} from './tools.ts';
import {
  generateExercise, scoreExercise,
  drawExerciseOverlays, drawExerciseFeedbackOverlay,
  type Exercise, type WorkbookValues, type ScoreResult,
} from './exercises.ts';

// ── DOM helpers ───────────────────────────────────────────────────────────────

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el as T;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const svgEl           = document.getElementById('chart-svg') as unknown as SVGSVGElement;
const canvasEl        = getEl<HTMLCanvasElement>('draw-canvas');
const chartWrap       = getEl<HTMLDivElement>('chart-wrap');
const toolLayer       = getEl<HTMLDivElement>('tool-layer');
const feedbackOverlay = getEl<HTMLDivElement>('feedback-overlay');
const feedbackTitle   = getEl<HTMLHeadingElement>('feedback-title');
const feedbackBody    = getEl<HTMLDivElement>('feedback-body');
const feedbackClose   = getEl<HTMLButtonElement>('feedback-close');
const exerciseDropdown = getEl<HTMLDivElement>('exercise-dropdown');

// Workbook
const wbVariation = getEl<HTMLSpanElement>('wb-variation');
const wbBearing   = getEl<HTMLSpanElement>('wb-bearing');
const wbDistance  = getEl<HTMLSpanElement>('wb-distance');
const wbAccDist   = getEl<HTMLSpanElement>('wb-acc-dist');
const wbCourse    = getEl<HTMLSpanElement>('wb-course');
const wbSpeed     = getEl<HTMLInputElement>('wb-speed');
const wbDepTime   = getEl<HTMLInputElement>('wb-dep-time');
const wbETA       = getEl<HTMLSpanElement>('wb-eta');
const wbDRPos     = getEl<HTMLSpanElement>('wb-dr-pos');
const wbExField   = getEl<HTMLDivElement>('wb-exercise-field');
const wbExName    = getEl<HTMLSpanElement>('wb-exercise-name');
const wbSubmit    = getEl<HTMLButtonElement>('wb-submit');

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt3(n: number): string {
  return String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');
}

function svgLineBearing(x1: number, y1: number, x2: number, y2: number): number {
  return ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90 + 360) % 360;
}

function distToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ── Workbook callbacks ────────────────────────────────────────────────────────

wb.setBearing  = (b, v) => { wbBearing.textContent  = `${fmt3(b)}°T (${fmt3(b + v)}°M)`; };
wb.setDistance = (nm)   => { wbDistance.textContent = `${nm.toFixed(2)} NM`; };
wb.setAccDist  = (nm)   => { wbAccDist.textContent  = `${nm.toFixed(2)} NM`; };
wb.setCourse   = (b, v) => { wbCourse.textContent   = `${fmt3(b)}°T (${fmt3(b + v)}°M)`; };
wb.setETA      = (eta)  => { wbETA.textContent      = eta; };
wb.setDRPos    = (lat, lon) => { wbDRPos.textContent = formatLatLon(lat, lon); };

// ── Application state ─────────────────────────────────────────────────────────

let chartData:            ChartData   | null = null;
let currentEx:            Exercise    | null = null;
let lastScore:            ScoreResult | null = null;
let showFeedbackOnCanvas  = false;

// Local pencil state (managed here so the preview can be drawn in the render loop)
let pencilStart:      { x: number; y: number } | null = null;
let pencilPreviewEnd: { x: number; y: number } | null = null;
let nextLineType      = 0;
const LINE_TYPES = ['Course Line', 'Bearing Line', 'Position Line', 'DR Track'] as const;
type LineType = typeof LINE_TYPES[number];

// ── Chart generation ──────────────────────────────────────────────────────────

function newChart(seed?: number): void {
  const s = seed ?? Math.floor(Math.random() * 100000);
  chartData = generateChart(s);
  state.chartData = chartData;

  renderChartToSVG(svgEl, chartData);
  // wbVariation.textContent = `${chartData.variation}°W`;
  wbVariation.textContent = FormatVariation(chartData.variation, chartData.variationDir);
  seedInput.value = String(s);

  clearAllLines();
  state.accumulatedDist = 0;
  wbAccDist.textContent = '—';
  currentEx = null;
  lastScore = null;
  showFeedbackOnCanvas = false;
  pencilStart = null;
  pencilPreviewEnd = null;
  wbExField.style.display = 'none';
  removeExerciseInfo();
  applyTransform();
  redraw();
}

// ── Pan / zoom ────────────────────────────────────────────────────────────────

function applyTransform(): void {
  const svgHTMLEl = svgEl as unknown as HTMLElement;
  svgHTMLEl.style.transform = `translate(${transform.offsetX}px,${transform.offsetY}px) scale(${transform.scale})`;
  svgHTMLEl.style.transformOrigin = '0 0';
}

function fitChart(): void {
  const w = chartWrap.clientWidth, h = chartWrap.clientHeight;
  const BORDER = 52;
  const sW = (w - BORDER * 2) / SVG_W;
  const sH = (h - BORDER * 2) / SVG_H;
  const s = Math.max(sW, sH);
  transform.scale   = s;
  transform.offsetX = BORDER;
  transform.offsetY = BORDER;
  applyTransform();
}

chartWrap.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const rect  = chartWrap.getBoundingClientRect();
  const mx    = e.clientX - rect.left;
  const my    = e.clientY - rect.top;
  const zoomIn  = e.deltaY < 0;

  // Each entry = scale where the bar shows exactly N NM per segment (total = N*5 NM).
  // scale = 450 / (5 * N * 20) = 4.5 / N. Ascending order.
  const snapScales = [
    0.45,       // 10 NM/seg → 0–50
    0.5,        //  9 NM/seg → 0–45
    0.5625,     //  8 NM/seg → 0–40
    0.643,      //  7 NM/seg → 0–35
    0.75,       //  6 NM/seg → 0–30
    0.9,        //  5 NM/seg → 0–25
    1.125,      //  4 NM/seg → 0–20
    1.5,        //  3 NM/seg → 0–15
    2.25,       //  2 NM/seg → 0–10
    4.5,        //  1 NM/seg → 0–5
  ];

  // Pick the next snap level strictly in the direction of travel.
  const ns = zoomIn
    ? snapScales.find(s => s > transform.scale) ?? transform.scale
    : [...snapScales].reverse().find(s => s < transform.scale) ?? transform.scale;

  transform.offsetX = mx - (mx - transform.offsetX) * (ns / transform.scale);
  transform.offsetY = my - (my - transform.offsetY) * (ns / transform.scale);
  transform.scale   = ns;
  applyTransform();
  redraw();
}, { passive: false });

// ── Render loop ───────────────────────────────────────────────────────────────

function redraw(): void {
  redrawCanvas();
  const c = canvasEl.getContext('2d')!;

  // Pencil preview line
  if (pencilStart && pencilPreviewEnd) {
    const s = svgToScreen(pencilStart.x, pencilStart.y);
    c.save();
    c.strokeStyle = 'rgba(34,68,170,0.5)';
    c.lineWidth   = 1.5;
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(pencilPreviewEnd.x, pencilPreviewEnd.y);
    c.stroke();
    c.restore();
  }

  drawParallelRules(c);
  drawAllToolOverlays(c);
  if (currentEx)                         drawExerciseOverlays(c, currentEx);
  if (showFeedbackOnCanvas && lastScore) drawExerciseFeedbackOverlay(c, lastScore);
}

function resizeAll(): void {
  resizeCanvas(chartWrap.clientWidth, chartWrap.clientHeight);
  fitChart();
  redraw();
}

// ── Pointer events ────────────────────────────────────────────────────────────

let isPanning = false;
let panStart  = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };

chartWrap.addEventListener('pointerdown', (e: PointerEvent) => {
  // Let clicks on floating panels (STD, exercise info, etc.) reach their inputs natively
  if ((e.target as HTMLElement).closest('#std-panel, #exercise-info')) return;
  e.preventDefault();
  const tool = state.activeTool;

  if (tool === 'pencil') {
    if (onPencilDown(e)) { redraw(); return; }
  }

  if (tool === 'dividers') {
    if (state.dividers) {
      if (handleDividersPointerDown(e, chartWrap)) {
        chartWrap.setPointerCapture(e.pointerId);
        chartWrap.style.cursor = 'grabbing';
        redraw(); return;
      }
    } else {
      const rect = chartWrap.getBoundingClientRect();
      const p    = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);
      spawnDividers(p.x, p.y);
      redraw(); return;
    }
  }

  if (tool === 'plotter') {
    if (state.plotter) {
      if (handlePlotterPointerDown(e, chartWrap)) {
        chartWrap.setPointerCapture(e.pointerId);
        chartWrap.style.cursor = 'grabbing';
        redraw(); return;
      }
    } else {
      const rect = chartWrap.getBoundingClientRect();
      const p    = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);
      spawnPlotter(p.x, p.y);
      redraw(); return;
    }
  }

  if (tool === 'parallel-rules') {
    if (state.parallelRules) {
      if (handleRulesPointerDown(e, chartWrap)) {
        chartWrap.setPointerCapture(e.pointerId);
        chartWrap.style.cursor = 'grabbing';
        redraw(); return;
      }
    } else {
      const rect = chartWrap.getBoundingClientRect();
      const p    = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);
      spawnParallelRules(p.x, p.y, (b, v) => wb.setBearing?.(b, v));
      redraw(); return;
    }
  }

  if (tool === 'compass') { onCompassClick(e); redraw(); return; }

  // Pan
  isPanning = true;
  chartWrap.setPointerCapture(e.pointerId);
  panStart  = { x: e.clientX, y: e.clientY };
  panOrigin = { x: transform.offsetX, y: transform.offsetY };
  chartWrap.style.cursor = 'grabbing';
});

chartWrap.addEventListener('pointermove', (e: PointerEvent) => {
  const tool = state.activeTool;

  if (tool === 'pencil') {
    if (onPencilMove(e)) { redraw(); return; }
  }
  if (tool === 'dividers' && state.dividers?.dragging) {
    handleDividersPointerMove(e, chartWrap); redraw(); return;
  }
  if (tool === 'plotter' && state.plotter?.dragging) {
    handlePlotterPointerMove(e, chartWrap); redraw(); return;
  }
  if (tool === 'parallel-rules' && state.parallelRules?.dragging) {
    handleRulesPointerMove(e, chartWrap); redraw(); return;
  }

  if (isPanning) {
    transform.offsetX = panOrigin.x + (e.clientX - panStart.x);
    transform.offsetY = panOrigin.y + (e.clientY - panStart.y);
    applyTransform();
    redraw();
    return;
  }

  // ── Hover cursor ───────────────────────────────────────────────────────────
  const rect = chartWrap.getBoundingClientRect();
  const sx   = e.clientX - rect.left;
  const sy   = e.clientY - rect.top;

  chartWrap.style.cursor = resolveCursor(tool, sx, sy);

  // Marker tooltip — always active regardless of tool
  const hit = hitTestAllMarkers(sx, sy);
  if (hit) {
    showMarkerTooltip(hit.name, hit.descKey, e.clientX, e.clientY, hit.extra);
  } else {
    hideMarkerTooltip();
  }
});

chartWrap.addEventListener('pointerup', (e: PointerEvent) => {
  const tool = state.activeTool;
  if (tool === 'dividers')       handleDividersPointerUp();
  if (tool === 'plotter')        handlePlotterPointerUp();
  if (tool === 'parallel-rules') handleRulesPointerUp();

  if (isPanning) {
    isPanning = false;
  }

  // Recompute cursor at release position
  const rect = chartWrap.getBoundingClientRect();
  chartWrap.style.cursor = resolveCursor(tool, e.clientX - rect.left, e.clientY - rect.top);

  redraw();
});

chartWrap.addEventListener('pointercancel', () => {
  isPanning = false;
  handleDividersPointerUp();
  handlePlotterPointerUp();
  if (state.parallelRules) state.parallelRules.dragging = null;
});

chartWrap.addEventListener('pointerleave', () => hideMarkerTooltip());

// ── Pencil handlers ───────────────────────────────────────────────────────────

function onPencilDown(e: PointerEvent): boolean {
  if (state.activeTool !== 'pencil') return false;
  const rect   = chartWrap.getBoundingClientRect();
  const svgPos = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);

  if (state.eraseMode) {
    const threshold = 15 / transform.scale;
    let bestIdx = -1, bestDist = threshold;
    for (let i = 0; i < state.lines.length; i++) {
      const l = state.lines[i]!;
      const d = distToSegment(svgPos.x, svgPos.y, l.svgX1, l.svgY1, l.svgX2, l.svgY2);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) state.lines.splice(bestIdx, 1);
    return true;
  }

  if (!pencilStart) {
    pencilStart = svgPos;
  } else {
    const type = LINE_TYPES[nextLineType % LINE_TYPES.length] as LineType;
    nextLineType++;
    const line = {
      svgX1: pencilStart.x, svgY1: pencilStart.y,
      svgX2: svgPos.x,      svgY2: svgPos.y,
      type, selected: false,
    };
    state.lines.push(line);
    const sv = chartData
      ? (chartData.variationDir === 'W' ? chartData.variation : -chartData.variation)
      : 0;
    wb.setCourse?.(svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2), sv);
    pencilStart = null;
    pencilPreviewEnd = null;
  }
  return true;
}

function onPencilMove(e: PointerEvent): boolean {
  if (state.activeTool !== 'pencil' || !pencilStart) return false;
  const rect = chartWrap.getBoundingClientRect();
  pencilPreviewEnd = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  return true;
}

// ── Hand bearing compass ──────────────────────────────────────────────────────

/**
 * Resolve the correct CSS cursor for the current tool and mouse position.
 *
 * Rules:
 *  - Draggable tools (plotter, dividers, rules): grab when hovering over the
 *    instrument, default when the instrument is placed but mouse is elsewhere,
 *    crosshair when the tool is active but not yet placed (waiting for first click).
 *  - Drawing tools (pencil, compass): crosshair always.
 *  - No tool: grab (pan mode).
 */
function resolveCursor(tool: ToolName, sx: number, sy: number): string {
  switch (tool) {
    case 'plotter': {
      if (!state.plotter) return 'crosshair'; // waiting to place
      const zone = hitTestPlotterZone(sx, sy);
      if (zone === 'rose' || zone === 'rotate-handle') return 'grab'; // rotatable
      if (zone === 'body') return 'grab';                              // moveable
      return 'default';
    }

    case 'dividers':
      if (!state.dividers)                 return 'crosshair'; // waiting to place
      return hitTestDividers(sx, sy)       ? 'grab' : 'default';

    case 'parallel-rules':
      if (!state.parallelRules)            return 'crosshair'; // waiting to place
      return hitTestParallelRules(sx, sy)  ? 'grab' : 'default';

    case 'compass':
      return hitTestLandmark(sx, sy)       ? 'crosshair' : 'default';

    case 'pencil':
    case 'std':
      return 'crosshair';

    default:
      return 'grab'; // pan mode
  }
}

function hitTestLandmark(sx: number, sy: number): boolean {
  if (!chartData) return false;
  for (const lm of chartData.landmarks) {
    const sc = svgToScreen(lm.x, lm.y);
    if (Math.hypot(sc.x - sx, sc.y - sy) < 80) return true;
  }
  return false;
}

function onCompassClick(e: PointerEvent): void {
  if (!chartData) return;
  const rect = chartWrap.getBoundingClientRect();
  const sx   = e.clientX - rect.left;
  const sy   = e.clientY - rect.top;

  let nearest: typeof chartData.landmarks[number] | null = null;
  let nearestDist = Infinity;
  for (const lm of chartData.landmarks) {
    const sc = svgToScreen(lm.x, lm.y);
    const d  = Math.hypot(sc.x - sx, sc.y - sy);
    if (d < nearestDist) { nearest = lm; nearestDist = d; }
  }
  if (!nearest || nearestDist > 80) return;

  const vessel = state.vessel ?? chartCentre();
  const { lat: lmLat, lon: lmLon } = svgToLatLon(nearest.x, nearest.y);
  const result = takeBearing(
    { ...nearest, lat: lmLat, lon: lmLon },
    vessel.lat, vessel.lon,
    chartData.variation,
    chartData.variationDir,
  );

  const signedVar = chartData.variationDir === 'W' ? chartData.variation : -chartData.variation;
  wb.setBearing?.(result.trueBear, signedVar);
  showToast(`${nearest.name}: ${fmt3(result.magBearing)}°M (${fmt3(result.trueBear)}°T)`);
}

function chartCentre(): { lat: number; lon: number } {
  const a = svgToLatLon(0, 0);
  const b = svgToLatLon(SVG_W, SVG_H);
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface ToastEl extends HTMLDivElement { _tid?: ReturnType<typeof setTimeout>; }

function showToast(msg: string): void {
  let t = document.getElementById('toast') as ToastEl | null;
  if (!t) {
    t = document.createElement('div') as ToastEl;
    t.id = 'toast';
    Object.assign(t.style, {
      position: 'fixed', bottom: '60px', left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.8)', color: '#fff',
      padding: '8px 18px', borderRadius: '6px',
      fontSize: '13px', fontFamily: 'Courier New',
      zIndex: '999', pointerEvents: 'none', transition: 'opacity 0.3s',
    });
    document.body.appendChild(t);
  }
  t.textContent  = msg;
  t.style.opacity = '1';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t!.style.opacity = '0'; }, 3000);
}

// ── Marker tooltip ────────────────────────────────────────────────────────────

const MARKER_DESC: Record<string, { title: string; body: string }> = {
  // Landmark types
  lighthouse: {
    title: 'Lighthouse',
    body: 'A fixed light structure used for coastal navigation. The light character (e.g. Fl.2s) tells mariners the flash pattern and period, allowing positive identification at night.',
  },
  church: {
    title: 'Church / Spire',
    body: 'A conspicuous shore landmark used for visual bearings and fixing position. Spires appear on charts as a cross symbol and are valuable in daytime pilotage.',
  },
  mast: {
    title: 'Radio / Signal Mast',
    body: 'A prominent vertical structure used as a transit or bearing mark. May also be a Coast Guard signal station for broadcasting weather and navigational warnings.',
  },
  tower: {
    title: 'Tower',
    body: 'A conspicuous structure (water tower, Martello tower, etc.) used as a visual fix mark. Martello towers are particularly common on British and Irish charts.',
  },
  wreck: {
    title: 'Wreck',
    body: 'A sunken vessel that may be a hazard to navigation. Shown with a dashed symbol if depth is uncertain. The year indicates when charted. Give a wide berth in poor visibility.',
  },
  rock: {
    title: 'Rock / Obstruction',
    body: 'A submerged or partially exposed rock hazard. An asterisk symbol (*) indicates a rock that covers and uncovers with the tide. Always consult the tide table before passing close.',
  },
  // Buoy types
  port: {
    title: 'Port-hand Buoy (IALA-A)',
    body: 'Red can-shaped buoy — keep to PORT (left) when entering harbour or proceeding upstream. Under IALA Region A (Europe/UK), red is left on entry.',
  },
  starboard: {
    title: 'Starboard-hand Buoy (IALA-A)',
    body: 'Green conical buoy — keep to STARBOARD (right) when entering harbour or proceeding upstream. Under IALA Region A (Europe/UK), green is right on entry.',
  },
  north: {
    title: 'North Cardinal Buoy',
    body: 'Yellow/black buoy with two upward-pointing topmarks. Pass to the NORTH of this buoy — the deepest water lies to the north. Light: Q or VQ (continuous white).',
  },
  south: {
    title: 'South Cardinal Buoy',
    body: 'Black/yellow buoy with two downward-pointing topmarks. Pass to the SOUTH of this buoy — deepest water lies to the south. Light: Q(6)+LFl or VQ(6)+LFl.',
  },
  east: {
    title: 'East Cardinal Buoy',
    body: 'Black/yellow/black buoy with topmarks pointing apart (egg-timer shape). Pass to the EAST. Light: Q(3) every 10s or VQ(3) every 5s.',
  },
  west: {
    title: 'West Cardinal Buoy',
    body: 'Yellow/black/yellow buoy with topmarks pointing together (hourglass shape). Pass to the WEST. Light: Q(9) every 15s or VQ(9) every 10s.',
  },
  // Anchorage
  anchorage: {
    title: 'Anchorage Area',
    body: 'A designated area with suitable holding ground and depth for anchoring. Check the chart for depth, the almanac for any restrictions, and the forecast before committing.',
  },
  // Harbour
  harbour: {
    title: 'Harbour / Port',
    body: 'A sheltered port with pier heads marking the entrance channel. Follow the leading line or channel buoys and reduce speed — the harbour speed limit is typically 5 knots.',
  },
};

let tooltipEl: HTMLDivElement | null = null;

function getTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'marker-tooltip';
    Object.assign(tooltipEl.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '1000',
      maxWidth: '240px',
      background: 'rgba(245,240,225,0.97)',
      border: '1px solid #8a7a55',
      borderRadius: '4px',
      padding: '8px 10px',
      fontFamily: 'Georgia, serif',
      fontSize: '12px',
      color: '#1a1a1a',
      boxShadow: '2px 2px 6px rgba(0,0,0,0.25)',
      display: 'none',
      lineHeight: '1.5',
    });
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showMarkerTooltip(name: string, descKey: string, clientX: number, clientY: number, extra?: string): void {
  const info = MARKER_DESC[descKey];
  if (!info) return;
  const tt = getTooltip();
  tt.innerHTML = `<strong style="font-size:13px;display:block;margin-bottom:4px;">${name}</strong><em style="font-size:11px;color:#555;display:block;margin-bottom:5px;">${info.title}</em>${info.body}${extra ? `<div style="margin-top:7px;padding-top:6px;border-top:1px solid #c8b878;">${extra}</div>` : ''}`;
  tt.style.display = 'block';
  // Position above-right, keeping within viewport
  const pad = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = clientX + 14;
  let top  = clientY - 14;
  if (left + 260 > vw) left = clientX - 270;
  if (top + tt.offsetHeight + pad > vh) top = clientY - tt.offsetHeight - 10;
  tt.style.left = `${left}px`;
  tt.style.top  = `${top}px`;
}

function hideMarkerTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

const SECTOR_COLOR_LABEL: Record<string, string> = {
  white: '<span style="display:inline-block;width:10px;height:10px;background:#fff;border:1px solid #aaa;border-radius:2px;vertical-align:middle;margin-right:4px;"></span>White',
  red:   '<span style="display:inline-block;width:10px;height:10px;background:#d41e1e;border-radius:2px;vertical-align:middle;margin-right:4px;"></span>Red',
  green: '<span style="display:inline-block;width:10px;height:10px;background:#14a03c;border-radius:2px;vertical-align:middle;margin-right:4px;"></span>Green',
};
const SECTOR_COLOR_MEANING: Record<string, string> = {
  white: 'safe water',
  red:   'danger to port',
  green: 'danger to starboard',
};

function lighthouseSectorExtra(lm: Landmark): string {
  if (!lm.sectors?.length) return '';
  const rows = lm.sectors.map(s => {
    const label = SECTOR_COLOR_LABEL[s.color] ?? s.color;
    const meaning = SECTOR_COLOR_MEANING[s.color] ?? '';
    return `<tr><td style="padding:1px 6px 1px 0;">${label}</td><td style="padding:1px 0;color:#444;">${fmt3(s.fromDeg)}°–${fmt3(s.toDeg)}°T</td><td style="padding:1px 0 1px 6px;color:#666;font-style:italic;">${meaning}</td></tr>`;
  }).join('');
  return `<strong style="font-size:11px;">Light sectors:</strong><table style="margin-top:4px;font-size:11px;border-collapse:collapse;">${rows}</table>`;
}

function hitTestAllMarkers(sx: number, sy: number): { name: string; descKey: string; extra?: string } | null {
  if (!chartData) return null;
  const HIT = 18 / transform.scale;   // hit radius in SVG units (scales with zoom)
  const screenHit = HIT * transform.scale; // back to screen pixels for screen-space markers

  for (const lm of chartData.landmarks) {
    const sc = svgToScreen(lm.x, lm.y);
    if (Math.hypot(sc.x - sx, sc.y - sy) < screenHit) {
      const extra = lm.type === 'lighthouse' ? lighthouseSectorExtra(lm) : undefined;
      return { name: lm.name, descKey: lm.type, extra };
    }
  }
  for (const b of chartData.harbour.buoys) {
    const sc = svgToScreen(b.x, b.y);
    if (Math.hypot(sc.x - sx, sc.y - sy) < screenHit) {
      return { name: b.side === 'port' ? 'Port-hand Mark' : 'Starboard-hand Mark', descKey: b.side };
    }
  }
  for (const b of chartData.cardinalBuoys) {
    const sc = svgToScreen(b.x, b.y);
    if (Math.hypot(sc.x - sx, sc.y - sy) < screenHit) {
      return { name: b.name, descKey: b.type };
    }
  }
  for (const a of chartData.anchorages) {
    const sc = svgToScreen(a.x, a.y);
    if (Math.hypot(sc.x - sx, sc.y - sy) < screenHit) {
      return { name: a.name, descKey: 'anchorage' };
    }
  }
  const hsc = svgToScreen(chartData.harbour.entrance.x, chartData.harbour.entrance.y);
  if (Math.hypot(hsc.x - sx, hsc.y - sy) < screenHit * 2) {
    return { name: chartData.harbour.name, descKey: 'harbour' };
  }
  return null;
}

// ── Tool buttons ──────────────────────────────────────────────────────────────

function setActiveTool(tool: ToolName): void {
  if (state.activeTool === 'parallel-rules' && tool !== 'parallel-rules') {
    state.parallelRules = null;
  }
  state.activeTool = tool;
  state.eraseMode  = false;
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset['tool'] === tool);
  });
  if (tool === 'std') createSTDPanel(toolLayer, () => setActiveTool(null));
  else document.getElementById('std-panel')?.remove();
  // Use resolveCursor with a dummy position — gives the right initial cursor
  // (crosshair for draw tools, crosshair for unplaced instruments, grab for pan)
  chartWrap.style.cursor = resolveCursor(tool, -1, -1);
  redraw();
}

document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset['tool'] as ToolName;
    setActiveTool(state.activeTool === t ? null : t);
  });
});

getEl<HTMLButtonElement>('btn-erase').addEventListener('click', () => {
  setActiveTool('pencil');
  setEraseMode(true);
  getEl<HTMLButtonElement>('btn-erase').classList.add('active');
});

getEl<HTMLButtonElement>('btn-clear-all').addEventListener('click', () => {
  clearAllLines();
  pencilStart = null;
  pencilPreviewEnd = null;
  redraw();
});

getEl<HTMLButtonElement>('btn-new-chart').addEventListener('click', () => {
  newChart();
  fitChart();
});

const seedInput = getEl<HTMLInputElement>('seed-input');
getEl<HTMLButtonElement>('btn-seed-chart').addEventListener('click', () => {
  const seed = parseInt(seedInput.value);
  if (!isNaN(seed)) { newChart(seed); fitChart(); }
});
seedInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    const seed = parseInt(seedInput.value);
    if (!isNaN(seed)) { newChart(seed); fitChart(); }
  }
});

// ── Exercise picker ───────────────────────────────────────────────────────────

getEl<HTMLButtonElement>('btn-exercise-menu').addEventListener('click', (e: MouseEvent) => {
  exerciseDropdown.classList.toggle('hidden');
  e.stopPropagation();
});

document.addEventListener('click', () => exerciseDropdown.classList.add('hidden'));

document.querySelectorAll<HTMLButtonElement>('[data-exercise]').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset['exercise'];
    id === 'none' ? clearExercise() : startExercise(parseInt(id!));
    exerciseDropdown.classList.add('hidden');
  });
});

function clearExercise(): void {
  currentEx = null;
  lastScore = null;
  showFeedbackOnCanvas = false;
  wbExField.style.display = 'none';
  removeExerciseInfo();
  enableAllTools();
  redraw();
}

function startExercise(id: number): void {
  if (!chartData) return;
  currentEx = generateExercise(id, chartData);
  if (!currentEx) return;

  lastScore = null;
  showFeedbackOnCanvas = false;
  wbExName.textContent = currentEx.title;
  wbExField.style.display = '';
  showExerciseInfo(currentEx.infoHTML);
  disableToolsExcept(currentEx.enabledTools);

  // Give compass exercises a vessel position to take bearings from
  if ('vessel' in currentEx && currentEx.vessel) {
    state.vessel = currentEx.vessel;
  }
  redraw();
}

function disableToolsExcept(allowed: string[]): void {
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach(btn => {
    btn.disabled = !allowed.includes(btn.dataset['tool'] ?? '');
  });
}

function enableAllTools(): void {
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach(btn => {
    // Compass is only usable during exercises that include it
    btn.disabled = btn.dataset['tool'] === 'compass';
  });
}

function showExerciseInfo(html: string): void {
  removeExerciseInfo();
  const div = document.createElement('div');
  div.id = 'exercise-info';

  const toggle = document.createElement('button');
  toggle.id = 'exercise-info-toggle';
  toggle.title = 'Collapse exercise info';
  toggle.textContent = '▲';
  toggle.addEventListener('click', () => {
    const collapsed = div.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▼' : '▲';
    toggle.title = collapsed ? 'Expand exercise info' : 'Collapse exercise info';
  });

  const body = document.createElement('div');
  body.id = 'exercise-info-body';
  body.innerHTML = html;

  // Convert inline <b> value tags to <span class="val"> for distinct styling.
  // Heading <b> tags are the first *element* child of their <p>/<li> —
  // using firstElementChild avoids whitespace text nodes confusing the check.
  body.querySelectorAll<HTMLElement>('b').forEach(b => {
    const parent = b.parentElement;
    const isHeading = parent &&
      ['P', 'LI'].includes(parent.tagName) &&
      parent.firstElementChild === b;
    if (!isHeading) {
      const span = document.createElement('span');
      span.className = 'val';
      span.innerHTML = b.innerHTML;
      b.replaceWith(span);
    }
  });

  div.appendChild(toggle);
  div.appendChild(body);
  chartWrap.appendChild(div);
}

function removeExerciseInfo(): void {
  document.getElementById('exercise-info')?.remove();
}

// ── Submit ────────────────────────────────────────────────────────────────────

wbSubmit.addEventListener('click', () => {
  if (!currentEx || !chartData) return;

  const wbValues: WorkbookValues = {
    course:   parseFloat(wbCourse.textContent ?? '0') || 0,
    eta:      wbETA.textContent !== '—' ? (wbETA.textContent ?? '') : '',
    distance: parseFloat(wbDistance.textContent ?? '0') || 0,
    speed:    parseFloat(wbSpeed.value) || 0,
  };

  lastScore = scoreExercise(currentEx, chartData, state.lines, wbValues);
  showFeedbackOnCanvas = true;

  feedbackTitle.textContent = `${currentEx.title} — ${lastScore.pass ? '✓ Pass' : '✗ Retry'}`;
  feedbackBody.innerHTML    = lastScore.html;
  feedbackOverlay.classList.remove('hidden');
  redraw();
});

feedbackClose.addEventListener('click', () => {
  feedbackOverlay.classList.add('hidden');
});

// ── Resize observer ───────────────────────────────────────────────────────────

new ResizeObserver(() => resizeAll()).observe(chartWrap);

// ── Boot ──────────────────────────────────────────────────────────────────────

initCanvas(canvasEl);
resizeAll();
newChart();
fitChart();
enableAllTools(); // disable compass until an exercise enables it
