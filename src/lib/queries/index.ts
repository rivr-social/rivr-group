/**
 * Query layer barrel module.
 *
 * Purpose:
 * - Provides a single import surface for semantic graph query helpers.
 * - Re-exports domain query modules without introducing runtime behavior.
 *
 * Key exports:
 * - All agent query functions from `./agents`.
 * - All resource query functions from `./resources`.
 * - All stake query functions from `./stakes`.
 *
 * Dependencies:
 * - Relies on side-effect-free re-export semantics from the sibling query modules.
 * - Keeps consumer imports stable as query modules evolve.
 */

export * from "./agents";
export * from "./resources";
export * from "./stakes";
