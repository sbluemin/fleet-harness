import type { Component, FleetPtySection } from "../controls/index.js";

import { createJobBarSections } from "../carrier-status/job-bar-section.js";
import type { JobBarState } from "../carrier-status/job-bar-state.js";
import { FleetStatusSection } from "./fleet-status-section.js";

export interface CreateDefaultFleetPtySectionsOptions {
  readonly jobBarState: JobBarState;
  readonly native?: boolean;
}

export function createDefaultFleetPtySections(
  options: CreateDefaultFleetPtySectionsOptions,
): FleetPtySection[] {
  return [
    { component: new FleetStatusSection({ native: options.native ?? false }), id: "fleet-status-section" },
    ...createJobBarSections(options.jobBarState),
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
