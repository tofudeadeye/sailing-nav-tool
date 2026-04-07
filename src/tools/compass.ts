import { trueBearing } from '../coords.ts';
import type { BearingResult } from './types.ts';

function gaussianRandom(): number {
  const u = Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

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
