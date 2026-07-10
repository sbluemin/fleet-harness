# Font Picker package contract

`@fleet-console/font-picker` is a source-only, surface-neutral browser for built-in and system font choices.

- Keep it controlled: consumers own selections, ranges, preview copy, filtering, and persistence.
- Consume the versioned Core system-font route directly through `fetchSystemFonts`; never use plugin-scoped APIs.
- Do not import Console core or Terminal modules.
- Keep styles under the `.fc-font-browser*` namespace and use theme tokens rather than hard-coded colors.
