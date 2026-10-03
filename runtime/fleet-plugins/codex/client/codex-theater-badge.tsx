import { TheaterBadge, theaterInitials } from "@fleet-console/sdk/components/theater-badge";
import type { ClientConsoleStateCapability } from "@fleet-console/sdk/plugin";

export function CodexTheaterBadge({ theaterId, consoleState }: { readonly theaterId: string | null; readonly consoleState: ClientConsoleStateCapability }) {
  const theater = consoleState.getTheaters().find(item => item.id === theaterId);
  return theater ? <TheaterBadge label={theater.label} initials={theaterInitials(theater.label)} /> : null;
}
