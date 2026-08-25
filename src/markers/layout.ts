// Pin positions are true to geography and never move — faking them apart
// would misrepresent where a place actually is. What actually needs fixing
// when two pins land close together on screen (Chantilly and Falls Church,
// both in the DC suburbs, are the reliable example) is their *labels*:
// try a handful of positions around the pin and use the first one that
// doesn't overlap an already-placed label, falling back to stacking
// further out only if all of them are somehow taken.
//
// The candidates are diagonal (up-right, up-left, down-right, down-left),
// not cardinal (straight up/down/left/right) — real map labels extend up
// and out to a side of their point, connected by a short diagonal leader
// line, rather than sitting directly on one axis from it. That diagonal is
// also what makes the leader line always land on the label's actual
// nearest *corner* (see nearestPointOnBox) instead of the middle of an
// edge, which is what makes it read as pointing at a specific spot on the
// map rather than a generic tag with a line under it.
export interface LabelCandidate {
  id: string;
  px: number;
  py: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LabelPlacement {
  id: string;
  // Label's top-left corner, relative to the pin's own anchor point
  // (0, 0) — service.ts positions the label with a plain translate(x, y),
  // no centering math of its own, since which edge/corner is "centered"
  // depends on which of the four directions below was actually chosen.
  offset: Point;
  // Nearest point on the label's box to the pin, relative to the pin's
  // anchor — where the leader line service.ts always draws should end.
  // Drawn even at the default (below) position, not just when a collision
  // pushed the label somewhere else — without it the tag reads as an
  // unrelated floating label rather than something attached to its pin.
  connectorTo: Point;
}

const DIAG_GAP_X = 10;
const DIAG_GAP_Y = 10;
const COLLISION_MARGIN = 4;
const STACK_STEP = 4;
const MAX_STACK_ATTEMPTS = 4;

interface Box { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w + COLLISION_MARGIN
    && a.x + a.w + COLLISION_MARGIN > b.x
    && a.y < b.y + b.h + COLLISION_MARGIN
    && a.y + a.h + COLLISION_MARGIN > b.y
  );
}

// Four diagonal candidate offsets, preference order: up-right (the classic
// default for a map label), up-left, down-right, down-left. Each is the
// label's top-left corner, chosen so the label's *near* corner — not an
// edge midpoint — sits DIAG_GAP away from the point in both axes at once,
// extending the label up/down AND out to a side simultaneously.
function candidateOffsets(width: number, height: number): Point[] {
  return [
    { x: DIAG_GAP_X, y: -(DIAG_GAP_Y + height) },
    { x: -(DIAG_GAP_X + width), y: -(DIAG_GAP_Y + height) },
    { x: DIAG_GAP_X, y: DIAG_GAP_Y },
    { x: -(DIAG_GAP_X + width), y: DIAG_GAP_Y },
  ];
}

function nearestPointOnBox(box: Box): Point {
  return {
    x: Math.max(box.x, Math.min(0, box.x + box.w)),
    y: Math.max(box.y, Math.min(0, box.y + box.h)),
  };
}

// Deterministic and order-stable (sorts by screen x itself) so calling this
// every frame with the same inputs produces the same layout — no jitter
// from iteration-order differences between frames.
//
// Sorted right-to-left, not left-to-right: the first marker processed in
// any colliding pair gets the up-right default, and later ones fall back
// to up-left when that collides — so processing the *rightmost* marker
// first is what makes it the one that leans right, with its left neighbor
// falling back to leaning left, away from it. Left-to-right order did the
// opposite: the leftmost of a pair claimed the default and ended up
// leaning right, toward its neighbor, while the rightmost got bumped left
// — both labels pointing inward instead of splaying outward from the pair.
export function layoutLabels(candidates: LabelCandidate[]): LabelPlacement[] {
  const ordered = [...candidates].sort((a, b) => b.px - a.px);
  const placedBoxes: Box[] = [];
  const placements: LabelPlacement[] = [];

  for (const c of ordered) {
    const options = candidateOffsets(c.width, c.height);
    let chosen = options[0]!;
    let resolved = false;

    for (const opt of options) {
      const box: Box = {
        x: c.px + opt.x, y: c.py + opt.y, w: c.width, h: c.height,
      };
      if (!placedBoxes.some((b) => overlaps(box, b))) {
        chosen = opt;
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      // All four diagonals are already taken (rare — needs three or more
      // pins clustered within a couple dozen pixels of each other) — keep
      // stacking further down-right until one's clear.
      let dy = DIAG_GAP_Y;
      for (let attempt = 0; attempt < MAX_STACK_ATTEMPTS; attempt++) {
        dy += c.height + STACK_STEP;
        const box: Box = {
          x: c.px + DIAG_GAP_X, y: c.py + dy, w: c.width, h: c.height,
        };
        chosen = { x: DIAG_GAP_X, y: dy };
        if (!placedBoxes.some((b) => overlaps(box, b))) break;
      }
    }

    const box: Box = {
      x: c.px + chosen.x, y: c.py + chosen.y, w: c.width, h: c.height,
    };
    placedBoxes.push(box);

    placements.push({
      id: c.id,
      offset: chosen,
      connectorTo: nearestPointOnBox({
        x: chosen.x, y: chosen.y, w: c.width, h: c.height,
      }),
    });
  }

  return placements;
}
