// ----------------------------
// SET BUDGET AMOUNT TOOL
// ----------------------------

import { successWithJson, errorFromCatch } from '../../../utils/response.js';
import { setBudgetAmount, batchBudgetUpdates } from '../../../budget-api.js';

interface BudgetEntry {
  month: string;
  categoryId: string;
  amount: number;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export const schema = {
  name: 'set-budget-amount',
  description:
    'Set the budgeted amount for one or more category/month pairs. ' +
    'Amounts are given in DOLLARS (e.g. 1250.5) and converted to integer cents internally. ' +
    'All entries are applied in a single batch. Use dryRun to preview first. ' +
    'Note: budgeting a past month changes that month\u2019s balance, which rolls forward into later months.',
  inputSchema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description: 'Budget entries to set.',
        items: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              description: 'Budget month in YYYY-MM format',
              pattern: '^\\d{4}-\\d{2}$',
            },
            categoryId: {
              type: 'string',
              description: 'Category ID in UUID format',
            },
            amount: {
              type: 'number',
              description: 'Budgeted amount in dollars. 0 clears the budget for that category/month.',
            },
          },
          required: ['month', 'categoryId', 'amount'],
        },
        minItems: 1,
      },
      dryRun: {
        type: 'boolean',
        description: 'If true, validate and report what would change without writing.',
      },
    },
    required: ['entries'],
  },
};

export async function handler(
  args: Record<string, unknown>
): Promise<ReturnType<typeof successWithJson> | ReturnType<typeof errorFromCatch>> {
  try {
    const entries = args.entries as BudgetEntry[] | undefined;

    if (!Array.isArray(entries) || entries.length === 0) {
      return errorFromCatch('entries is required and must be a non-empty array');
    }

    // Validate every entry before writing anything. There is no rollback, so a
    // malformed row must not be discovered halfway through a batch.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== 'object') {
        return errorFromCatch(`entries[${i}] must be an object`);
      }
      if (typeof e.month !== 'string' || !MONTH_RE.test(e.month)) {
        return errorFromCatch(`entries[${i}].month must be YYYY-MM (got ${String(e.month)})`);
      }
      if (typeof e.categoryId !== 'string' || e.categoryId.length === 0) {
        return errorFromCatch(`entries[${i}].categoryId is required and must be a string`);
      }
      if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) {
        return errorFromCatch(`entries[${i}].amount must be a finite number (dollars)`);
      }
    }

    const planned = entries.map((e) => ({
      month: e.month,
      categoryId: e.categoryId,
      dollars: e.amount,
      cents: Math.round(e.amount * 100),
    }));

    if (args.dryRun === true) {
      const preview = planned
        .map((p) => `  ${p.month}  ${p.categoryId}  $${p.dollars.toFixed(2)}  (${p.cents} cents)`)
        .join('\n');
      return successWithJson(
        `DRY RUN - no changes written.\n\n${planned.length} budget amount(s) would be set:\n${preview}`
      );
    }

    await batchBudgetUpdates(async () => {
      for (const p of planned) {
        await setBudgetAmount(p.month, p.categoryId, p.cents);
      }
    });

    const byMonth: Record<string, number> = {};
    for (const p of planned) {
      byMonth[p.month] = (byMonth[p.month] ?? 0) + 1;
    }
    const summary = Object.keys(byMonth)
      .sort()
      .map((m) => `  ${m}: ${byMonth[m]} categor${byMonth[m] === 1 ? 'y' : 'ies'}`)
      .join('\n');

    return successWithJson(`Successfully set ${planned.length} budget amount(s):\n${summary}`);
  } catch (err) {
    return errorFromCatch(err);
  }
}
