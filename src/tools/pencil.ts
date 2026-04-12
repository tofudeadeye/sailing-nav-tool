import { transform, svgToScreen, screenToSVG, bearing } from '../coords.ts';
import { state, wb } from './types.ts';
import type { DrawnLine, LineType } from './types.ts';

let pencilStart: { x: number; y: number } | null = null;
let pencilPreviewEnd: { x: number; y: number } | null = null;
let nextLineType = 0;
const LINE_TYPES: LineType[] = ['Course Line', 'Bearing Line', 'Position Line', 'DR Track'];

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

/** Bearing of an SVG-space line segment (degrees true, 0 = up). */
export function svgLineBearing(x1: number, y1: number, x2: number, y2: number): number {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  return ((angle * 180) / Math.PI + 90 + 360) % 360;
}

export function setEraseMode(on: boolean): void {
  state.eraseMode = on;
}

export function drawLines(c: CanvasRenderingContext2D): void {
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
    c.fillText(`${line.type}: ${bearing.toFixed(1)}°T`, mx + 4, my - 4);
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
        bearing(svgLineBearing(line.svgX1, line.svgY1, line.svgX2, line.svgY2)),
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
  state.fixes = [];
  pencilStart = null;
  pencilPreviewEnd = null;
}
