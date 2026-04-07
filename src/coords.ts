// Coordinate system: equirectangular (Mercator-like) projection.
//
// Two coordinate spaces:
//   SVG space  — logical pixels in the SVG viewport (SVG_W × SVG_H units)
//   Screen space — physical pixels on the canvas element, after pan/zoom
//
// Lat/lon ↔ SVG is a fixed linear mapping.
// SVG ↔ Screen uses the mutable `transform` object.

export const SVG_W = 2400;
export const SVG_H = 1800;

export interface ChartBounds {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

export const CHART_BOUNDS: ChartBounds = {
  minLat: 52.0,
  maxLat: 52.5,
  minLon: -4.6667,  // 004°40′W
  maxLon: -4.0,     // 004°00′W
};

export interface SVGPoint { x: number; y: number; }
export interface ScreenPoint { x: number; y: number; }
export interface LatLon { lat: number; lon: number; }

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

// Mutable pan/zoom state — mutated directly by the pan/zoom handlers.
export const transform: Transform = { scale: 1, offsetX: 0, offsetY: 0 };

// ── Lat/lon ↔ SVG ────────────────────────────────────────────────────────────

export function latLonToSVG(lat: number, lon: number): SVGPoint {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  return {
    x: ((lon - minLon) / (maxLon - minLon)) * SVG_W,
    y: ((maxLat - lat) / (maxLat - minLat)) * SVG_H, // lat increases upward
  };
}

export function svgToLatLon(x: number, y: number): LatLon {
  const { minLat, maxLat, minLon, maxLon } = CHART_BOUNDS;
  return {
    lon: minLon + (x / SVG_W) * (maxLon - minLon),
    lat: maxLat - (y / SVG_H) * (maxLat - minLat),
  };
}

// ── SVG ↔ Screen ─────────────────────────────────────────────────────────────

export function svgToScreen(svgX: number, svgY: number): ScreenPoint {
  return {
    x: svgX * transform.scale + transform.offsetX,
    y: svgY * transform.scale + transform.offsetY,
  };
}

export function screenToSVG(screenX: number, screenY: number): SVGPoint {
  return {
    x: (screenX - transform.offsetX) / transform.scale,
    y: (screenY - transform.offsetY) / transform.scale,
  };
}

// ── Convenience composites ────────────────────────────────────────────────────

export function screenToLatLon(screenX: number, screenY: number): LatLon {
  const svg = screenToSVG(screenX, screenY);
  return svgToLatLon(svg.x, svg.y);
}

export function latLonToScreen(lat: number, lon: number): ScreenPoint {
  const svg = latLonToSVG(lat, lon);
  return svgToScreen(svg.x, svg.y);
}

// ── Geodetic calculations ─────────────────────────────────────────────────────

/** Haversine distance in nautical miles. */
export function distanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3440.065; // NM
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial true bearing from point 1 to point 2, degrees 0–360. */
export function trueBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Destination point given start, true bearing (°), distance (NM). */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distNM: number): LatLon {
  const R = 3440.065;
  const δ = distNM / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return {
    lat: (φ2 * 180) / Math.PI,
    lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/** Format lat/lon as degrees and decimal minutes string. */
export function formatLatLon(lat: number, lon: number): string {
  const latD = Math.floor(Math.abs(lat));
  const latM = ((Math.abs(lat) - latD) * 60).toFixed(1);
  const lonD = Math.floor(Math.abs(lon));
  const lonM = ((Math.abs(lon) - lonD) * 60).toFixed(1);
  const latH = lat >= 0 ? 'N' : 'S';
  const lonH = lon >= 0 ? 'E' : 'W';
  return `${latD}°${latM}'${latH} ${lonD.toString().padStart(3, '0')}°${lonM}'${lonH}`;
}
