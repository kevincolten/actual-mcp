// ----------------------------
// BULK CATEGORIZE TRANSACTIONS TOOL
// ----------------------------

import { z, toJSONSchema } from 'zod';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { success, error, errorFromCatch } from '../../utils/response.js';
import { updateTransaction } from '../../actual-api.js';
import { fetchAllCategories } from '../../core/data/fetch-categories.js';
import { fetchAllAccounts } from '../../core/data/fetch-accounts.js';
import { fetchAllTransactions } from '../../core/data/fetch-transactions.js';
import type { ToolInput } from '../../types.js';
import type { Category, Transaction } from '../../core/types/domain.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// # Reason: Preview output is read by a model; listing thousands of rows wastes
// context without adding signal, so the sample is capped and the rest summarised.
const PREVIEW_SAMPLE_LIMIT = 25;

const AssignmentSchema = z.object({
  transactionId: z.string().describe('Required. The ID of the transaction to categorize'),
  category: z.string().describe('Required. Target category, given either as a category ID or an exact category name'),
});

const PatternSchema = z.object({
  payeeMatch: z.string().describe('Required. Text to match against the transaction payee name'),
  category: z.string().describe('Required. Target category, given either as a category ID or an exact category name'),
  matchType: z
    .enum(['contains', 'exact', 'regex'])
    .default('contains')
    .describe('How payeeMatch is compared to the payee name. Matching is case-insensitive.'),
});

const BulkCategorizeArgsSchema = z.object({
  assignments: z
    .array(AssignmentSchema)
    .optional()
    .describe('Explicit per-transaction assignments. Takes precedence over patterns on conflict.'),
  patterns: z
    .array(PatternSchema)
    .optional()
    .describe(
      'Payee-based rules applied across the selected scope. Patterns are evaluated in order and the first match wins.'
    ),
  accountId: z
    .string()
    .optional()
    .describe('Limit pattern matching to a single account. If omitted, all non-closed accounts are scanned.'),
  startDate: z
    .string()
    .regex(DATE_REGEX, 'startDate must be in YYYY-MM-DD format')
    .optional()
    .describe('Start of the pattern search window (YYYY-MM-DD). Defaults to one year ago.'),
  endDate: z
    .string()
    .regex(DATE_REGEX, 'endDate must be in YYYY-MM-DD format')
    .optional()
    .describe('End of the pattern search window (YYYY-MM-DD). Defaults to today.'),
  onlyUncategorized: z
    .boolean()
    .default(true)
    .describe('When true, patterns only apply to transactions that have no category yet.'),
  dryRun: z
    .boolean()
    .default(true)
    .describe('When true (the default), report the planned changes without writing. Set false to apply them.'),
});

type BulkCategorizeArgs = z.infer<typeof BulkCategorizeArgsSchema>;
type Pattern = z.infer<typeof PatternSchema>;

interface PlannedChange {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  source: 'assignment' | 'pattern';
  date?: string;
  amount?: number;
  payeeName?: string;
  currentCategoryName?: string;
}

export const schema = {
  name: 'bulk-categorize-transactions',
  description:
    'Categorize many transactions in one call. Accepts explicit {transactionId, category} assignments, ' +
    'payee-matching patterns applied across an account/date scope, or both. ' +
    'Categories may be given as an ID or an exact name. ' +
    'Runs as a preview by default (dryRun=true) and reports what would change; ' +
    'call again with dryRun=false to actually write.',
  inputSchema: toJSONSchema(BulkCategorizeArgsSchema) as ToolInput,
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildCategoryResolver(categories: Category[]): (ref: string) => Category | undefined {
  const byId = new Map<string, Category>();
  const byName = new Map<string, Category>();

  for (const category of categories) {
    byId.set(category.id, category);
    // # Reason: Category names are not guaranteed unique across groups. Keep the
    // first occurrence so resolution is deterministic rather than order-dependent.
    const key = category.name.trim().toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, category);
    }
  }

  return (ref: string) => byId.get(ref) ?? byName.get(ref.trim().toLowerCase());
}

function payeeMatches(pattern: Pattern, payeeName: string): boolean {
  const haystack = payeeName.toLowerCase();
  const needle = pattern.payeeMatch.toLowerCase();

  switch (pattern.matchType) {
    case 'exact':
      return haystack === needle;
    case 'regex':
      // Invalid patterns are rejected up front, so construction here is safe.
      return new RegExp(pattern.payeeMatch, 'i').test(payeeName);
    case 'contains':
    default:
      return haystack.includes(needle);
  }
}

function formatAmount(amount?: number): string {
  if (amount === undefined) return '';
  return (amount / 100).toFixed(2);
}

function describeChange(change: PlannedChange): string {
  const parts = [change.date, change.payeeName, formatAmount(change.amount)].filter(Boolean);
  const prefix = parts.length > 0 ? `${parts.join('  ')}  ` : '';
  const from = change.currentCategoryName ? `${change.currentCategoryName} -> ` : '';
  return `${prefix}[${change.transactionId}] ${from}${change.categoryName}`;
}

function summarizeByCategory(changes: PlannedChange[]): string {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.categoryName, (counts.get(change.categoryName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `  ${count}x ${name}`)
    .join('\n');
}

export async function handler(args: BulkCategorizeArgs): Promise<CallToolResult> {
  try {
    const validatedArgs = BulkCategorizeArgsSchema.parse(args);
    const { assignments = [], patterns = [], accountId, onlyUncategorized, dryRun } = validatedArgs;

    if (assignments.length === 0 && patterns.length === 0) {
      return error('Provide at least one of `assignments` or `patterns`.');
    }

    // Reject bad regexes before any fetching so the failure is cheap and obvious.
    for (const pattern of patterns) {
      if (pattern.matchType === 'regex') {
        try {
          new RegExp(pattern.payeeMatch, 'i');
        } catch {
          return error(`Invalid regular expression in payeeMatch: ${pattern.payeeMatch}`);
        }
      }
    }

    const categories = await fetchAllCategories();
    const resolveCategory = buildCategoryResolver(categories);

    const unresolved = new Set<string>();
    for (const ref of [...assignments.map((a) => a.category), ...patterns.map((p) => p.category)]) {
      if (!resolveCategory(ref)) {
        unresolved.add(ref);
      }
    }
    if (unresolved.size > 0) {
      return error(
        `Unknown categor${unresolved.size === 1 ? 'y' : 'ies'}: ${[...unresolved].join(', ')}. ` +
          'Use get-grouped-categories to list valid category IDs and names.'
      );
    }

    // Explicit assignments are applied last so they win over pattern matches.
    const plan = new Map<string, PlannedChange>();

    if (patterns.length > 0) {
      const startDate = validatedArgs.startDate ?? isoDaysAgo(365);
      const endDate = validatedArgs.endDate ?? todayIso();

      if (startDate > endDate) {
        return error(`startDate (${startDate}) must not be after endDate (${endDate}).`);
      }

      const allAccounts = await fetchAllAccounts();
      const scopedAccounts = accountId
        ? allAccounts.filter((account) => account.id === accountId)
        : allAccounts.filter((account) => !account.closed);

      if (accountId && scopedAccounts.length === 0) {
        return error(`No account found with ID ${accountId}.`);
      }

      const transactions: Transaction[] = await fetchAllTransactions(scopedAccounts, startDate, endDate);

      for (const transaction of transactions) {
        if (onlyUncategorized && transaction.category) continue;

        const payeeName = transaction.payee_name;
        if (!payeeName) continue;

        const matched = patterns.find((pattern) => payeeMatches(pattern, payeeName));
        if (!matched) continue;

        const category = resolveCategory(matched.category);
        if (!category) continue;

        // Skip no-op writes where the transaction already carries the target category.
        if (transaction.category === category.id) continue;

        plan.set(transaction.id, {
          transactionId: transaction.id,
          categoryId: category.id,
          categoryName: category.name,
          source: 'pattern',
          date: transaction.date,
          amount: transaction.amount,
          payeeName,
          currentCategoryName: transaction.category_name,
        });
      }
    }

    for (const assignment of assignments) {
      const category = resolveCategory(assignment.category);
      if (!category) continue;

      const existing = plan.get(assignment.transactionId);
      plan.set(assignment.transactionId, {
        ...existing,
        transactionId: assignment.transactionId,
        categoryId: category.id,
        categoryName: category.name,
        source: 'assignment',
      });
    }

    const changes = [...plan.values()];

    if (changes.length === 0) {
      return success('No transactions matched. Nothing to categorize.');
    }

    const breakdown = summarizeByCategory(changes);
    const sample = changes.slice(0, PREVIEW_SAMPLE_LIMIT).map(describeChange).join('\n');
    const omitted = changes.length - Math.min(changes.length, PREVIEW_SAMPLE_LIMIT);
    const omittedNote = omitted > 0 ? `\n...and ${omitted} more.` : '';

    if (dryRun) {
      return success(
        `DRY RUN - no changes written.\n\n` +
          `${changes.length} transaction(s) would be categorized:\n${breakdown}\n\n` +
          `${sample}${omittedNote}\n\n` +
          `Re-run with dryRun=false to apply.`
      );
    }

    const failures: string[] = [];
    let updated = 0;

    for (const change of changes) {
      try {
        await updateTransaction(change.transactionId, { category: change.categoryId });
        updated += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`  ${change.transactionId}: ${message}`);
      }
    }

    // # Reason: Updates are applied one at a time, so a partial failure is possible.
    // Report both sides rather than throwing away the work that succeeded.
    if (failures.length > 0) {
      return success(
        `Categorized ${updated} of ${changes.length} transaction(s).\n${breakdown}\n\n` +
          `${failures.length} failed:\n${failures.join('\n')}`
      );
    }

    return success(`Successfully categorized ${updated} transaction(s):\n${breakdown}`);
  } catch (err) {
    return errorFromCatch(err);
  }
}
