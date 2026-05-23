---
id: "prd-tui-keyboard-protocol-architecture-source"
created: "2026-05-23T14:33:13.966Z"
sourceType: "inline"
title: "prd-tui-keyboard-protocol-architecture-source"
tags: ["fleet-tui", "fleet-agent", "keyboard-protocol", "keybinding", "dependency-injection", "architecture", "shipped"]
contentHash: "d31b5299"
---
Fleet TUI keyboard protocol and keybinding registry architecture decision history. Enshrines: TUI direct ownership of outer-terminal keyboard protocol; dual-protocol enable (modifyOtherKeys + kitty push); selective CSI-u normalization; keybinding registry placement in TUI input layer; domain keybinding definitions in Composition Root; auto-derived normalization map from registered keybindings. Rejects: child-process proxy, kitty-only, broad normalization, fleet-infra registry/definitions, hardcoded dual map.