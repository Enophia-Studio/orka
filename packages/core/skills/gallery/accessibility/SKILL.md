---
name: accessibility
description: Making user interfaces usable with a keyboard, a screen reader, zoom and reduced motion (web, desktop and game UI). Use when building or reviewing UI, or when the user mentions accessibility, a11y, WCAG or screen readers.
license: MIT
---

# Accessibility

## Principles
- Everything a mouse user can do, a keyboard user can do: every control is reachable with Tab, works with Enter or Space (and the arrow keys inside composite widgets), and shows a visible focus ring.
- Every control tells assistive technology what it is, what it is called and what state it is in.
- Nothing depends on colour, sound or motion alone.

## Web
- Native elements first: `<button>` for actions, `<a href>` for navigation, `<label for>` for inputs, `<fieldset>`/`<legend>` for groups, headings in order. A `div` with a click handler is a bug.
- ARIA only fills gaps: `aria-label` on icon-only buttons, `aria-expanded`/`aria-controls` on disclosures, `role="dialog"` with `aria-modal` and a labelled title on dialogs, `aria-live="polite"` on status text that changes. Wrong ARIA is worse than none.
- Dialogs and menus: focus moves in when they open, stays inside while they are open, Escape closes them, and focus returns to the control that opened them.
- Images: meaningful ones get `alt` text that says what matters; decorative ones get `alt=""`.
- Forms: errors are text next to the field, linked with `aria-describedby` and announced; required fields are marked in text, not only with colour or an asterisk.
- Contrast: 4.5:1 for normal text, 3:1 for large text and for the borders and icons that make a control recognisable. Check light and dark themes.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`; layouts survive 200% zoom and a 320 px wide window without horizontal scrolling.

## Desktop and game UI
- Full keyboard and gamepad navigation with a visible selection; remappable controls.
- Scalable text and UI, subtitles with speaker names, colour-blind-safe palettes, and options to reduce screen shake and flashing.
- Use the accessibility support of the UI toolkit (names and roles on widgets) instead of drawing everything as images.

## Check
- Use the changed UI with the keyboard only, then with a screen reader (NVDA or Narrator on Windows, VoiceOver on macOS).
- Run the project's automated checker if it has one (axe, Lighthouse, eslint-plugin-jsx-a11y) and fix what it finds; say that automated tools catch only part of the problems.
