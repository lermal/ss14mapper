# SS14 Mapper interface

## Purpose

Build and edit Space Station 14 maps. Keep the map, palette and inspector available together on desktop. Preserve tools, keyboard shortcuts, sprite sizes and the canvas coordinate system.

## Direction

VARIANCE: 3 | MOTION: 1 | DENSITY: 8

Use the proportions of a mapping workbench: a compact command strip, aligned asset lists and a large uninterrupted canvas. The start screen is a file workspace with build selection and recent maps. The guide uses the same typography and controls with room for reading.

Signature: **the map is the colour-bearing surface; the surrounding workbench stays neutral.** Game sprites, selection overlays and network colours carry information. Use a restrained blue accent for interactive state. Keep this separation on the start screen, in the palette and around the canvas.

```
Start                            Editor
Brand                  Language  Menus | Map name | Build | Save
Title / instructions             Tool options
Build / file actions | Recent    Tools | Palette | Map | Properties
Guide / shortcuts    | Maps       Coordinates / status
```

## Palette

- Graphite `#191c20`: page and workbench background.
- Panel `#202429`: grouped controls and panels.
- Raised `#292e34`: hover and floating surfaces.
- Line `#353b43`: boundaries between functional areas.
- Paper `#edf0f3`: primary text.
- Steel blue `#4b7299`: primary actions; use `#a5c5e5` for links and selection text.

Keep secondary text readable (`#aab2bc`). Retain the existing semantic colours for warnings, errors and map overlays. They identify different data, not decorative accents. Native form controls use the dark colour scheme.

## Type and spacing

Use Segoe UI with system sans fallbacks, including Cyrillic. This is a desktop tool; keep the user's platform font instead of fetching a display font. Body copy on the start page and guide is 16px. Desktop editor labels stay at 12–13px to preserve canvas space. Use tabular figures for counts and the existing monospace stack for coordinates and IDs.

Use a 4px spacing scale. Headings use sentence case without tracking. Default corner radius is 4px; dialogs use 8px. Recent files are rows with dividers, not separate cards. Avoid the decorative clipped author badge.

## Components and states

Editor refinement: use a flat desktop workbench. Menus and document commands share a 36px strip; tool options occupy a separate 36px strip. Idle commands have no filled boxes. A tinted background and a narrow blue edge identify selected tools, filters and palette entries. The palette keeps 40px rows and 32px sprites; names lead, IDs are secondary, favourite controls appear on hover or keyboard focus. Coordinates and selection dimensions use monospace in fixed status fields. Palette, properties, tools and options can be hidden independently and restored through View / Panels; preferences survive reload without changing the document. Keep a visible edge tab for collapsed side panels.

- File actions have 44px targets; opening an existing map is the primary action.
- Empty recent files explain where saved maps will appear.
- The EN/RU homepages ship the file workspace and footer in static HTML. Hydrate controls in place; reserve space for loading messages and account controls so slow scripts and build requests do not move the page.
- Show errors beside the failed action and announce them to assistive technology.
- Keep loading text visible; use a small tile-shaped indicator with reduced-motion support.
- Selected tools have a visible edge and a tinted background. Keep keyboard focus visible.
- In tool options, separate independent settings into small groups. Shape remains a direct choice, fill is a checkbox, and symmetry is a labelled dropdown. The chosen material shows its actual kind (entity, tile or decal); truncate long names with the full name and ID available in a tooltip.
- Use labelled dropdowns for selection filters, pipe layers, sample sources and ruler snapping. Keep selection actions together at the end of the primary row. Decal appearance, transform and snapping belong in a second row, shown only while placing or editing decals. Preserve native inputs, mixed values and keyboard access; do not squeeze all decal fields into the tool row.
- Properties: put name, description and placement first, appearance second and other components last. Use collapsible sections with remembered state. Keep technical component names searchable, field types in tooltips, and YAML editing available. Give vectors and colours a full row. Put uncommon MetaData / Transform fields under Advanced; filtering reveals matching components without changing section preferences.
- Dialogs have readable labels, constrained height and scrollable content.
- Linking: label the source and sink with their device names, keep port choices flat, and place existing links and their removal actions in a separate section. Closing belongs in the header. Account dialogs use divided rows with separate action groups; feedback separates the message, attachments and report context. Object and background pickers follow the palette's row treatment, with sentence-case type labels, readable IDs and a visible selection edge.
- New map: separate file settings from the optional starting floor; give the floor tile a full row and pair width with height, labelled in tiles. Key settings: searchable, collapsible command groups; keep each binding beside its removal control, isolate conflict resolution in the affected row, and preserve focus and scroll while changing bindings.

## Responsive behaviour

Start page: collapse the file workspace and recent list below 760px. Guide: one readable column. Below 1000px the editor opens on the map, with a bottom navigation for Map, Tools, Palette, Properties and Options. Show one auxiliary panel at a time below the canvas in portrait, alongside it in short landscape viewports. These mobile choices never overwrite desktop panel preferences. Keep all commands reachable through a compact Menu, with undo, redo and save directly available. Keep colour in the map and sprites; use the existing neutral workbench chrome. Use 44px touch controls, 16px form text, safe-area insets and dynamic viewport height. One finger edits with the chosen tool, two fingers pan and pinch; a navigation toggle supports one-finger panning. Defer touch edits until movement or release so a second finger can start navigation without painting. A long press offers objects under the finger. Dialogs scroll within the available viewport; no document-level horizontal overflow.

## Guides and FAQ management

Use the editor's neutral palette and system font. Show language and type filters, publication status and up/down buttons in the content list. Put Markdown and preview in the main column, with address, category and description beside it. Stack the columns on phones.

Keep Save draft and Publish as separate actions. Preserve the author's text after a conflict and explain how to reload. Keep Back to list visible. For public guides, use a text column with linked titles; render FAQ answers as HTML. Let the user write the articles.

## Motion and constraints

No ambient motion, entrance cascades, glowing surfaces, gradient headlines or marketing cards. Use motion only for loading and direct feedback, and respect reduced motion. No new dependencies. Canvas layers, menus and dialogs retain their necessary positioning. Do not replace legitimate three-item lists or semantic map colours just to satisfy a pattern ban.

## Sources

Design guidance: antislop-web (jhuse25/anti-slop-design-skills, MIT) and the installed frontend-design skill. Keep the project's existing Bootstrap Icons (MIT). No external template, font or image assets added.
