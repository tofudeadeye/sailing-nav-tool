import { svgToScreen, screenToSVG } from '../coords.ts';
import { state } from './types.ts';

const PCP_W   = 560;
const PCP_H   = 260;
const PCP_ROSE_R = 100;
const PCP_EDGE_EXT = 60;
const PCP_GRID_SPACING = 16;

function bearingLabel(bearing: number, variation: number): string {
  const t = Math.round(((bearing % 360) + 360) % 360);
  const m = Math.round((((bearing + variation) % 360) + 360) % 360);
  return `${String(t).padStart(3, '0')}°T (${String(m).padStart(3, '0')}°M)`;
}

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

export function drawPlotterOverlay(c: CanvasRenderingContext2D): void {
  const p = state.plotter;
  if (!p) return;
  const centre = svgToScreen(p.svgX, p.svgY);

  c.save();
  c.translate(centre.x, centre.y);
  c.rotate((p.angleDeg * Math.PI) / 180);

  const hw = PCP_W / 2, hh = PCP_H / 2;

  // Extended course-edge lines
  c.save();
  c.strokeStyle = 'rgba(180,0,0,0.6)';
  c.lineWidth = 1;
  c.setLineDash([6, 4]);
  c.beginPath();
  c.moveTo(-(hw + PCP_EDGE_EXT), -hh); c.lineTo(-hw, -hh);
  c.moveTo( hw, -hh);                  c.lineTo( hw + PCP_EDGE_EXT, -hh);
  c.moveTo(-(hw + PCP_EDGE_EXT), hh);  c.lineTo(-hw, hh);
  c.moveTo( hw, hh);                   c.lineTo( hw + PCP_EDGE_EXT, hh);
  c.stroke();
  c.setLineDash([]);
  c.restore();

  // Body
  c.save();
  c.fillStyle = 'rgba(210,235,255,0.38)';
  c.strokeStyle = '#1a4080';
  c.lineWidth = 1.5;
  c.fillRect(-hw, -hh, PCP_W, PCP_H);
  c.restore();

  // Meridian alignment grid
  c.save();
  c.strokeStyle = 'rgba(0,80,160,0.35)';
  c.lineWidth = 0.8;
  for (let y = -hh + PCP_GRID_SPACING; y < hh; y += PCP_GRID_SPACING) {
    c.beginPath();
    c.moveTo(-hw, y); c.lineTo(hw, y);
    c.stroke();
  }
  c.strokeStyle = 'rgba(0,80,160,0.65)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(0, -hh); c.lineTo(0, hh);
  c.stroke();
  c.restore();

  // Body border
  c.save();
  c.strokeStyle = '#1a4080';
  c.lineWidth = 1.5;
  c.strokeRect(-hw, -hh, PCP_W, PCP_H);
  c.strokeStyle = '#cc0000';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(-hw, -hh); c.lineTo(hw, -hh);
  c.moveTo(-hw,  hh); c.lineTo(hw,  hh);
  c.stroke();
  c.restore();

  // Compass rose
  drawPCPRose(c, 0, 0, PCP_ROSE_R, p.roseAngleDeg - p.angleDeg);

  // Direction arrow
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
  c.beginPath();
  c.moveTo(arrowX, arrowY);
  c.lineTo(arrowX - arrowHead, arrowY - arrowHead * 0.55);
  c.lineTo(arrowX - arrowHead, arrowY + arrowHead * 0.55);
  c.closePath();
  c.fill();
  c.restore();

  // Edge degree scale
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
    c.beginPath();
    c.moveTo(ex, -hh); c.lineTo(ex, -hh + tickH);
    c.stroke();
    c.beginPath();
    c.moveTo(ex, hh); c.lineTo(ex, hh - tickH);
    c.stroke();
    if (deg % 30 === 0 && deg > 0 && deg < 180) {
      c.fillText(String(deg), ex, -hh + tickH + 8);
    }
  }
  c.restore();

  // Label
  c.save();
  c.fillStyle = 'rgba(10,40,90,0.55)';
  c.font      = 'bold 7px sans-serif';
  c.textAlign = 'center';
  c.fillText('PORTLAND COURSE PLOTTER', hw * 0.55, hh - 7);
  c.restore();

  c.restore(); // end rotated transform

  // Bearing readout label
  const bearing   = ((p.angleDeg - p.roseAngleDeg) + 90 + 360) % 360;
  const variation = state.chartData?.variation ?? 0;
  const label     = `Plotter: ${bearingLabel(bearing, variation)}`;

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

  // Rotation handle
  const rad   = (p.angleDeg * Math.PI) / 180;
  const rotHX = centre.x + Math.cos(rad) * hw;
  const rotHY = centre.y + Math.sin(rad) * hw;
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

function drawPCPRose(
  c: CanvasRenderingContext2D,
  cx: number, cy: number,
  r: number,
  roseOffset: number,
): void {
  c.save();
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.clip();

  c.fillStyle   = 'rgba(255,255,255,0.72)';
  c.fill();

  c.translate(cx, cy);
  c.rotate((roseOffset * Math.PI) / 180);

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

  c.strokeStyle = 'rgba(180,0,0,0.55)';
  c.lineWidth   = 1;
  c.setLineDash([3, 2]);
  c.beginPath();
  c.moveTo(0, -(r - 2)); c.lineTo(0, r - 2);
  c.stroke();
  c.setLineDash([]);

  c.restore();

  // Fixed index mark
  c.save();
  c.fillStyle = '#cc0000';
  c.beginPath();
  c.moveTo(cx, cy - r + 2);
  c.lineTo(cx - 5, cy - r - 7);
  c.lineTo(cx + 5, cy - r - 7);
  c.closePath();
  c.fill();
  c.restore();

  // Disc border
  c.save();
  c.strokeStyle = '#1a3a5c';
  c.lineWidth   = 1.2;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.stroke();

  c.strokeStyle = 'rgba(0,85,204,0.4)';
  c.lineWidth   = 3;
  c.beginPath();
  c.arc(cx, cy, r - 1, 0, Math.PI * 2);
  c.stroke();

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

  const rotHX = centre.x + Math.cos(rad) * hw;
  const rotHY = centre.y + Math.sin(rad) * hw;
  if (Math.hypot(sx - rotHX, sy - rotHY) < 14) {
    p.dragging    = 'rotate';
    p.dragStartSX = sx; p.dragStartSY = sy;
    return true;
  }

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
    p.angleDeg = (Math.atan2(sy - centre.y, sx - centre.x) * 180) / Math.PI;
  } else if (p.dragging === 'rose') {
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

export type PlotterHitZone = 'rose' | 'body' | 'rotate-handle' | null;

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

  if (Math.hypot(lx, ly) < PCP_ROSE_R) return 'rose';

  const rotHX = centre.x + Math.cos(rad) * hw;
  const rotHY = centre.y + Math.sin(rad) * hw;
  if (Math.hypot(sx - rotHX, sy - rotHY) < 14) return 'rotate-handle';

  if (Math.abs(lx) < PCP_W / 2 && Math.abs(ly) < PCP_H / 2) return 'body';

  return null;
}

export function hitTestPlotter(sx: number, sy: number): boolean {
  return hitTestPlotterZone(sx, sy) !== null;
}
