// Pin positions are true to geography and never move — faking them apart
// would misrepresent where a place actually is. What actually needs fixing
// when two pins land close together on screen (Chantilly and Falls Church,
// both in the DC suburbs, are the reliable example) is their *labels*:
// try a handful of positions around the pin — below, above, right, left,
// in that order of preference — and use the first one that doesn't
// overlap an already-placed label, falling back to stacking further below
// only if all four are somehow taken. Leader lines only appear once a
// label actually had to leave its default (below) spot.
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
  needsConnector: boolean;
  // Nearest point on the label's box to the pin, relative to the pin's
  // anchor — where a leader line (when drawn) should end.
  connectorTo: Point;
}

const GAP = 6;
const SIDE_GAP = 8;
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

// Four candidate offsets, preference order: below (the original default),
// above, right, left. Each already accounts for the label's own width/
// height so the *box*, not just an anchor point, clears the pin.
function candidateOffsets(width: number, height: number): Point[] {
  return [
    { x: -width / 2, y: GAP },
    { x: -width / 2, y: -(GAP + height) },
    { x: SIDE_GAP, y: -height / 2 },
    { x: -(SIDE_GAP + width), y: -height / 2 },
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
export function layoutLabels(candidates: LabelCandidate[]): LabelPlacement[] {
  const ordered = [...candidates].sort((a, b) => a.px - b.px);
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
      // All four directions are already taken (rare — needs three or more
      // pins clustered within a couple dozen pixels of each other) — keep
      // stacking further below the default spot until one's clear.
      let dy = options[0]!.y;
      for (let attempt = 0; attempt < MAX_STACK_ATTEMPTS; attempt++) {
        dy += c.height + STACK_STEP;
        const box: Box = {
          x: c.px - c.width / 2, y: c.py + dy, w: c.width, h: c.height,
        };
        chosen = { x: -c.width / 2, y: dy };
        if (!placedBoxes.some((b) => overlaps(box, b))) break;
      }
    }

    const box: Box = {
      x: c.px + chosen.x, y: c.py + chosen.y, w: c.width, h: c.height,
    };
    placedBoxes.push(box);

    const isDefault = chosen.x === options[0]!.x && chosen.y === options[0]!.y;
    placements.push({
      id: c.id,
      offset: chosen,
      needsConnector: !isDefault,
      connectorTo: nearestPointOnBox({
        x: chosen.x, y: chosen.y, w: c.width, h: c.height,
      }),
    });
  }

  return placements;
}
