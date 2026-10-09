import { describe, expect, it } from 'vitest';
import { findWindowAt } from '$lib/utils/hitTesting';
import { wallPointAt, wallTangentAt } from '$lib/utils/canvasRenderer';
import type { Wall, Window as Win } from '$lib/models/types';

const wall = { id: 'wall', start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: 20, height: 250 } as Wall;
const window = { id: 'window', wallId: 'wall', position: 0.5, width: 300, type: 'standard', sillHeight: 90 } as Win;

describe.each([0.25, 0.5, 1, 2, 4])('opening picking at zoom %s', zoom => {
  it('does not capture empty space far from a wide opening (#18)', () => {
    expect(findWindowAt({ x: 300, y: 140 }, [window], [wall], zoom)).toBeNull();
  });
  it('keeps the full physical width selectable and uses a screen-space edge tolerance', () => {
    expect(findWindowAt({ x: 440, y: 0 }, [window], [wall], zoom)).toBe(window);
    expect(findWindowAt({ x: 450 + 4 / zoom, y: 10 + 4 / zoom }, [window], [wall], zoom)).toBe(window);
    expect(findWindowAt({ x: 450 + 6 / zoom, y: 0 }, [window], [wall], zoom)).toBeNull();
    expect(findWindowAt({ x: 300, y: 10 + 6 / zoom }, [window], [wall], zoom)).toBeNull();
  });
});

it.each([
  { ...wall, end: { x: 0, y: 600 } },
  { ...wall, end: { x: 400, y: 400 } },
  { ...wall, curvePoint: { x: 100, y: 250 } },
])('uses the rendered tangent for rotated and curved walls', w => {
  const center = wallPointAt(w, 0.5), t = wallTangentAt(w, 0.5);
  expect(findWindowAt({ x: center.x + t.x * 140, y: center.y + t.y * 140 }, [window], [w], 2)).toBe(window);
  expect(findWindowAt({ x: center.x - t.y * 50, y: center.y + t.x * 50 }, [window], [w], 2)).toBeNull();
});

it('selects the last drawn opening and ignores missing or degenerate walls', () => {
  const top = { ...window, id: 'top' };
  expect(findWindowAt({ x: 300, y: 0 }, [window, top], [wall], 1)).toBe(top);
  expect(findWindowAt({ x: 300, y: 0 }, [window], [], 1)).toBeNull();
  expect(findWindowAt({ x: 0, y: 0 }, [window], [{ ...wall, end: wall.start }], 1)).toBeNull();
  expect(findWindowAt({ x: 300, y: 0 }, [window], [wall], 0)).toBeNull();
});
