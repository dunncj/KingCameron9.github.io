// Pin positions are true to geography and never move — faking them apart
// would misrepresent where a place actually is. What actually needs fixing
// when two pins land close together on screen (Chantilly and Falls Church,
// both in the DC suburbs, are the reliable example) is their *labels*:
// nudge a colliding one down out of the way and draw a short leader line
// back to its own pin, the same "declutter the label, not the point"
// convention real map UIs use.
export interface LabelCandidate {
  id: string;
  px: number;
  py: number;
  width: number;
  height: number;
}

export interface LabelPlacement {
  id: string;
  dx: number;
  dy: number;
  // True once this label has been pushed off its default resting spot —
  // service.ts only draws a leader line in that case, so an uncluttered
  // marker (the overwhelming majority of the time, with only 4 fixed
  // locations) looks exactly like it always did.
  needsConnector: boolean;
}

export const DEFAULT_LABEL_GAP = 10;
const ROW_STEP = 4;
const MAX_ROW_ATTEMPTS = 6;
const COLLISION_MARGIN = 4;

function overlaps(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return (
    ax < bx + bw + COLLISION_MARGIN
    && ax + aw + COLLISION_MARGIN > bx
    && ay < by + bh + COLLISION_MARGIN
    && ay + ah + COLLISION_MARGIN > by
  );
}

// Deterministic and order-stable (sorts by screen x itself) so calling this
// every frame with the same inputs produces the same layout — no jitter
// from iteration-order differences between frames.
export function layoutLabels(candidates: LabelCandidate[]): LabelPlacement[] {
  const ordered = [...candidates].sort((a, b) => a.px - b.px);
  const placedBoxes: { x: number; y: number; w: number; h: number }[] = [];
  const placements: LabelPlacement[] = [];

  for (const c of ordered) {
    const boxX = c.px - c.width / 2;
    let dy = DEFAULT_LABEL_GAP;
    let attempt = 0;
    while (attempt < MAX_ROW_ATTEMPTS) {
      const boxY = c.py + dy;
      const collides = placedBoxes.some((b) => overlaps(boxX, boxY, c.width, c.height, b.x, b.y, b.w, b.h));
      if (!collides) break;
      dy += c.height + ROW_STEP;
      attempt += 1;
    }
    placedBoxes.push({ x: boxX, y: c.py + dy, w: c.width, h: c.height });
    placements.push({ id: c.id, dx: 0, dy, needsConnector: dy !== DEFAULT_LABEL_GAP });
  }

  return placements;
}
