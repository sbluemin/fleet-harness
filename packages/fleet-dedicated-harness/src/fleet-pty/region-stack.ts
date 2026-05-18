import type { FleetPtyRegion } from "./types.js";

export interface RegionStack {
  readonly current: () => FleetPtyRegion;
  readonly pop: () => FleetPtyRegion;
  readonly push: (region: FleetPtyRegion) => FleetPtyRegion;
  readonly replace: (region: FleetPtyRegion) => FleetPtyRegion;
}

export function createRegionStack(defaultRegion: FleetPtyRegion): RegionStack {
  const stack: FleetPtyRegion[] = [defaultRegion];

  return {
    current: () => stack[stack.length - 1] ?? defaultRegion,
    pop: () => {
      if (stack.length > 1) {
        stack.pop();
      }
      return stack[stack.length - 1] ?? defaultRegion;
    },
    push: (region) => {
      stack.push(region);
      return region;
    },
    replace: (region) => {
      stack.splice(stack.length - 1, 1, region);
      return region;
    },
  };
}

