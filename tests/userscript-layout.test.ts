import { describe, expect, it } from 'vitest';
import {
  EDGE_MARGIN,
  clampPosition,
  dockPosition,
  dockedSide,
  snapToEdge,
} from '../userscript/src/layout.js';

const viewport = { width: 1000, height: 800 };

describe('clampPosition', () => {
  it('keeps the box fully on screen with a margin', () => {
    expect(clampPosition({ x: -50, y: -50 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN });
    expect(clampPosition({ x: 5000, y: 5000 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: viewport.width - 360 - EDGE_MARGIN, y: viewport.height - 400 - EDGE_MARGIN });
  });

  it('leaves a usable position alone', () => {
    expect(clampPosition({ x: 200, y: 120 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: 200, y: 120 });
  });

  // A window narrower than the panel must not produce a negative bound.
  it('falls back to the margin when the box cannot fit', () => {
    expect(clampPosition({ x: 100, y: 100 }, { width: 900, height: 900 }, { width: 400, height: 400 }))
      .toEqual({ x: EDGE_MARGIN, y: EDGE_MARGIN });
  });
});

describe('snapToEdge', () => {
  it('snaps flush when dropped near an edge', () => {
    expect(snapToEdge({ x: 20, y: 100 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: EDGE_MARGIN, y: 100 });
    expect(snapToEdge({ x: 640, y: 100 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: viewport.width - 360 - EDGE_MARGIN, y: 100 });
  });

  it('does not move a drop in the middle', () => {
    expect(snapToEdge({ x: 300, y: 100 }, { width: 360, height: 400 }, viewport))
      .toEqual({ x: 300, y: 100 });
  });
});

describe('dockPosition', () => {
  const fab = { width: 44, height: 40 };

  // The requested behaviour: a docked button sits half outside the viewport so
  // only a sliver shows, like a tab attached to the edge.
  it('tucks half of the button past the nearer edge', () => {
    const left = dockPosition({ x: 60, y: 200 }, fab, viewport);
    expect(left.side).toBe('left');
    expect(left.position.x).toBe(-22);

    const right = dockPosition({ x: 800, y: 200 }, fab, viewport);
    expect(right.side).toBe('right');
    expect(right.position.x).toBe(viewport.width - 44 + 22);
  });

  it('keeps the vertical position inside the viewport', () => {
    expect(dockPosition({ x: 0, y: -100 }, fab, viewport).position.y).toBe(EDGE_MARGIN);
    expect(dockPosition({ x: 0, y: 5000 }, fab, viewport).position.y)
      .toBe(viewport.height - fab.height - EDGE_MARGIN);
  });

  it('decides the side from the middle of the button, not its corner', () => {
    expect(dockPosition({ x: 470, y: 0 }, fab, viewport).side).toBe('left');
    expect(dockPosition({ x: 486, y: 0 }, fab, viewport).side).toBe('right');
  });
});

describe('dockedSide', () => {
  const fab = { width: 44, height: 40 };

  it('recognises a tucked position', () => {
    expect(dockedSide({ x: -22, y: 100 }, fab, viewport)).toBe('left');
    expect(dockedSide({ x: 978, y: 100 }, fab, viewport)).toBe('right');
  });

  it('reports no dock for a position inside the viewport', () => {
    expect(dockedSide({ x: 400, y: 100 }, fab, viewport)).toBeNull();
  });
});
