import { transform, svgToScreen, screenToSVG, svgToLatLon, distanceNM, SVG_W, SVG_H, CHART_BOUNDS } from '../coords.ts';
import { state, wb } from './types.ts';

const HANDLE_R = 10;

// Snap threshold in screen pixels
const SNAP_PX = 8;

/**
 * Snap SVG coords to the nearest 1-arc-minute lat or lon grid line
 * if within SNAP_PX screen pixels of one.
 */
function snapToGrid(svgX: number, svgY: number): { x: number; y: number } {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  const s = transform.scale;

  // Snap Y to nearest 1' latitude line (60 SVG px spacing)
  const pxPerLatMin = SVG_H / ((maxLat - minLat) * 60);
  const nearestLatMin = Math.round(svgY / pxPerLatMin);
  const snappedY = nearestLatMin * pxPerLatMin;
  if (Math.abs(snappedY - svgY) * s < SNAP_PX) {
    svgY = snappedY;
  }

  // Snap X to nearest 1' longitude line
  const pxPerLonMin = SVG_W / ((maxLon - minLon) * 60);
  const nearestLonMin = Math.round(svgX / pxPerLonMin);
  const snappedX = nearestLonMin * pxPerLonMin;
  if (Math.abs(snappedX - svgX) * s < SNAP_PX) {
    svgX = snappedX;
  }

  return { x: svgX, y: svgY };
}

export function spawnDividers(svgX: number, svgY: number): void {
  const spread = SVG_W * 0.06;
  state.dividers = {
    svgHingeX: svgX, svgHingeY: svgY,
    svgTip1X: svgX - spread, svgTip1Y: svgY + spread * 1.2,
    svgTip2X: svgX + spread, svgTip2Y: svgY + spread * 1.2,
    dragging: null,
    dragStartAngle: 0,
    rotatePivotSVGX: 0,
    rotatePivotSVGY: 0,
  };
}

export function drawDividers(c: CanvasRenderingContext2D): void {
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

  // Highlight active pivot point during rotation
  if (d.dragging === 'rotate') {
    const pivot = svgToScreen(d.rotatePivotSVGX, d.rotatePivotSVGY);
    c.save();
    c.strokeStyle = '#ff9900';
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(pivot.x, pivot.y, 9, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  // Rotate handle: arc drawn around hinge — visible cue that Shift+drag rotates
  c.save();
  c.strokeStyle = 'rgba(74,144,217,0.45)';
  c.lineWidth = 1.5;
  c.setLineDash([4, 3]);
  const rotR = Math.hypot(t1.x - h.x, t1.y - h.y) * 0.45;
  c.beginPath();
  c.arc(h.x, h.y, rotR, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.restore();

  const { lat: lat1, lon: lon1 } = svgToLatLon(d.svgTip1X, d.svgTip1Y);
  const { lat: lat2, lon: lon2 } = svgToLatLon(d.svgTip2X, d.svgTip2Y);
  console.log('[div] tip1 svg:', d.svgTip1X.toFixed(1), d.svgTip1Y.toFixed(1), 'll:', lat1.toFixed(5), lon1.toFixed(5));
  console.log('[div] tip2 svg:', d.svgTip2X.toFixed(1), d.svgTip2Y.toFixed(1), 'll:', lat2.toFixed(5), lon2.toFixed(5));
  const nm = distanceNM(lat1, lon1, lat2, lon2);
  console.log('[div] nm:', nm.toFixed(4), 'svg delta x:', (d.svgTip2X-d.svgTip1X).toFixed(1), 'y:', (d.svgTip2Y-d.svgTip1Y).toFixed(1));
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

  // Shift+click — rotate around whichever point was clicked
  if (e.shiftKey) {
    let pivotSVGX: number, pivotSVGY: number;
    if (Math.hypot(sx - t1.x, sy - t1.y) < HANDLE_R) {
      // Pivot around tip1 — keep tip1 fixed, rotate hinge and tip2
      pivotSVGX = d.svgTip1X; pivotSVGY = d.svgTip1Y;
    } else if (Math.hypot(sx - t2.x, sy - t2.y) < HANDLE_R) {
      // Pivot around tip2 — keep tip2 fixed, rotate hinge and tip1
      pivotSVGX = d.svgTip2X; pivotSVGY = d.svgTip2Y;
    } else if (Math.hypot(sx - h.x, sy - h.y) < HANDLE_R * 1.5) {
      // Pivot around hinge
      pivotSVGX = d.svgHingeX; pivotSVGY = d.svgHingeY;
    } else {
      return false;
    }
    const pivotScreen = svgToScreen(pivotSVGX, pivotSVGY);
    d.dragging = 'rotate';
    d.dragStartAngle  = Math.atan2(sy - pivotScreen.y, sx - pivotScreen.x);
    d.rotatePivotSVGX = pivotSVGX;
    d.rotatePivotSVGY = pivotSVGY;
    return true;
  }

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
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

  if (d.dragging === 'rotate') {
    const pivotScreen = svgToScreen(d.rotatePivotSVGX, d.rotatePivotSVGY);
    const currentAngle = Math.atan2(sy - pivotScreen.y, sx - pivotScreen.x);
    const delta = currentAngle - d.dragStartAngle;
    // Update dragStartAngle for incremental rotation
    d.dragStartAngle = currentAngle;

    // Rotate all three points around the SVG pivot, skipping the pivot itself
    const rotateAroundPivot = (px: number, py: number): [number, number] => {
      const dx = px - d.rotatePivotSVGX, dy = py - d.rotatePivotSVGY;
      const cos = Math.cos(delta), sin = Math.sin(delta);
      return [
        d.rotatePivotSVGX + dx * cos - dy * sin,
        d.rotatePivotSVGY + dx * sin + dy * cos,
      ];
    };

    if (d.svgHingeX !== d.rotatePivotSVGX || d.svgHingeY !== d.rotatePivotSVGY) {
      [d.svgHingeX, d.svgHingeY] = rotateAroundPivot(d.svgHingeX, d.svgHingeY);
    }
    if (d.svgTip1X !== d.rotatePivotSVGX || d.svgTip1Y !== d.rotatePivotSVGY) {
      [d.svgTip1X, d.svgTip1Y] = rotateAroundPivot(d.svgTip1X, d.svgTip1Y);
    }
    if (d.svgTip2X !== d.rotatePivotSVGX || d.svgTip2Y !== d.rotatePivotSVGY) {
      [d.svgTip2X, d.svgTip2Y] = rotateAroundPivot(d.svgTip2X, d.svgTip2Y);
    }
    return true;
  }

  const svgPos = screenToSVG(sx, sy);

  if (d.dragging === 'hinge') {
    const dx = svgPos.x - d.svgHingeX, dy = svgPos.y - d.svgHingeY;
    d.svgHingeX = svgPos.x; d.svgHingeY = svgPos.y;
    d.svgTip1X += dx; d.svgTip1Y += dy;
    d.svgTip2X += dx; d.svgTip2Y += dy;
  } else if (d.dragging === 'tip1') {
    const snapped = snapToGrid(svgPos.x, svgPos.y);
    d.svgTip1X = snapped.x; d.svgTip1Y = snapped.y;
  } else if (d.dragging === 'tip2') {
    const snapped = snapToGrid(svgPos.x, svgPos.y);
    d.svgTip2X = snapped.x; d.svgTip2Y = snapped.y;
  }
  return true;
}

export function handleDividersPointerUp(): void {
  if (state.dividers) state.dividers.dragging = null;
}

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

export function accumulateDistance(): void {
  const d = state.dividers;
  if (!d) return;
  const { lat: lat1, lon: lon1 } = svgToLatLon(d.svgTip1X, d.svgTip1Y);
  const { lat: lat2, lon: lon2 } = svgToLatLon(d.svgTip2X, d.svgTip2Y);
  state.accumulatedDist += distanceNM(lat1, lon1, lat2, lon2);
  wb.setAccDist?.(state.accumulatedDist);
}
