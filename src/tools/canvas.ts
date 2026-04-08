import { drawLines } from './pencil.ts';
import { drawDividers } from './dividers.ts';
import { drawPlotterOverlay } from './plotter.ts';
import { drawParallelRules } from './parallelRules.ts';
import { transform, SVG_W, SVG_H, CHART_BOUNDS, svgToScreen } from '../coords.ts';

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
  drawBorderTicks(ctx, canvas.width, canvas.height);
  drawScaleBar(ctx, canvas.width, canvas.height);
}

/**
 * Border tick marks drawn on the canvas overlay, anchored to the chart edge in SVG space.
 * Every 60 SVG px = 1 arc-minute latitude = 1 NM. Ticks scale correctly at any zoom.
 */
function drawBorderTicks(c: CanvasRenderingContext2D, screenW: number, screenH: number): void {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  // SVG px per arc-minute — tick spacing scales with zoom automatically
  const pxPerLatMin = SVG_H / ((maxLat - minLat) * 60);
  const pxPerLonMin = SVG_W / ((maxLon - minLon) * 60);
  const latMins = Math.round((maxLat - minLat) * 60);
  const lonMins = Math.round((maxLon - minLon) * 60);

  // Chart edge positions in screen space (derived from SVG coords × scale + offset)
  const topLeft    = svgToScreen(0,     0);
  const topRight   = svgToScreen(SVG_W, 0);
  const bottomLeft = svgToScreen(0,     SVG_H);

  const chartW = topRight.x - topLeft.x;   // SVG_W * s
  const chartH = bottomLeft.y - topLeft.y; // SVG_H * s

  const TICK_LONG  = 16;
  const TICK_SHORT = 8;
  const BG = 'rgba(220,232,240,0.97)';
  const FG = '#1a3a5c';
  const fontSize = 10;

  c.save();
  c.font = `${fontSize}px "Courier New", monospace`;
  c.fillStyle = FG;
  c.strokeStyle = FG;
  c.lineWidth = 1;

  // ── Background panels — extend to full canvas edges to eliminate dead space ─
  c.fillStyle = BG;
  // Left strip: full canvas height, from left edge to chart left edge
  c.fillRect(0, 0, topLeft.x, screenH);
  // Right strip: full canvas height, from chart right edge to canvas right
  c.fillRect(topRight.x, 0, screenW - topRight.x, screenH);
  // Top strip: between left and right chart edges, above chart
  c.fillRect(topLeft.x, 0, chartW, topLeft.y);
  // Bottom strip: between left and right chart edges, below chart
  c.fillRect(topLeft.x, bottomLeft.y, chartW, screenH - bottomLeft.y);

  // ── Inner frame line around chart ─────────────────────────────────────────
  c.strokeStyle = FG;
  c.lineWidth = 1.5;
  c.strokeRect(topLeft.x, topLeft.y, chartW, chartH);

  c.fillStyle = FG;
  c.strokeStyle = FG;
  c.lineWidth = 1;

  // ── Lat ticks on left and right edges ────────────────────────────────────
  for (let m = 0; m <= latMins; m++) {
    const svgY = m * pxPerLatMin;
    const { y: sy } = svgToScreen(0, svgY);
    const isMajor = m % 5 === 0;
    const tLen = isMajor ? TICK_LONG : TICK_SHORT;

    c.beginPath();
    c.moveTo(topLeft.x, sy);
    c.lineTo(topLeft.x + tLen, sy);
    c.stroke();

    c.beginPath();
    c.moveTo(topRight.x, sy);
    c.lineTo(topRight.x - tLen, sy);
    c.stroke();

    if (isMajor) {
      const latDeg = maxLat - (svgY / SVG_H) * (maxLat - minLat);
      const d = Math.floor(Math.abs(latDeg));
      const mn = Math.round((Math.abs(latDeg) - d) * 60).toString().padStart(2, '0');
      const label = `${d}°${mn}'`;

      c.textAlign = 'right';
      c.fillText(label, topLeft.x - 3, sy + fontSize * 0.4);
      c.textAlign = 'left';
      c.fillText(label, topRight.x + 3, sy + fontSize * 0.4);
    }
  }

  // ── Lon ticks on top and bottom edges ────────────────────────────────────
  for (let m = 0; m <= lonMins; m++) {
    const svgX = m * pxPerLonMin;
    const { x: sx } = svgToScreen(svgX, 0);
    const isMajor = m % 5 === 0;
    const tLen = isMajor ? TICK_LONG : TICK_SHORT;

    c.beginPath();
    c.moveTo(sx, topLeft.y);
    c.lineTo(sx, topLeft.y + tLen);
    c.stroke();

    c.beginPath();
    c.moveTo(sx, bottomLeft.y);
    c.lineTo(sx, bottomLeft.y - tLen);
    c.stroke();

    if (isMajor) {
      const lonDeg = minLon + (svgX / SVG_W) * (maxLon - minLon);
      const sign = lonDeg < 0 ? 'W' : 'E';
      const absD = Math.abs(lonDeg);
      const d = Math.floor(absD);
      const mn = Math.round((absD - d) * 60).toString().padStart(2, '0');
      const label = `${d}°${mn}'${sign}`;

      c.textAlign = 'center';
      c.fillText(label, sx, topLeft.y - 3);
      c.fillText(label, sx, bottomLeft.y + fontSize + 2);
    }
  }

  // ── Axis labels ───────────────────────────────────────────────────────────
  c.font = `italic bold 10px "Courier New", monospace`;
  c.textAlign = 'center';
  c.fillStyle = FG;

  const midY = topLeft.y + chartH / 2;
  const midX = topLeft.x + chartW / 2;

  c.save();
  c.translate(topLeft.x / 2, midY);
  c.rotate(-Math.PI / 2);
  c.fillText('LATITUDE', 0, 0);
  c.restore();

  c.save();
  c.translate(topRight.x + (screenW - topRight.x) / 2, midY);
  c.rotate(Math.PI / 2);
  c.fillText('LATITUDE', 0, 0);
  c.restore();

  c.fillText('LONGITUDE', midX, topLeft.y / 2);
  c.fillText('LONGITUDE', midX, bottomLeft.y + (screenH - bottomLeft.y) / 2);

  c.restore();
}

/** Scale bar drawn at fixed screen position — always visible regardless of pan/zoom. */
function drawScaleBar(c: CanvasRenderingContext2D, _screenW: number, screenH: number): void {
  // 1 NM = 1 arc-minute of latitude = SVG_H / ((maxLat-minLat)*60) SVG px
  const nmInSVGpx = SVG_H / ((CHART_BOUNDS.maxLat - CHART_BOUNDS.minLat) * 60);
  const nmInScreenPx = nmInSVGpx * transform.scale;

  // Bar is always exactly this wide with exactly 5 segments — only labels change with zoom.
  const NUM_SEGMENTS = 5;
  const barW = 450;
  const segW = barW / NUM_SEGMENTS;

  // Zoom snaps to exact levels so totalNM/NUM_SEGMENTS is always a whole number.
  const totalNM = barW / nmInScreenPx;
  const nmStep = Math.round(totalNM / NUM_SEGMENTS);

  const bx = 20;
  const by = screenH - 36;

  c.save();

  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillRect(bx - 6, by - 18, barW + 12, 46);
  c.strokeStyle = '#1a3a5c';
  c.lineWidth = 0.8;
  c.strokeRect(bx - 6, by - 18, barW + 12, 46);

  for (let i = 0; i < NUM_SEGMENTS; i++) {
    c.fillStyle = i % 2 === 0 ? '#1a3a5c' : '#ffffff';
    c.fillRect(bx + i * segW, by - 8, segW, 8);
  }
  c.strokeStyle = '#1a3a5c';
  c.lineWidth = 1;
  c.strokeRect(bx, by - 8, barW, 8);

  c.fillStyle = '#1a3a5c';
  c.font = '10px "Courier New", monospace';
  c.textAlign = 'center';
  for (let i = 0; i <= NUM_SEGMENTS; i++) {
    const tx = bx + i * segW;
    const val = nmStep * i;
    const label = val === 0 ? '0' : val < 1 ? val.toFixed(2) : String(Math.round(val * 100) / 100);
    c.beginPath();
    c.moveTo(tx, by - 10);
    c.lineTo(tx, by);
    c.strokeStyle = '#1a3a5c';
    c.lineWidth = 1;
    c.stroke();
    c.fillText(label, tx, by + 12);
  }

  c.font = 'italic 10px "Courier New", monospace';
  c.fillText('Nautical Miles', bx + barW / 2, by + 22);

  c.restore();
}

export function getCtx(): CanvasRenderingContext2D | null {
  return ctx;
}

export function drawAllToolOverlays(c: CanvasRenderingContext2D): void {
  drawParallelRules(c);
}
