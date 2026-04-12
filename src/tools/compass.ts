import { trueBearing, bearing } from '../coords.ts';
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
  variationDir: 'E' | 'W' = 'W',
): BearingResult {
  const tb = trueBearing(vesselLat, vesselLon, landmark.lat, landmark.lon);
  const error = gaussianRandom() * 2;
  const signedVar = variationDir === 'W' ? variation : -variation;
  return { trueBear: bearing(tb), magBearing: bearing(tb + signedVar + error), error, landmark };
}
