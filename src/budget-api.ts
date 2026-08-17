// ----------------------------
// BUDGET API
// ----------------------------
//
// Thin wrappers over the @actual-app/api budget methods, mirroring the style of
// actual-api.ts. Kept in a separate module so budget support is an additive
// change rather than an edit to the initialization path.

import * as api from '@actual-app/api';
import { initActualApi } from './actual-api.js';

/**
 * Get the list of months that exist in the budget file (ensures API is initialized)
 */
export async function getBudgetMonths(): Promise<string[]> {
  await initActualApi();
  return api.getBudgetMonths();
}

/**
 * Get budgeted / spent / balance per category for a month (ensures API is initialized)
 *
 * @param month - Budget month in YYYY-MM format
 */
export async function getBudgetMonth(month: string): Promise<unknown> {
  await initActualApi();
  return api.getBudgetMonth(month);
}

/**
 * Set the budgeted amount for a category in a month (ensures API is initialized)
 *
 * Reason: the published docs describe these as returning Promise<null>, but the
 * shipped type declarations resolve to void — so the wrappers follow the types.
 *
 * @param month - Budget month in YYYY-MM format
 * @param categoryId - Category ID (UUID)
 * @param value - Amount in INTEGER CENTS ($120.30 => 12030)
 */
export async function setBudgetAmount(month: string, categoryId: string, value: number): Promise<void> {
  await initActualApi();
  return api.setBudgetAmount(month, categoryId, value);
}

/**
 * Toggle rollover ("carryover") of a category's balance into the next month.
 */
export async function setBudgetCarryover(month: string, categoryId: string, flag: boolean): Promise<void> {
  await initActualApi();
  return api.setBudgetCarryover(month, categoryId, flag);
}

/**
 * Run several budget mutations inside a single sync round-trip.
 *
 * Backfilling a year of budgets is hundreds of writes; without batching, each
 * one is its own sync against the Actual server. Falls back to running the
 * callback directly if the installed @actual-app/api predates this method, so a
 * version difference can't break the build.
 */
export async function batchBudgetUpdates(fn: () => Promise<void>): Promise<void> {
  await initActualApi();
  const batch = (api as unknown as { batchBudgetUpdates?: (f: () => Promise<void>) => Promise<void> })
    .batchBudgetUpdates;
  if (typeof batch === 'function') {
    return batch(fn);
  }
  return fn();
}
