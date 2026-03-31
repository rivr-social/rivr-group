/**
 * @fileoverview ThemeProvider - Wraps the app with next-themes for dark/light mode support.
 *
 * Used in the root layout to provide theme context (light, dark, system)
 * throughout the component tree.
 */
'use client'

import * as React from 'react'
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from 'next-themes'

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
