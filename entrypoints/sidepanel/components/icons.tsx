// The panel's inline icons: the top bar's two, and the chat switcher's four.
//
// There is no icon library here and there is not going to be one: the design system's iconography
// is geometric marks, and the bar's third control is a text glyph (◐, the theme toggle). These are
// drawn to sit beside it — same optical weight, same 16px box, nothing a font could not have
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
// They all take no props; size and colour come from CSS.

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

/* ---------------------------------------------------------------------------
 * The chat switcher's actions.
 *
 * Same rules as the two above — 16x16, integer rects, crispEdges, currentColor, aria-hidden —
 * because below the chatbar's breakpoint these ARE the buttons: there is no visible word beside
 * them, only an aria-label and a title. A mark that needs a caption to be read would be a
 * regression on the labels it replaced, so each one is a silhouette that survives at 1x:
 *
 *   Rename     a pencil on the diagonal, tapering to a graphite tip, ruling a line
 *   Archive    a lidded box: a full-width lid over a body, i.e. a thing you put something into
 *   Unarchive  that same box with its lid lifted and an arrow coming up out of it, so the pair
 *              reads as one toggle rather than as two unrelated marks
 *   Delete     a bin: lid, handle and a body with two staves
 *
 * The diagonal in the pencil is stepped by hand as 2px blocks rather than drawn as a rotated rect,
 * because `crispEdges` on a rotated shape gives a ragged edge rather than a clean one. Stepping it
 * is what a 16px bitmap icon would have done anyway, and it matches the geometric house style.
 */

/** Rename: a pencil ruling a line. */
export function RenameIcon() {
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
      {/*
          The pencil, running down-left from the top right as a CONTINUOUS body: each row is a
          4px-wide block, and consecutive rows overlap by 3px, so the shape is a solid bar on a
          shallow diagonal rather than a flight of stairs. Two earlier drafts stepped 2px at a time
          with no overlap and both of them read, unmistakably and in both themes, as a staircase.
          On a 16px grid the fix is overlap, not more steps.
      */}
      <rect x="9" y="2" width="4" height="1" fill="currentColor" />
      <rect x="8" y="3" width="4" height="1" fill="currentColor" />
      <rect x="7" y="4" width="4" height="1" fill="currentColor" />
      <rect x="6" y="5" width="4" height="1" fill="currentColor" />
      <rect x="5" y="6" width="4" height="1" fill="currentColor" />
      <rect x="4" y="7" width="4" height="1" fill="currentColor" />
      {/* the ferrule: one quiet row across the body, which is what makes it a pencil and not a bar */}
      <rect x="7" y="4" width="4" height="1" fill="currentColor" opacity="0.4" />
      {/* the nib, tapering to a point, with the graphite tip at full strength */}
      <rect x="3" y="8" width="4" height="1" fill="currentColor" opacity="0.55" />
      <rect x="3" y="9" width="3" height="1" fill="currentColor" opacity="0.55" />
      <rect x="2" y="10" width="2" height="1" fill="currentColor" />
      {/* the rule it is writing on */}
      <rect x="2" y="13" width="12" height="1" fill="currentColor" />
    </svg>
  );
}

/** Archive: a lidded box. */
export function ArchiveIcon() {
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
      {/* the lid, full width and solid: the part that says "closed" */}
      <rect x="2" y="3" width="12" height="2" fill="currentColor" />
      {/* the body, drawn as three rects so its 1px walls never land on a half pixel */}
      <rect x="3" y="6" width="1" height="7" fill="currentColor" />
      <rect x="12" y="6" width="1" height="7" fill="currentColor" />
      <rect x="3" y="12" width="10" height="1" fill="currentColor" />
      {/* the catch on the front face */}
      <rect x="6" y="8" width="4" height="1" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** Unarchive: the archive box, with the contents coming back up out of it. */
export function UnarchiveIcon() {
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
      {/*
          The archive box, unchanged below the lid line, so the two marks are visibly one toggle:
          same walls at x=3 and x=12, same floor at y=12. What changes is the top — the lid has
          been lifted clear and the contents are coming up out of it.

          The first draft dismantled the box into two stubs instead, and at 16px that read as
          debris rather than as a container: the arrow had nothing to come out OF.
      */}
      <rect x="3" y="7" width="1" height="6" fill="currentColor" />
      <rect x="12" y="7" width="1" height="6" fill="currentColor" />
      <rect x="3" y="12" width="10" height="1" fill="currentColor" />
      {/* the lid, lifted off and set down quietly across the box's mouth */}
      <rect x="4" y="7" width="8" height="1" fill="currentColor" opacity="0.55" />
      {/* The arrow out: a 2px shaft under a solid triangular head, stepped a pixel at a time so
          the head is a wedge rather than a bar. Full strength — it is what the mark is about. */}
      <rect x="7" y="2" width="2" height="1" fill="currentColor" />
      <rect x="6" y="3" width="4" height="1" fill="currentColor" />
      <rect x="5" y="4" width="6" height="1" fill="currentColor" />
      <rect x="7" y="5" width="2" height="5" fill="currentColor" />
    </svg>
  );
}

/**
 * Edit a mod: a script page with a pencil tip at its corner.
 *
 * It has to read as "a mod, being edited" beside a pencil that already means "rename this chat", so
 * the two cannot both be a bare pencil. The document is the loud part — a page with three ragged
 * lines of code on it, which is what a mod looks like — and the pencil is a small mark at its
 * corner, the way a badge sits on an app icon. Same rules as every other icon here: 16x16, integer
 * rects, crispEdges, currentColor, aria-hidden, with the pencil's diagonal stepped with a 1px
 * overlap per row so it reads as a solid bar rather than a staircase (see RenameIcon).
 */
export function EditModIcon() {
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
      {/* The page: 1px walls, stopping short on the right so the pencil has a corner of its own. */}
      <rect x="2" y="2" width="9" height="1" fill="currentColor" />
      <rect x="2" y="2" width="1" height="12" fill="currentColor" />
      <rect x="10" y="2" width="1" height="5" fill="currentColor" />
      <rect x="2" y="13" width="9" height="1" fill="currentColor" />
      <rect x="10" y="11" width="1" height="3" fill="currentColor" />
      {/* Three lines of script, ragged like code rather than justified like prose. */}
      <rect x="4" y="5" width="5" height="1" fill="currentColor" opacity="0.55" />
      <rect x="4" y="7" width="3" height="1" fill="currentColor" opacity="0.55" />
      <rect x="4" y="9" width="4" height="1" fill="currentColor" opacity="0.55" />
      {/* The pencil, running down-left into the page's corner, with its graphite tip at full strength. */}
      <rect x="13" y="6" width="2" height="1" fill="currentColor" />
      <rect x="12" y="7" width="2" height="1" fill="currentColor" />
      <rect x="11" y="8" width="2" height="1" fill="currentColor" />
      <rect x="10" y="9" width="2" height="1" fill="currentColor" />
    </svg>
  );
}

/** Delete: a bin. */
export function DeleteIcon() {
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
      {/* the handle above the lid — the detail that stops this reading as the archive box */}
      <rect x="6" y="2" width="4" height="1" fill="currentColor" />
      <rect x="2" y="4" width="12" height="2" fill="currentColor" />
      {/* the body, tapering by one pixel is not available on this grid, so it is a straight can */}
      <rect x="4" y="7" width="1" height="7" fill="currentColor" />
      <rect x="11" y="7" width="1" height="7" fill="currentColor" />
      <rect x="4" y="13" width="8" height="1" fill="currentColor" />
      {/* the two staves, quieter than the walls so the silhouette stays the loudest thing */}
      <rect x="7" y="8" width="1" height="4" fill="currentColor" opacity="0.55" />
      <rect x="9" y="8" width="1" height="4" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
