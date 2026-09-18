// The panel's two inline icons.
//
// There is no icon library here and there is not going to be one: the design system's iconography
// is geometric marks, and the bar's third control is a text glyph (◐, the theme toggle). These two
// are drawn to sit beside it — same optical weight, same 16px box, nothing a font could not have
// drawn.
//
// Why they are built this way:
//
//   * A 16x16 viewBox with integer coordinates and `shape-rendering="crispEdges"`. The panel is
//     rendered at whatever device pixel ratio the user's display has, and at 1x an antialiased
//     2px bar goes to a grey smear. Straight rects on whole pixels stay sharp at 1x and are still
//     correct at 2x.
//   * `currentColor` only — no fill or stroke is named. The controls set their colour from the
//     theme tokens and the mark follows, so hover, active, dark and light all work without either
//     icon knowing a thing about the palette.
//   * `aria-hidden`: these are always drawn next to a real accessible name (a visible label when
//     the bar is wide, a visually-hidden one plus aria-label when it is narrow), so the mark itself
//     must not be announced.
//
// Both take no props; size and colour come from CSS.

/** Settings: a sliders mark — three tracks, each with its handle at a different stop. */
export function SettingsIcon() {
  return (
    <svg
      className="ico"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* tracks */}
      <rect x="2" y="3" width="12" height="1" fill="currentColor" opacity="0.55" />
      <rect x="2" y="7" width="12" height="1" fill="currentColor" opacity="0.55" />
      <rect x="2" y="11" width="12" height="1" fill="currentColor" opacity="0.55" />
      {/* handles, offset so the three rows read as independently set */}
      <rect x="9" y="1" width="2" height="5" fill="currentColor" />
      <rect x="4" y="5" width="2" height="5" fill="currentColor" />
      <rect x="10" y="9" width="2" height="5" fill="currentColor" />
    </svg>
  );
}

/** Dashboard: a window mark — a title bar over a two-pane body, i.e. the full-tab page. */
export function DashboardIcon() {
  return (
    <svg
      className="ico"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* frame, drawn as four rects rather than a stroked rect so the 1px edges never land on a
          half pixel */}
      <rect x="2" y="2" width="12" height="1" fill="currentColor" />
      <rect x="2" y="13" width="12" height="1" fill="currentColor" />
      <rect x="2" y="2" width="1" height="12" fill="currentColor" />
      <rect x="13" y="2" width="1" height="12" fill="currentColor" />
      {/* The title bar. One pixel tall, not two: at 16px a 2px band swallowed the frame and the
          mark read as a filled block rather than as a window. */}
      <rect x="3" y="4" width="10" height="1" fill="currentColor" />
      {/* the divider between the two panes below it */}
      <rect x="7" y="6" width="1" height="7" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
