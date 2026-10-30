import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MAX_SIDEBAR_SECTIONS, sanitizeCommodoreSidebarLayout, type CommodoreSidebarCommand, type CommodoreSidebarLayout } from "../shared/contracts/sidebar-layout.js";
import { CommodoreStoreError } from "./errors.js";

export interface CommodoreSidebarPersistence {
  read(): CommodoreSidebarLayout | undefined;
  write(layout: CommodoreSidebarLayout, order?: readonly string[]): void;
}

export function createCommodoreSidebar(deps: {
  persistence?: CommodoreSidebarPersistence;
  ids: () => readonly string[];
  order: () => readonly string[];
  assertWritable: (id: string) => void;
  changed: () => void;
}) {
  const read = () => sanitizeCommodoreSidebarLayout(deps.persistence?.read(), new Set(deps.ids()));
  return {
    read,
    update(command: CommodoreSidebarCommand): { createdSectionId?: string } {
      if (!deps.persistence) throw new CommodoreStoreError("commodore_unavailable");
      const before = read();
      let sections = [...before.sections];
      const membership = { ...before.membership };
      let unsectionedCollapsed = before.unsectionedCollapsed;
      let order: string[] | undefined;
      let createdSectionId: string | undefined;
      const requireSection = (id: string) => {
        const index = sections.findIndex((section) => section.id === id);
        if (index === -1) throw new CommodoreStoreError("invalid_request");
        return index;
      };
      if (command.op === "create") {
        if (sections.length >= MAX_SIDEBAR_SECTIONS) throw new CommodoreStoreError("invalid_request");
        const index = command.afterId ? requireSection(command.afterId) + 1 : 0;
        if (command.commodoreId) deps.assertWritable(command.commodoreId);
        createdSectionId = randomUUID();
        sections.splice(index, 0, { id: createdSectionId, name: command.name, collapsed: false });
        if (command.commodoreId) membership[command.commodoreId] = createdSectionId;
      } else if (command.op === "collapse" && command.sectionId === null) {
        unsectionedCollapsed = command.collapsed;
      } else if (command.op === "move") {
        deps.assertWritable(command.commodoreId);
        if (command.sectionId !== null) requireSection(command.sectionId);
        if (command.targetId) {
          deps.assertWritable(command.targetId);
          if ((membership[command.targetId] ?? null) !== command.sectionId) throw new CommodoreStoreError("invalid_request");
        }
        if (command.sectionId === null) delete membership[command.commodoreId];
        else membership[command.commodoreId] = command.sectionId;
        if (command.targetId !== command.commodoreId) {
          order = deps.order().filter((id) => id !== command.commodoreId);
          const last = order.filter((id) => (membership[id] ?? null) === command.sectionId).at(-1);
          const anchor = command.targetId ?? last;
          const index = anchor ? order.indexOf(anchor) + (command.targetId ? Number(command.after === true) : 1) : order.length;
          order.splice(index, 0, command.commodoreId);
        }
      } else {
        const index = requireSection(command.sectionId!);
        if (command.op === "rename") sections[index] = { ...sections[index]!, name: command.name };
        else if (command.op === "collapse") sections[index] = { ...sections[index]!, collapsed: command.collapsed };
        else if (command.op === "reorder") {
          const next = index + (command.direction === "up" ? -1 : 1);
          if (next >= 0 && next < sections.length) [sections[index], sections[next]] = [sections[next]!, sections[index]!];
        } else if (command.op === "delete") {
          sections = sections.filter((section) => section.id !== command.sectionId);
          for (const [id, sectionId] of Object.entries(membership)) if (sectionId === command.sectionId) delete membership[id];
        }
      }
      const next = { sections, membership, unsectionedCollapsed };
      if (!isDeepStrictEqual(next, before) || order && !isDeepStrictEqual(order, deps.order())) {
        deps.persistence.write(next, order);
        deps.changed();
      }
      return createdSectionId ? { createdSectionId } : {};
    },
  };
}
