import type { FleetPtyRegion } from "./types.js";
import { isFocusable } from "./component.js";

export interface RegionStack {
  readonly current: () => FleetPtyRegion;
  readonly isDefault: () => boolean;
  readonly pop: () => FleetPtyRegion;
  readonly push: (region: FleetPtyRegion) => FleetPtyRegion;
  readonly replace: (region: FleetPtyRegion) => FleetPtyRegion;
}

export function createRegionStack(defaultRegion: FleetPtyRegion): RegionStack {
  const stack: FleetPtyRegion[] = [defaultRegion];

  return {
    current: () => stack[stack.length - 1] ?? defaultRegion,
    isDefault: () => stack.length <= 1,
    pop: () => {
      if (stack.length > 1) {
        const popped = stack.pop();
        setFocused(popped, false);
      }
      const current = stack[stack.length - 1] ?? defaultRegion;
      setFocused(current, true);
      return current;
    },
    push: (region) => {
      setFocused(stack[stack.length - 1], false);
      stack.push(region);
      setFocused(region, true);
      return region;
    },
    replace: (region) => {
      const replaced = stack.splice(stack.length - 1, 1, region)[0];
      setFocused(replaced, false);
      setFocused(region, true);
      return region;
    },
  };
}

function setFocused(region: FleetPtyRegion | undefined, focused: boolean): void {
  if (region && isFocusable(region.component)) {
    region.component.focused = focused;
  }
}
