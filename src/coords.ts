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

/**
 * A compass bearing (0–360°). toString() produces a display-ready string like
 * "306.8" (one decimal, zero-padded to 5 chars) so template literals like
 * `${b}°T` render correctly without .toFixed() at every call site.
 * valueOf() returns the numeric value so arithmetic works transparently.
 */
export class Bearing {
  readonly value: number;
  constructor(deg: number) {
    this.value = ((deg % 360) + 360) % 360;
  }
  toString(): string {
    return this.value.toFixed(1).padStart(5, '0');
  }
  valueOf(): number {
    return this.value;
  }
  asTrue(): string {
    return `${this.toString()}°T`;
  }
  asMag(): string {
    return `${this.toString()}°M`;
  }
}

/** Convenience factory — wraps a raw degree value in a Bearing. */
export function bearing(deg: number): Bearing {
  return new Bearing(deg);
}

export interface ChartBounds {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

// Longitude span is derived so that px/NM east == px/NM north, making SVG
// angles equal to true geodetic bearings (equidistant cylindrical projection).
//   lon_span = (SVG_W / SVG_H) × lat_span / cos(midLat)
//            = (2400/1800) × 1.5° / cos(52.25°) ≈ 3.264°
// centred on the original 004°20′W meridian (tripled from original 0.5° × 1.088°).
export const CHART_BOUNDS: ChartBounds = {
  minLat: 51.5,
  maxLat: 53.0,
  minLon: -5.965,  // 005°58′W
  maxLon: -2.701,  // 002°42′W
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

/**
 * Convert a true bearing (0°=North, 90°=East, clockwise) to SVG angle
 * SVG: 0° is East, 90° is South, clockwise in screen coordinates
 * True bearing: 0° is North, 90° is East, clockwise in geographical coordinates
 * 
 * Formula: SVG angle = 90° - true bearing
 */
export function bearingToSVGAngle(trueBearing: number): number {
  return (90 - trueBearing + 360) % 360;
}

/**
 * Verify that a line from (x1, y1) to (x2, y2) matches the expected true bearing
 */
export function verifyBearingLine(
  x1: number, y1: number, 
  x2: number, y2: number, 
  expectedTrueBearing: number
): { match: boolean; actualBearing: number; error: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  
  // SVG angle: atan2(dy, dx) where dy is downward-positive
  const svgAngle = Math.atan2(dy, dx) * (180 / Math.PI);
  
  // Convert SVG angle back to true bearing
  const actualBearing = (90 - svgAngle + 360) % 360;
  
  // Normalize difference
  let error = actualBearing - expectedTrueBearing;
  if (error > 180) error -= 360;
  if (error < -180) error += 360;
  error = Math.abs(error);
  
  return {
    match: error <= 2,
    actualBearing: (actualBearing + 360) % 360,
    error,
  };
}
