/**
 * tools.ts — interactive tool implementations
 *
 * All tool positions are stored in SVG space and projected to screen
 * space for rendering, so pan/zoom never loses instrument placement.
 * Pointer Events are used throughout (no raw mouse events).
 */

import {
  transform, svgToScreen, screenToSVG, svgToLatLon,
  distanceNM, trueBearing, SVG_W, SVG_H,
} from './coords';
import type { ChartData } from './chartGen.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolName =
  | 'pencil'
  | 'dividers'
  | 'parallel-rules'
  | 'plotter'
  | 'compass'
  | 'std'
  | null;

export type LineType = 'Course Line' | 'Bearing Line' | 'Position Line' | 'DR Track';

export interface DrawnLine {
  svgX1: number; svgY1: number;
  svgX2: number; svgY2: number;
  type: LineType;
  selected: boolean;
}

export interface DividersState {
  svgHingeX: number; svgHingeY: number;
  svgTip1X: number;  svgTip1Y: number;
  svgTip2X: number;  svgTip2Y: number;
  dragging: 'hinge' | 'tip1' | 'tip2' | null;
}

export interface ParallelRulesState {
  rule1: { svgX: number; svgY: number };
  rule2: { svgX: number; svgY: number };
  angleDeg: number;
  svgW: number;
  svgH: number;
  dragging: 'rule1' | 'rule2' | null;
  pivot:    'rule1' | 'rule2' | null;
  dragStartSX: number; dragStartSY: number;
  dragStartX:  number; dragStartY:  number;
  onBearingUpdate: ((bearing: number, variation: number) => void) | null;
}

export interface PlotterState {
  svgX: number; svgY: number;
  angleDeg: number;      // rotation of the body (long axis)
  roseAngleDeg: number;  // rotation of the inner compass rose, independent of body
  dragging: 'move' | 'rotate' | 'rose' | null;
  dragStartSX: number; dragStartSY: number;
  dragStartX:  number; dragStartY:  number;
  dragStartRoseAngle: number; // rose angle at drag start
}

export interface STDResult {
  speed: number;
  timeMin: number;
  distNM: number;
}

export interface ToolState {
  activeTool: ToolName;
  lines: DrawnLine[];
  dividers: DividersState | null;
  parallelRules: ParallelRulesState | null;
  plotter: PlotterState | null;
  accumulatedDist: number;
  chartData: ChartData | null;
  vessel: { lat: number; lon: number } | null;
  stdResult: STDResult | null;
  eraseMode: boolean;
}

export interface WorkbookCallbacks {
  setBearing:  ((bearing: number, variation: number) => void) | null;
  setDistance: ((nm: number) => void) | null;
  setAccDist:  ((nm: number) => void) | null;
  setCourse:   ((bearing: number, variation: number) => void) | null;
  setETA:      ((eta: string) => void) | null;
  setDRPos:    ((lat: number, lon: number) => void) | null;
}

export interface BearingResult {
  trueBear: number;
  magBearing: number;
  error: number;
  landmark: { name: string; lat: number; lon: number };
}

// ── Mutable singletons ────────────────────────────────────────────────────────

export const state: ToolState = {
  activeTool: null,
  lines: [],
  dividers: null,
  parallelRules: null,
  plotter: null,
  accumulatedDist: 0,
  chartData: null,
  vessel: null,
  stdResult: null,
  eraseMode: false,
};

export const wb: WorkbookCallbacks = {
  setBearing: null, setDistance: null, setAccDist: null,
  setCourse: null, setETA: null, setDRPos: null,
};

// ── Canvas context ────────────────────────────────────────────────────────────

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

export function initCanvas(el: HTMLCanvasElement): void {
  canvas = el;
  ctx = el.getContext('2d');
}

export function resizeCanvas(w: number, h: number): void {
  if (!canvas) return;
  canvas.width = w;
  canvas.height = h;
}

export function redrawCanvas(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawLines(ctx);
  drawDividers(ctx);
  drawPlotterOverlay(ctx);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Bearing of an SVG-space line segment (degrees true, 0 = up). */
export function svgLineBearing(x1: number, y1: number, x2: number, y2: number): number {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  return ((angle * 180) / Math.PI + 90 + 360) % 360;
}

function bearingLabel(bearing: number, variation: number): string {
  const t = Math.round(((bearing % 360) + 360) % 360);
  const m = Math.round((((bearing + variation) % 360) + 360) % 360);
  return `${String(t).padStart(3, '0')}°T (${String(m).padStart(3, '0')}°M)`;
}

function distToSegment(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function gaussianRandom(): number {
  const u = Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Pencil / Line tool ────────────────────────────────────────────────────────

let pencilStart: { x: number; y: number } | null = null;
let pencilPreviewEnd: { x: number; y: number } | null = null;
let nextLineType = 0;
const LINE_TYPES: LineType[] = ['Course Line', 'Bearing Line', 'Position Line', 'DR Track'];

export function setEraseMode(on: boolean): void {
  state.eraseMode = on;
}

function drawLines(c: CanvasRenderingContext2D): void {
  const variation = state.chartData?.variation ?? 0;

  for (const line of state.lines) {
    const s = svgToScreen(line.svgX1, line.svgY1);
    const e = svgToScreen(line.svgX2, line.svgY2);

    c.save();
    c.strokeStyle = line.selected ? '#ff6633' : '#2244aa';
    c.lineWidth = 1.5;
    c.setLineDash(line.type === 'DR Track' ? [6, 4] : []);
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(e.x, e.y);
    c.stroke();

    const mx = (s.x + e.x) / 2, my = (s.y + e.y) / 2;
    const bearing = svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2);
    c.fillStyle = '#2244aa';
    c.font = '10px Courier New';
    c.fillText(`${line.type}: ${Math.round(bearing)}°T`, mx + 4, my - 4);
    c.restore();
  }

  if (pencilStart && pencilPreviewEnd) {
    const s = svgToScreen(pencilStart.x, pencilStart.y);
    c.save();
    c.strokeStyle = 'rgba(34,68,170,0.5)';
    c.lineWidth = 1.5;
    c.setLineDash([4, 4]);
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(pencilPreviewEnd.x, pencilPreviewEnd.y);
    c.stroke();
    c.restore();
  }
}

export function handlePencilPointerDown(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  if (state.activeTool !== 'pencil') return false;

  const rect = chartWrap.getBoundingClientRect();
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
    const type = LINE_TYPES[nextLineType % LINE_TYPES.length]!;
    nextLineType++;
    const line: DrawnLine = {
      svgX1: pencilStart.x, svgY1: pencilStart.y,
      svgX2: svgPos.x,      svgY2: svgPos.y,
      type, selected: false,
    };
    state.lines.push(line);
    if (wb.setCourse) {
      wb.setCourse(
        svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2),
        state.chartData?.variation ?? 0,
      );
    }
    pencilStart = null;
    pencilPreviewEnd = null;
  }
  return true;
}

export function handlePencilPointerMove(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  if (state.activeTool !== 'pencil' || !pencilStart) return false;
  const rect = chartWrap.getBoundingClientRect();
  pencilPreviewEnd = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  return true;
}

export function clearAllLines(): void {
  state.lines = [];
  pencilStart = null;
  pencilPreviewEnd = null;
}

// ── Dividers ──────────────────────────────────────────────────────────────────

const HANDLE_R = 10; // hit-test radius in screen px

export function spawnDividers(svgX: number, svgY: number): void {
  const spread = SVG_W * 0.06;
  state.dividers = {
    svgHingeX: svgX, svgHingeY: svgY,
    svgTip1X: svgX - spread, svgTip1Y: svgY + spread * 1.2,
    svgTip2X: svgX + spread, svgTip2Y: svgY + spread * 1.2,
    dragging: null,
  };
}

function drawDividers(c: CanvasRenderingContext2D): void {
  const d = state.dividers;
  if (!d) return;

  const h  = svgToScreen(d.svgHingeX, d.svgHingeY);
  const t1 = svgToScreen(d.svgTip1X,  d.svgTip1Y);
  const t2 = svgToScreen(d.svgTip2X,  d.svgTip2Y);

  c.save();
  c.strokeStyle = '#1a1a1a';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(h.x, h.y); c.lineTo(t1.x, t1.y);
  c.moveTo(h.x, h.y); c.lineTo(t2.x, t2.y);
  c.stroke();

  for (const [pt, col] of [[h, '#4a90d9'], [t1, '#333'], [t2, '#333']] as const) {
    c.fillStyle = col;
    c.beginPath();
    c.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    c.fill();
  }

  const { lat: lat1, lon: lon1 } = svgToLatLon(d.svgTip1X, d.svgTip1Y);
  const { lat: lat2, lon: lon2 } = svgToLatLon(d.svgTip2X, d.svgTip2Y);
  const nm = distanceNM(lat1, lon1, lat2, lon2);
  const totalMin = nm * 60;
  const deg = Math.floor(totalMin / 60);
  const min = (totalMin % 60).toFixed(1);

  c.fillStyle = 'rgba(0,0,0,0.75)';
  c.fillRect(h.x + 12, h.y - 24, 168, 20);
  c.fillStyle = '#7fffaa';
  c.font = '12px Courier New';
  c.fillText(`${deg}°${min}' = ${nm.toFixed(2)} NM`, h.x + 16, h.y - 9);
  c.restore();

  wb.setDistance?.(nm);
}

export function handleDividersPointerDown(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const d = state.dividers;
  if (!d) return false;
  const rect = chartWrap.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const h  = svgToScreen(d.svgHingeX, d.svgHingeY);
  const t1 = svgToScreen(d.svgTip1X,  d.svgTip1Y);
  const t2 = svgToScreen(d.svgTip2X,  d.svgTip2Y);

  if (Math.hypot(sx - h.x,  sy - h.y)  < HANDLE_R * 1.5) { d.dragging = 'hinge'; return true; }
  if (Math.hypot(sx - t1.x, sy - t1.y) < HANDLE_R)       { d.dragging = 'tip1';  return true; }
  if (Math.hypot(sx - t2.x, sy - t2.y) < HANDLE_R)       { d.dragging = 'tip2';  return true; }
  return false;
}

export function handleDividersPointerMove(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const d = state.dividers;
  if (!d?.dragging) return false;
  const rect = chartWrap.getBoundingClientRect();
  const svgPos = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);

  if (d.dragging === 'hinge') {
    const dx = svgPos.x - d.svgHingeX, dy = svgPos.y - d.svgHingeY;
    d.svgHingeX = svgPos.x; d.svgHingeY = svgPos.y;
    d.svgTip1X += dx; d.svgTip1Y += dy;
    d.svgTip2X += dx; d.svgTip2Y += dy;
  } else if (d.dragging === 'tip1') {
    d.svgTip1X = svgPos.x; d.svgTip1Y = svgPos.y;
  } else if (d.dragging === 'tip2') {
    d.svgTip2X = svgPos.x; d.svgTip2Y = svgPos.y;
  }
  return true;
}

export function handleDividersPointerUp(): void {
  if (state.dividers) state.dividers.dragging = null;
}

export function accumulateDistance(): void {
  const d = state.dividers;
  if (!d) return;
  const { lat: lat1, lon: lon1 } = svgToLatLon(d.svgTip1X, d.svgTip1Y);
  const { lat: lat2, lon: lon2 } = svgToLatLon(d.svgTip2X, d.svgTip2Y);
  state.accumulatedDist += distanceNM(lat1, lon1, lat2, lon2);
  wb.setAccDist?.(state.accumulatedDist);
}

// ── Portland Course Plotter ───────────────────────────────────────────────────
//
// Visual anatomy (all in local plotter space, centre = 0,0):
//
//   ┌─────────────────────────────────────────────────────┐  ← top edge (course line)
//   │  |   |   |   |   |   |   |   |   |   |   |   |   |  │  ← parallel meridian grid lines
//   │         ┌──────────────────┐                         │
//   │         │   360° rose      │                         │
//   │  |   |  │  with N pointer  │  |   |   |   |   |   | ─►  ← blue direction arrow
//   │         │  (fixed to body) │                         │
//   │         └──────────────────┘                         │
//   └─────────────────────────────────────────────────────┘  ← bottom edge (course line)
//
// The long axis runs L→R.  Bearing = angle of long axis relative to SVG north.
// Grid lines run perpendicular to long axis; when they align with chart meridians
// (SVG vertical lines), the rose reads the true course at the index mark.

// Body dimensions in screen pixels (independent of zoom — drawn at screen scale)
const PCP_W   = 560; //280;  // total width of body
const PCP_H   = 260; //130;  // total height of body
const PCP_ROSE_R = 100; // compass rose radius
// How far the "course edge" lines extend beyond the body on each side
const PCP_EDGE_EXT = 60;
// Grid line spacing (perpendicular to long axis)
const PCP_GRID_SPACING = 16;

export function spawnPlotter(svgX: number, svgY: number): void {
  state.plotter = {
    svgX, svgY,
    angleDeg: 0,
    roseAngleDeg: 0,
    dragging: null,
    dragStartSX: 0, dragStartSY: 0,
    dragStartX: 0,  dragStartY: 0,
    dragStartRoseAngle: 0,
  };
}

function drawPlotterOverlay(c: CanvasRenderingContext2D): void {
  const p = state.plotter;
  if (!p) return;
  const centre = svgToScreen(p.svgX, p.svgY);

  c.save();
  c.translate(centre.x, centre.y);
  c.rotate((p.angleDeg * Math.PI) / 180);

  const hw = PCP_W / 2, hh = PCP_H / 2;

  // ── Extended course-edge lines (dashed, reaching beyond body) ──
  c.save();
  c.strokeStyle = 'rgba(180,0,0,0.6)';
  c.lineWidth = 1;
  c.setLineDash([6, 4]);
  // Top edge extension
  c.beginPath();
  c.moveTo(-(hw + PCP_EDGE_EXT), -hh); c.lineTo(-hw, -hh);
  c.moveTo( hw, -hh);                  c.lineTo( hw + PCP_EDGE_EXT, -hh);
  // Bottom edge extension
  c.moveTo(-(hw + PCP_EDGE_EXT), hh);  c.lineTo(-hw, hh);
  c.moveTo( hw, hh);                   c.lineTo( hw + PCP_EDGE_EXT, hh);
  c.stroke();
  c.setLineDash([]);
  c.restore();

  // ── Body (transparent acrylic tint) ──
  c.save();
  c.fillStyle = 'rgba(210,235,255,0.38)';
  c.strokeStyle = '#1a4080';
  c.lineWidth = 1.5;
  c.fillRect(-hw, -hh, PCP_W, PCP_H);
  c.restore();

  // ── Parallel meridian-alignment grid lines (perpendicular to long axis) ──
  // These are the lines the navigator aligns with chart meridians.
  c.save();
  c.strokeStyle = 'rgba(0,80,160,0.35)';
  c.lineWidth = 0.8;
  // Draw lines from left edge to right edge at vertical intervals
  for (let y = -hh + PCP_GRID_SPACING; y < hh; y += PCP_GRID_SPACING) {
    c.beginPath();
    c.moveTo(-hw, y); c.lineTo(hw, y);
    c.stroke();
  }
  // Centre meridian line (heavier) — the primary alignment line
  c.strokeStyle = 'rgba(0,80,160,0.65)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(0, -hh); c.lineTo(0, hh);
  c.stroke();
  c.restore();

  // ── Body border (drawn after fill so it's on top) ──
  c.save();
  c.strokeStyle = '#1a4080';
  c.lineWidth = 1.5;
  c.strokeRect(-hw, -hh, PCP_W, PCP_H);

  // Solid top and bottom course-edge lines (the plotting edges)
  c.strokeStyle = '#cc0000';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-hw, -hh); c.lineTo(hw, -hh); // top edge
  c.moveTo(-hw,  hh); c.lineTo(hw,  hh); // bottom edge
  c.stroke();
  c.restore();

  // ── Compass rose (360°, fixed to body) ──
  // Rose rotates independently; roseAngleDeg is relative to the body
  drawPCPRose(c, 0, 0, PCP_ROSE_R, p.roseAngleDeg - p.angleDeg);

  // ── Direction arrow (blue) pointing in the +x / forward direction ──
  // Prevents reading the reciprocal bearing by mistake.
  c.save();
  c.strokeStyle = '#0055cc';
  c.fillStyle   = '#0055cc';
  c.lineWidth   = 2;
  const arrowX = hw - 18, arrowY = 0;
  const arrowLen = 22, arrowHead = 7;
  c.beginPath();
  c.moveTo(arrowX - arrowLen, arrowY);
  c.lineTo(arrowX, arrowY);
  c.stroke();
  // Arrowhead
  c.beginPath();
  c.moveTo(arrowX, arrowY);
  c.lineTo(arrowX - arrowHead, arrowY - arrowHead * 0.55);
  c.lineTo(arrowX - arrowHead, arrowY + arrowHead * 0.55);
  c.closePath();
  c.fill();
  c.restore();

  // ── Edge degree scale (top edge, 0° at left → 180° at right, both sides) ──
  c.save();
  c.strokeStyle = '#1a3a5c';
  c.fillStyle   = '#1a3a5c';
  c.font        = '7px sans-serif';
  c.textAlign   = 'center';
  for (let i = 0; i <= 18; i++) {
    const deg = i * 10;
    const ex  = -hw + (i / 18) * PCP_W;
    const tickH = deg % 30 === 0 ? 9 : deg % 10 === 0 ? 6 : 4;
    c.lineWidth = deg % 30 === 0 ? 1.2 : 0.7;
    // Top edge ticks (pointing inward)
    c.beginPath();
    c.moveTo(ex, -hh); c.lineTo(ex, -hh + tickH);
    c.stroke();
    // Bottom edge ticks (pointing inward)
    c.beginPath();
    c.moveTo(ex, hh); c.lineTo(ex, hh - tickH);
    c.stroke();
    if (deg % 30 === 0 && deg > 0 && deg < 180) {
      c.fillText(String(deg), ex, -hh + tickH + 8);
    }
  }
  c.restore();

  // ── "PORTLAND COURSE PLOTTER" label ──
  c.save();
  c.fillStyle = 'rgba(10,40,90,0.55)';
  c.font      = 'bold 7px sans-serif';
  c.textAlign = 'center';
  c.fillText('PORTLAND COURSE PLOTTER', hw * 0.55, hh - 7);
  c.restore();

  c.restore(); // end of rotated transform

  // ── Bearing readout label (outside the plotter, in screen space) ──
  // True course = body angle (from SVG x-axis) offset to north, minus the rose
  // offset. When rose N aligns with a chart meridian (roseAngleDeg = 0) the
  // body long-axis bearing is read directly at the index mark.
  const bearing   = ((p.angleDeg - p.roseAngleDeg) + 90 + 360) % 360;
  const variation = state.chartData?.variation ?? 0;
  const label     = `Plotter: ${bearingLabel(bearing, variation)}`;

  // Position the label above the plotter's top edge in screen space
  const topEdgeX = centre.x - Math.sin((p.angleDeg * Math.PI) / 180) * hh;
  const topEdgeY = centre.y - Math.cos((p.angleDeg * Math.PI) / 180) * hh;
  const labelW   = 200;
  const lx       = topEdgeX - labelW / 2;
  const ly       = topEdgeY - 30;

  c.save();
  c.fillStyle = 'rgba(0,0,0,0.78)';
  c.beginPath();
  c.roundRect(lx, ly, labelW, 22, 4);
  c.fill();
  c.fillStyle = '#aaff66';
  c.font      = 'bold 12px Courier New';
  c.textAlign = 'left';
  c.fillText(label, lx + 7, ly + 15);
  c.restore();

  // ── Rotation handle (circle at right tip of body in screen space) ──
  const rad      = (p.angleDeg * Math.PI) / 180;
  const rotHX    = centre.x + Math.cos(rad) * hw;
  const rotHY    = centre.y + Math.sin(rad) * hw;
  c.save();
  c.fillStyle   = '#0055cc';
  c.strokeStyle = '#fff';
  c.lineWidth   = 1.5;
  c.beginPath();
  c.arc(rotHX, rotHY, 7, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.restore();
}

/**
 * Draws the 360° compass rose centred at (cx, cy) with given radius.
 * roseOffset rotates the entire disc (independent of the body).
 * The fixed index mark on the body always reads at the 12-o'clock position.
 */
function drawPCPRose(
  c: CanvasRenderingContext2D,
  cx: number, cy: number,
  r: number,
  roseOffset: number,
): void {
  // Clip to the disc so nothing bleeds outside
  c.save();
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.clip();

  // Background disc
  c.fillStyle   = 'rgba(255,255,255,0.72)';
  c.fill();

  // Rotate all rose content by roseOffset
  c.translate(cx, cy);
  c.rotate((roseOffset * Math.PI) / 180);

  // Degree ticks
  for (let deg = 0; deg < 360; deg++) {
    const rad      = ((deg - 90) * Math.PI) / 180;
    const isMajor  = deg % 10 === 0;
    const isMedium = deg % 5  === 0;
    const tickLen  = isMajor ? 10 : isMedium ? 6 : 3;
    const col      = deg % 90 === 0 ? '#cc0000' : '#1a3a5c';
    c.strokeStyle  = col;
    c.lineWidth    = isMajor ? 1.2 : 0.6;
    c.beginPath();
    c.moveTo((r - 1) * Math.cos(rad),           (r - 1) * Math.sin(rad));
    c.lineTo((r - 1 - tickLen) * Math.cos(rad), (r - 1 - tickLen) * Math.sin(rad));
    c.stroke();
  }

  // Degree labels every 10°
  c.font        = '6px sans-serif';
  c.textAlign   = 'center';
  c.textBaseline = 'middle';
  for (let deg = 0; deg < 360; deg += 10) {
    const rad = ((deg - 90) * Math.PI) / 180;
    const lr  = r - 16;
    c.fillStyle = deg % 90 === 0 ? '#cc0000' : '#1a3a5c';
    c.save();
    c.translate(lr * Math.cos(rad), lr * Math.sin(rad));
    c.rotate(rad + Math.PI / 2);
    c.fillText(String(deg).padStart(3, '0'), 0, 0);
    c.restore();
  }

  // Cardinal letters (N E S W)
  const cardinals: Array<[number, string, string]> = [
    [0, 'N', '#cc0000'], [90, 'E', '#1a3a5c'],
    [180, 'S', '#1a3a5c'], [270, 'W', '#1a3a5c'],
  ];
  c.font = 'bold 9px sans-serif';
  for (const [deg, label, col] of cardinals) {
    const rad = ((deg - 90) * Math.PI) / 180;
    const lr  = r - 28;
    c.fillStyle    = col;
    c.textAlign    = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, lr * Math.cos(rad), lr * Math.sin(rad));
  }

  // N–S alignment line on the rose (rotates with the disc)
  c.strokeStyle = 'rgba(180,0,0,0.55)';
  c.lineWidth   = 1;
  c.setLineDash([3, 2]);
  c.beginPath();
  c.moveTo(0, -(r - 2)); c.lineTo(0, r - 2);
  c.stroke();
  c.setLineDash([]);

  c.restore(); // undo translate+rotate

  // ── Fixed index mark on the body (not affected by rose rotation) ──
  // A red triangle at the top pointing down — the reading index
  c.save();
  c.fillStyle = '#cc0000';
  c.beginPath();
  c.moveTo(cx, cy - r + 2);
  c.lineTo(cx - 5, cy - r - 7);
  c.lineTo(cx + 5, cy - r - 7);
  c.closePath();
  c.fill();
  c.restore();

  // ── Disc border (drawn last, on top) ──
  c.save();
  c.strokeStyle = '#1a3a5c';
  c.lineWidth   = 1.2;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.stroke();

  // Rose drag handle ring (subtle outer ring indicates it's rotatable)
  c.strokeStyle = 'rgba(0,85,204,0.4)';
  c.lineWidth   = 3;
  c.beginPath();
  c.arc(cx, cy, r - 1, 0, Math.PI * 2);
  c.stroke();

  // Centre dot
  c.fillStyle = '#1a3a5c';
  c.beginPath();
  c.arc(cx, cy, 2.5, 0, Math.PI * 2);
  c.fill();

  c.restore();
}

export function handlePlotterPointerDown(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const p = state.plotter;
  if (!p) return false;
  const rect   = chartWrap.getBoundingClientRect();
  const sx     = e.clientX - rect.left, sy = e.clientY - rect.top;
  const centre = svgToScreen(p.svgX, p.svgY);
  const hw     = PCP_W / 2;
  const rad    = (p.angleDeg * Math.PI) / 180;

  // ── 1. Rose disc hit — inner compass rose rotates independently ──
  // Transform pointer into the body's local space, then check distance from centre
  const dx   = sx - centre.x, dy = sy - centre.y;
  const cosA = Math.cos(-rad), sinA = Math.sin(-rad);
  const lx   = dx * cosA - dy * sinA;
  const ly   = dx * sinA + dy * cosA;
  if (Math.hypot(lx, ly) < PCP_ROSE_R) {
    p.dragging           = 'rose';
    p.dragStartSX        = sx; p.dragStartSY = sy;
    p.dragStartRoseAngle = p.roseAngleDeg;
    return true;
  }

  // ── 2. Body rotation handle: circle at the right tip ──
  const rotHX = centre.x + Math.cos(rad) * hw;
  const rotHY = centre.y + Math.sin(rad) * hw;
  if (Math.hypot(sx - rotHX, sy - rotHY) < 14) {
    p.dragging    = 'rotate';
    p.dragStartSX = sx; p.dragStartSY = sy;
    return true;
  }

  // ── 3. Body move (anywhere else on the body) ──
  if (Math.abs(lx) < PCP_W / 2 && Math.abs(ly) < PCP_H / 2) {
    p.dragging    = 'move';
    p.dragStartSX = sx; p.dragStartSY = sy;
    p.dragStartX  = p.svgX; p.dragStartY = p.svgY;
    return true;
  }
  return false;
}

export function handlePlotterPointerMove(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const p = state.plotter;
  if (!p?.dragging) return false;
  const rect   = chartWrap.getBoundingClientRect();
  const sx     = e.clientX - rect.left, sy = e.clientY - rect.top;
  const centre = svgToScreen(p.svgX, p.svgY);

  if (p.dragging === 'rotate') {
    // Body rotation: angle of pointer relative to plotter centre
    p.angleDeg = (Math.atan2(sy - centre.y, sx - centre.x) * 180) / Math.PI;
  } else if (p.dragging === 'rose') {
    // Rose rotation: delta angle from drag start
    const startAngle = (Math.atan2(p.dragStartSY - centre.y, p.dragStartSX - centre.x) * 180) / Math.PI;
    const curAngle   = (Math.atan2(sy - centre.y, sx - centre.x) * 180) / Math.PI;
    p.roseAngleDeg   = p.dragStartRoseAngle + (curAngle - startAngle);
  } else {
    const svgPos  = screenToSVG(sx, sy);
    const svgFrom = screenToSVG(p.dragStartSX, p.dragStartSY);
    p.svgX = p.dragStartX + (svgPos.x - svgFrom.x);
    p.svgY = p.dragStartY + (svgPos.y - svgFrom.y);
  }
  return true;
}

export function handlePlotterPointerUp(): void {
  if (state.plotter) state.plotter.dragging = null;
}

// ── Parallel Rules ────────────────────────────────────────────────────────────

export function spawnParallelRules(
  svgX: number,
  svgY: number,
  onBearingUpdate: (bearing: number, variation: number) => void,
): void {
  const gap = SVG_H * 0.06;
  state.parallelRules = {
    rule1: { svgX, svgY: svgY - gap / 2 },
    rule2: { svgX, svgY: svgY + gap / 2 },
    angleDeg: 0,
    svgW: SVG_W * 0.25,
    svgH: SVG_H * 0.025,
    dragging: null,
    pivot: null,
    dragStartSX: 0, dragStartSY: 0,
    dragStartX:  0, dragStartY:  0,
    onBearingUpdate,
  };
}

export function drawParallelRules(c: CanvasRenderingContext2D): void {
  const pr = state.parallelRules;
  if (!pr) return;
  const variation = state.chartData?.variation ?? 0;

  const drawRule = (r: { svgX: number; svgY: number }, highlight: boolean): void => {
    const centre = svgToScreen(r.svgX, r.svgY);
    const w = pr.svgW * transform.scale;
    const h = pr.svgH * transform.scale;
    c.save();
    c.translate(centre.x, centre.y);
    c.rotate((pr.angleDeg * Math.PI) / 180);
    c.fillStyle   = highlight ? 'rgba(74,144,217,0.55)' : 'rgba(30,50,80,0.65)';
    c.strokeStyle = '#4a90d9';
    c.lineWidth   = 1.5;
    c.fillRect(-w / 2, -h / 2, w, h);
    c.strokeRect(-w / 2, -h / 2, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.lineWidth = 0.8;
    for (let i = 0; i <= 10; i++) {
      const tx = -w / 2 + (i / 10) * w;
      c.beginPath();
      c.moveTo(tx, -h / 2); c.lineTo(tx, -h / 2 + h * 0.35);
      c.stroke();
    }
    c.restore();
  };

  drawRule(pr.rule1, pr.dragging === 'rule1');
  drawRule(pr.rule2, pr.dragging === 'rule2');

  // Pivot indicator
  const pivotRule = pr.pivot === 'rule1' ? pr.rule1 : pr.pivot === 'rule2' ? pr.rule2 : null;
  if (pivotRule) {
    const pc = svgToScreen(pivotRule.svgX, pivotRule.svgY);
    c.fillStyle = '#ff6633';
    c.beginPath();
    c.arc(pc.x, pc.y, 6, 0, Math.PI * 2);
    c.fill();
  }

  // Check proximity to compass rose
  const rose = state.chartData?.compassRose;
  if (rose) {
    const rs = svgToScreen(rose.x, rose.y);
    const r1c = svgToScreen(pr.rule1.svgX, pr.rule1.svgY);
    const r2c = svgToScreen(pr.rule2.svgX, pr.rule2.svgY);
    const threshold = rose.r * 1.5 * transform.scale;
    const nearRose =
      Math.hypot(r1c.x - rs.x, r1c.y - rs.y) < threshold ||
      Math.hypot(r2c.x - rs.x, r2c.y - rs.y) < threshold;
    if (nearRose) {
      const bearing = (pr.angleDeg + 90 + 360) % 360;
      pr.onBearingUpdate?.(bearing, variation);
    }
  }

  const bearing = (pr.angleDeg + 90 + 360) % 360;
  const label = bearingLabel(bearing, variation);
  const c1 = svgToScreen(pr.rule1.svgX, pr.rule1.svgY);
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.75)';
  c.fillRect(c1.x - 80, c1.y - 28, 184, 20);
  c.fillStyle = '#ffdd88';
  c.font = '12px Courier New';
  c.fillText(`Rules: ${label}`, c1.x - 76, c1.y - 13);
  c.restore();
}

export function handleRulesPointerDown(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const pr = state.parallelRules;
  if (!pr) return false;
  const rect = chartWrap.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

  const hitRule = (r: { svgX: number; svgY: number }): boolean => {
    const centre = svgToScreen(r.svgX, r.svgY);
    const cosA = Math.cos((-pr.angleDeg * Math.PI) / 180);
    const sinA = Math.sin((-pr.angleDeg * Math.PI) / 180);
    const dx = sx - centre.x, dy = sy - centre.y;
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    const hw = (pr.svgW / 2) * transform.scale;
    const hh = (pr.svgH / 2) * transform.scale + 8;
    return Math.abs(lx) < hw && Math.abs(ly) < hh;
  };

  if (hitRule(pr.rule1)) {
    pr.dragging = 'rule1';
    pr.dragStartSX = sx; pr.dragStartSY = sy;
    pr.dragStartX = pr.rule1.svgX; pr.dragStartY = pr.rule1.svgY;
    if (!pr.pivot) pr.pivot = 'rule2';
    return true;
  }
  if (hitRule(pr.rule2)) {
    pr.dragging = 'rule2';
    pr.dragStartSX = sx; pr.dragStartSY = sy;
    pr.dragStartX = pr.rule2.svgX; pr.dragStartY = pr.rule2.svgY;
    if (!pr.pivot) pr.pivot = 'rule1';
    return true;
  }
  return false;
}

export function handleRulesPointerMove(
  e: PointerEvent,
  chartWrap: HTMLElement,
): boolean {
  const pr = state.parallelRules;
  if (!pr?.dragging) return false;
  const rect = chartWrap.getBoundingClientRect();
  const svgPos  = screenToSVG(e.clientX - rect.left, e.clientY - rect.top);
  const svgFrom = screenToSVG(pr.dragStartSX, pr.dragStartSY);
  const dx = svgPos.x - svgFrom.x, dy = svgPos.y - svgFrom.y;

  if (pr.dragging === 'rule1') {
    pr.rule1.svgX = pr.dragStartX + dx;
    pr.rule1.svgY = pr.dragStartY + dy;
  } else {
    pr.rule2.svgX = pr.dragStartX + dx;
    pr.rule2.svgY = pr.dragStartY + dy;
  }

  // Recalculate shared angle from the line between the two rule centres
  pr.angleDeg =
    (Math.atan2(pr.rule2.svgY - pr.rule1.svgY, pr.rule2.svgX - pr.rule1.svgX) * 180) /
      Math.PI -
    90;
  return true;
}

export function handleRulesPointerUp(): void {
  const pr = state.parallelRules;
  if (!pr) return;
  if (pr.dragging) pr.pivot = pr.dragging;
  pr.dragging = null;
}

// ── Hand Bearing Compass ──────────────────────────────────────────────────────

export function takeBearing(
  landmark: { name: string; lat: number; lon: number },
  vesselLat: number,
  vesselLon: number,
  variation: number,
): BearingResult {
  const trueBear = trueBearing(vesselLat, vesselLon, landmark.lat, landmark.lon);
  const error = gaussianRandom() * 2;
  const magBearing = Math.round((((trueBear + variation + error) % 360) + 360) % 360 * 10) / 10;
  return { trueBear, magBearing, error, landmark };
}

// ── Speed-Time-Distance panel ─────────────────────────────────────────────────

export function createSTDPanel(toolLayer: HTMLElement): void {
  if (document.getElementById('std-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'std-panel';
  panel.innerHTML = `
    <h4>Speed · Time · Distance</h4>
    <div class="std-row">
      <label>Speed</label>
      <input type="number" id="std-speed" min="0" max="30" step="0.1" value="6" />
      <span class="unit">kn</span>
    </div>
    <div class="std-row">
      <label>Time</label>
      <input type="number" id="std-time" min="0" max="9999" step="1" value="60" />
      <span class="unit">min</span>
    </div>
    <div class="std-row">
      <label>Distance</label>
      <span id="std-dist-out" class="std-computed">—</span>
      <span class="unit">NM</span>
    </div>
    <button id="std-push-btn">Push to Workbook</button>
  `;
  panel.style.left = '20px';
  panel.style.top  = '80px';
  toolLayer.appendChild(panel);

  const speedEl  = panel.querySelector<HTMLInputElement>('#std-speed')!;
  const timeEl   = panel.querySelector<HTMLInputElement>('#std-time')!;
  const distOut  = panel.querySelector<HTMLElement>('#std-dist-out')!;

  const update = (): void => {
    const s = parseFloat(speedEl.value) || 0;
    const t = parseFloat(timeEl.value) || 0;
    const dist = s * (t / 60);
    distOut.textContent = dist.toFixed(2);
    state.stdResult = { speed: s, timeMin: t, distNM: dist };
  };

  speedEl.addEventListener('input', update);
  timeEl.addEventListener('input', update);
  update();

  panel.querySelector('#std-push-btn')!.addEventListener('click', () => {
    const res = state.stdResult;
    if (!res) return;
    const depTimeEl = document.getElementById('wb-dep-time') as HTMLInputElement | null;
    const depTime = depTimeEl?.value ?? '09:00';
    const [hh = 9, mm = 0] = depTime.split(':').map(Number);
    const etaMins = hh * 60 + mm + res.timeMin;
    const etaH = Math.floor(etaMins / 60) % 24;
    const etaM = Math.round(etaMins % 60);
    const eta = `${String(etaH).padStart(2, '0')}:${String(etaM).padStart(2, '0')}`;
    wb.setETA?.(eta);
    const wbDist = document.getElementById('wb-distance');
    if (wbDist) wbDist.textContent = res.distNM.toFixed(2) + ' NM';
  });

  // Drag to reposition
  let dragging = false, ox = 0, oy = 0;
  panel.addEventListener('pointerdown', (ev: PointerEvent) => {
    const target = ev.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'BUTTON') return;
    dragging = true;
    panel.setPointerCapture(ev.pointerId);
    ox = ev.clientX - panel.offsetLeft;
    oy = ev.clientY - panel.offsetTop;
  });
  panel.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!dragging) return;
    panel.style.left = `${ev.clientX - ox}px`;
    panel.style.top  = `${ev.clientY - oy}px`;
  });
  panel.addEventListener('pointerup', () => { dragging = false; });
}

export function removeSTDPanel(): void {
  document.getElementById('std-panel')?.remove();
}

// ── Hover hit-tests (used by main.ts to set cursor) ──────────────────────────

export type PlotterHitZone = 'rose' | 'body' | 'rotate-handle' | null;

/** Returns which zone of the plotter the pointer is over, or null. */
export function hitTestPlotterZone(sx: number, sy: number): PlotterHitZone {
  const p = state.plotter;
  if (!p) return null;
  const centre = svgToScreen(p.svgX, p.svgY);
  const hw     = PCP_W / 2;
  const rad    = (p.angleDeg * Math.PI) / 180;

  const dx   = sx - centre.x, dy = sy - centre.y;
  const cosA = Math.cos(-rad), sinA = Math.sin(-rad);
  const lx   = dx * cosA - dy * sinA;
  const ly   = dx * sinA + dy * cosA;

  // Rose disc (checked first — it is inside the body)
  if (Math.hypot(lx, ly) < PCP_ROSE_R) return 'rose';

  // Rotation handle at right tip
  const rotHX = centre.x + Math.cos(rad) * hw;
  const rotHY = centre.y + Math.sin(rad) * hw;
  if (Math.hypot(sx - rotHX, sy - rotHY) < 14) return 'rotate-handle';

  // Rest of body
  if (Math.abs(lx) < PCP_W / 2 && Math.abs(ly) < PCP_H / 2) return 'body';

  return null;
}

/** Returns true when screen point (sx, sy) is over any draggable part of the plotter. */
export function hitTestPlotter(sx: number, sy: number): boolean {
  return hitTestPlotterZone(sx, sy) !== null;
}

/** Returns true when screen point is over any draggable part of the dividers. */
export function hitTestDividers(sx: number, sy: number): boolean {
  const d = state.dividers;
  if (!d) return false;
  const h  = svgToScreen(d.svgHingeX, d.svgHingeY);
  const t1 = svgToScreen(d.svgTip1X,  d.svgTip1Y);
  const t2 = svgToScreen(d.svgTip2X,  d.svgTip2Y);
  return (
    Math.hypot(sx - h.x,  sy - h.y)  < HANDLE_R * 1.5 ||
    Math.hypot(sx - t1.x, sy - t1.y) < HANDLE_R ||
    Math.hypot(sx - t2.x, sy - t2.y) < HANDLE_R
  );
}

/** Returns true when screen point is over either parallel rule bar. */
export function hitTestParallelRules(sx: number, sy: number): boolean {
  const pr = state.parallelRules;
  if (!pr) return false;

  const hitRule = (r: { svgX: number; svgY: number }): boolean => {
    const centre = svgToScreen(r.svgX, r.svgY);
    const cosA   = Math.cos((-pr.angleDeg * Math.PI) / 180);
    const sinA   = Math.sin((-pr.angleDeg * Math.PI) / 180);
    const dx = sx - centre.x, dy = sy - centre.y;
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;
    const hw = (pr.svgW / 2) * transform.scale;
    const hh = (pr.svgH / 2) * transform.scale + 8;
    return Math.abs(lx) < hw && Math.abs(ly) < hh;
  };

  return hitRule(pr.rule1) || hitRule(pr.rule2);
}

// ── Composite draw hook (called by main render loop) ─────────────────────────

export function drawAllToolOverlays(c: CanvasRenderingContext2D): void {
  drawParallelRules(c);
}


