import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
// @ts-expect-error The plain browser module has no TypeScript declarations.
import { bindDirectionHold } from '../public/tavern.js';

function setup() {
  const dom = new JSDOM('<button>up</button>');
  const button = dom.window.document.querySelector('button')!;
  const press = vi.fn(), release = vi.fn(), tap = vi.fn();
  const cleanup = bindDirectionHold(button, { onPress: press, onRelease: release, onTap: tap });
  function pointer(target: EventTarget, type: string) {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: 1, button: 0, isPrimary: true });
    target.dispatchEvent(e);
  }
  return { dom, button, press, release, tap, cleanup, pointer };
}

it('holds direction until pointer release, including release outside the button', () => {
  const t = setup();
  t.pointer(t.button, 'pointerdown');
  expect(t.press).toHaveBeenCalledTimes(1);
  expect(t.release).not.toHaveBeenCalled();
  t.pointer(t.dom.window, 'pointerup');
  expect(t.release).toHaveBeenCalledTimes(1);
  expect(t.release).toHaveBeenCalledWith({ cancelled: false });
  t.button.dispatchEvent(new t.dom.window.MouseEvent('click', { detail: 1 }));
  expect(t.tap).not.toHaveBeenCalled(); // no extra post-hold step
  t.cleanup(); t.dom.window.close();
});

it.each(['pointerleave', 'pointercancel', 'blur'])('stops held movement on %s', type => {
  const t = setup(); t.pointer(t.button, 'pointerdown');
  t.pointer(type === 'pointerleave' ? t.button : t.dom.window, type);
  expect(t.release).toHaveBeenCalledTimes(1);
  expect(t.release).toHaveBeenCalledWith({ cancelled: true });
  t.cleanup(); t.dom.window.close();
});

it('supports keyboard activation and removes its listeners on navigation', () => {
  const t = setup(); t.button.click(); expect(t.tap).toHaveBeenCalledTimes(1);
  t.pointer(t.button, 'pointerdown'); t.cleanup();
  expect(t.release).toHaveBeenCalledTimes(1);
  t.pointer(t.button, 'pointerdown'); expect(t.press).toHaveBeenCalledTimes(1);
  t.dom.window.close();
});
