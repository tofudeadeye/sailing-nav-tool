/**
 * main.ts — application bootstrap, pan/zoom, event routing, render loop
 */

import {
  transform, svgToScreen, screenToSVG, svgToLatLon,
  latLonToSVG, formatLatLon, SVG_W, SVG_H,
} from './coords.ts';
import { generateChart, renderChartToSVG } from './chartGen.ts';
import type { ChartData } from './chartGen.ts';
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
  wbVariation.textContent = `${chartData.variation}°W`;

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
  const s = Math.min(w / SVG_W, h / SVG_H) * 0.95;
  transform.scale   = s;
  transform.offsetX = (w - SVG_W * s) / 2;
  transform.offsetY = (h - SVG_H * s) / 2;
  applyTransform();
}

chartWrap.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault();
  const rect  = chartWrap.getBoundingClientRect();
  const mx    = e.clientX - rect.left;
  const my    = e.clientY - rect.top;
  const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const ns    = Math.max(0.3, Math.min(8, transform.scale * delta));
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
  redraw();
}

// ── Pointer events ────────────────────────────────────────────────────────────

let isPanning = false;
let panStart  = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };

chartWrap.addEventListener('pointerdown', (e: PointerEvent) => {
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

  if (tool === 'compass') { onCompassClick(e); return; }

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
    wb.setCourse?.(
      svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2),
      chartData?.variation ?? 0,
    );
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
    if (Math.hypot(sc.x - sx, sc.y - sy) < 40) return true;
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
  if (!nearest || nearestDist > 40) return;

  const vessel = state.vessel ?? chartCentre();
  const { lat: lmLat, lon: lmLon } = svgToLatLon(nearest.x, nearest.y);
  const result = takeBearing(
    { ...nearest, lat: lmLat, lon: lmLon },
    vessel.lat, vessel.lon,
    chartData.variation,
  );

  wb.setBearing?.(result.trueBear, chartData.variation);
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

// ── Tool buttons ──────────────────────────────────────────────────────────────

function setActiveTool(tool: ToolName): void {
  state.activeTool = tool;
  state.eraseMode  = false;
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset['tool'] === tool);
  });
  if (tool === 'std') createSTDPanel(toolLayer);
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
    btn.disabled = false;
  });
}

function showExerciseInfo(html: string): void {
  removeExerciseInfo();
  const div = document.createElement('div');
  div.id = 'exercise-info';
  div.innerHTML = html;
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
