export interface OrbitState {
  yaw: number;
  pitch: number;
  lastInput: number;
  dragging: boolean;
  returnFrom?: { yaw: number; pitch: number };
}
/** The orbit retains the inspected angle for four seconds, then eases home. */
export function returnOrbit(
  state: OrbitState,
  now: number,
  _dt: number,
  reducedMotion: boolean,
): OrbitState {
  if (state.dragging || now - state.lastInput < 4000) return state;
  const from = state.returnFrom ?? { yaw: state.yaw, pitch: state.pitch };
  // Wall-clock interpolation must not use the gaze physics timestep: that
  // timestep is capped and would make software-rendered views return slowly.
  const progress = reducedMotion ? 1 : Math.min(1, (now - state.lastInput - 4000) / 2000);
  const remaining = 1 - progress * progress * (3 - 2 * progress);
  return { ...state, returnFrom: from, yaw: from.yaw * remaining, pitch: from.pitch * remaining };
}
export function dragOrbit(state: OrbitState, dx: number, dy: number, now: number): OrbitState {
  const yaw = state.yaw - dx * 0.007;
  return {
    yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
    pitch: Math.max(-1.05, Math.min(1.05, state.pitch + dy * 0.006)),
    lastInput: now,
    dragging: true,
  };
}
