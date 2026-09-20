import '@testing-library/jest-dom/vitest';

// jsdom has no real layout engine, so every element reports 0 for
// offsetHeight/offsetWidth by default. @tanstack/react-virtual (used by
// Conversation.tsx) measures both the scroll container and each item this
// way to decide what's in view, so with the jsdom default nothing would
// ever render as "visible" in tests -- this supplies the geometry jsdom
// doesn't implement, not a workaround for a bug.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() {
    return 100;
  },
});
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() {
    return 800;
  },
});
// scrollHeight/clientHeight default to 0 too, which clamps every scroll
// attempt (target > maxScrollOffset) to 0 -- clientHeight stays in step
// with the offsetHeight stub above, scrollHeight just needs to comfortably
// exceed any content height a test renders.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get() {
    return 100;
  },
});
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get() {
    return 1_000_000;
  },
});
