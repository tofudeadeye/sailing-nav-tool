import { transform, svgToScreen, screenToSVG, SVG_W, SVG_H } from '../coords.ts';
import { state } from './types.ts';

function bearingLabel(bearing: number, variation: number, variationDir: 'E' | 'W'): string {
  const t = Math.round(((bearing % 360) + 360) % 360);
  const signedVar = variationDir === 'W' ? variation : -variation;
  const m = Math.round((((bearing + signedVar) % 360) + 360) % 360);
  return `${String(t).padStart(3, '0')}°T (${String(m).padStart(3, '0')}°M)`;
}

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
  const variation    = state.chartData?.variation ?? 0;
  const variationDir = state.chartData?.variationDir ?? 'W';

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

  const pivotRule = pr.pivot === 'rule1' ? pr.rule1 : pr.pivot === 'rule2' ? pr.rule2 : null;
  if (pivotRule) {
    const pc = svgToScreen(pivotRule.svgX, pivotRule.svgY);
    c.fillStyle = '#ff6633';
    c.beginPath();
    c.arc(pc.x, pc.y, 6, 0, Math.PI * 2);
    c.fill();
  }

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
      pr.onBearingUpdate?.(bearing, variationDir === 'W' ? variation : -variation);
    }
  }

  const bearing = (pr.angleDeg + 90 + 360) % 360;
  const label = bearingLabel(bearing, variation, variationDir);
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

  pr.angleDeg =
    (Math.atan2(pr.rule2.svgY - pr.rule1.svgY, pr.rule2.svgX - pr.rule1.svgX) * 180) /
      Math.PI -
    90;
  return true;
}

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

export function handleRulesPointerUp(): void {
  const pr = state.parallelRules;
  if (!pr) return;
  if (pr.dragging) pr.pivot = pr.dragging;
  pr.dragging = null;
}
