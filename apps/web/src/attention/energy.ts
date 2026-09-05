export function advanceEnergy(
  energy: number,
  seconds: number,
  working: boolean,
  seeing: boolean,
  resting: boolean,
) {
  const elapsed = Math.min(60, Math.max(0, seconds));
  const rate = resting ? 0 : working ? 0.035 : seeing ? 0.018 : -0.006;
  return Math.max(0, Math.min(1, energy + elapsed * rate));
}
export function distractionFor(energy: number): 'fly' | 'butterfly' | 'mote' | null {
  return energy < 0.18 ? 'fly' : energy < 0.35 ? 'butterfly' : energy < 0.5 ? 'mote' : null;
}
