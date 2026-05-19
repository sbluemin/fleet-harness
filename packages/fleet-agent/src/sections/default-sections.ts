import type { FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import type { Component, FleetPtySection } from "@sbluemin/fleet-tui/pty";

import { createJobBarSections } from "../carrier-status/job-bar-section.js";
import { FleetStatusSection } from "./fleet-status-section.js";

export interface CreateDefaultFleetPtySectionsOptions {
  readonly native?: boolean;
}

export function createDefaultFleetPtySections(
  rt: FleetCoreRuntimeContext,
  options: CreateDefaultFleetPtySectionsOptions = {},
): FleetPtySection[] {
  return [
    { component: new FleetStatusSection({ rt, native: options.native ?? false }), id: "fleet-status-section" },
    ...createJobBarSections(rt),
  ];
}

export function createDefaultFleetPtyComponent(sections: readonly FleetPtySection[]): Component {
  return {
    desiredHeight(maxRows: number): number {
      return Math.min(maxRows, sections.reduce((sum, section) => sum + (section.component.desiredHeight?.(maxRows) ?? 1), 0));
    },
    invalidate(): void {
      for (const section of sections) {
        section.component.invalidate();
      }
    },
    render(width: number): string[] {
      return sections.flatMap((section) => section.component.render(width));
    },
  };
}
