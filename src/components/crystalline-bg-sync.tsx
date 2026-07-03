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
 * the browser paints, so there is no visible background flash. The crystalline
 * background is now the unified Rivr background across the ENTIRE live
 * ecosystem, so it re-applies on every host (no lane allowlist).
 */
'use client';

import { useLayoutEffect } from 'react';

export function CrystallineBgSync() {
  useLayoutEffect(() => {
    document.documentElement.classList.add('crystalline-bg');
  }, []);
  return null;
}
