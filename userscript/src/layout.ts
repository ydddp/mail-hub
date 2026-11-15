/**
 * Positioning rules for the panel and the floating button, kept free of DOM so
 * the arithmetic can be tested. All coordinates are the host's top-left corner
 * in viewport pixels.
 */

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const EDGE_MARGIN = 8;
/** Distance within which a panel drag snaps flush to a vertical edge. */
export const SNAP_DISTANCE = 28;

/** Keep the whole box inside the viewport, with a reachable margin. */
export function clampPosition(position: Position, size: Size, viewport: Viewport): Position {
  const maxX = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(Math.round(position.x), EDGE_MARGIN), maxX),
    y: Math.min(Math.max(Math.round(position.y), EDGE_MARGIN), maxY),
  };
}

/** Snap horizontally to the nearer edge when a panel drag ends close to one. */
export function snapToEdge(position: Position, size: Size, viewport: Viewport): Position {
  const leftGap = position.x - EDGE_MARGIN;
  const rightGap = viewport.width - size.width - EDGE_MARGIN - position.x;
  if (leftGap <= SNAP_DISTANCE && leftGap <= rightGap) return { ...position, x: EDGE_MARGIN };
  if (rightGap <= SNAP_DISTANCE) {
    return { ...position, x: Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN) };
  }
  return position;
}

/**
 * A docked floating button lives half outside the viewport, so it reads as a tab
 * that belongs to the edge instead of a floating card. Vertical position stays
 * fully usable.
 */
export function dockPosition(
  position: Position,
  size: Size,
  viewport: Viewport,
): { position: Position; side: 'left' | 'right' } {
  const side: 'left' | 'right' = position.x + size.width / 2 < viewport.width / 2 ? 'left' : 'right';
  const tucked = Math.round(size.width / 2);
  const y = Math.min(
    Math.max(Math.round(position.y), EDGE_MARGIN),
    Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN),
  );
  return {
    side,
    position: { x: side === 'left' ? -tucked : viewport.width - size.width + tucked, y },
  };
}

/** Which edge a stored position is docked to, if any. */
export function dockedSide(position: Position, size: Size, viewport: Viewport): 'left' | 'right' | null {
  if (position.x < 0) return 'left';
  if (position.x + size.width > viewport.width) return 'right';
  return null;
}
