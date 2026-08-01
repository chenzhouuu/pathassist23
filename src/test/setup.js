import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// This repo marks test hooks with `data-cy`, including in the vendored OHIF components, and has
// no `data-testid` anywhere. Pointing the query at the attribute that exists is what makes
// `getByTestId` usable at all.
configure({ testIdAttribute: 'data-cy' });

// jsdom implements neither of these, and Radix's primitives use both: `react-use-size` observes
// the slider thumb to place it, and `PointerEvent` is how a slider is dragged. Without them the
// vendored ui/slider.tsx throws on mount rather than failing an assertion, which reads as a broken
// test file instead of a missing browser API. Both stubs are inert — the tests that touch a slider
// drive it through the store or the keyboard, never by pixel position.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
}

if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {};
}

for (const fn of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
  if (!Element.prototype[fn]) Element.prototype[fn] = () => {};
}
