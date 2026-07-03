/**
 * @fileoverview CrystallineBgSync — keeps the `crystalline-bg` class on <html>
 * after React hydration.
 *
 * The root layout's inline boot script sets the class BEFORE first paint (so
 * the final background is the only one the user ever sees), but React 19
 * hydration re-patches the <html>/<body> className to the client-rendered
 * value, wiping any class added by a pre-hydration script — verified live:
 * next-themes' `dark` class survives only because its provider re-applies it
 * post-hydration. This component is that re-applier for the crystalline flag.
 *
 * useLayoutEffect runs synchronously after the hydration commit and before
 * the browser paints, so there is no visible background flash. Renders
 * nothing; lane logic mirrors the boot script (one canonical host list).
 */
'use client';

import { useLayoutEffect } from 'react';

/** Hostnames that are global Rivr runtimes — the crystalline lanes. */
const CRYSTALLINE_HOSTS = new Set([
  'a.rivr.social',
  'app.rivr.social',
  'beta.rivr.social',
  'dev.rivr.social',
]);

export function CrystallineBgSync() {
  useLayoutEffect(() => {
    const enabled =
      process.env.NEXT_PUBLIC_TESTA_BG === 'crystalline' ||
      CRYSTALLINE_HOSTS.has(window.location.hostname);
    if (enabled) document.documentElement.classList.add('crystalline-bg');
  }, []);
  return null;
}
