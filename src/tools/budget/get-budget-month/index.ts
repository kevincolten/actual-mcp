// ----------------------------
// GET BUDGET MONTH TOOL
// ----------------------------

import { successWithJson, errorFromCatch } from '../../../utils/response.js';
import { getBudgetMonth, getBudgetMonths } from '../../../budget-api.js';

const MONTH_RE = /^\d{4}-\d{2}$/;

export const schema = {
  name: 'get-budget-month',
  description:
    'Get the budget for a month: budgeted, spent, and balance per category, plus totals. ' +
    'Omit month to list every month that exists in the budget file.',
  inputSchema: {
    type: 'object',
    properties: {
      month: {
        type: 'string',
        description: 'Budget month in YYYY-MM format. If omitted, returns the list of available months.',
        pattern: '^\\d{4}-\\d{2}$',
      },
    },
  },
};

export async function handler(
  args: Record<string, unknown>
): Promise<ReturnType<typeof successWithJson> | ReturnType<typeof errorFromCatch>> {
  try {
    if (args.month === undefined || args.month === null || args.month === '') {
      const months = await getBudgetMonths();
      return successWithJson(months);
    }

    if (typeof args.month !== 'string' || !MONTH_RE.test(args.month)) {
      return errorFromCatch(`month must be in YYYY-MM format (got ${String(args.month)})`);
    }

    const budget = await getBudgetMonth(args.month);
    return successWithJson(budget);
  } catch (err) {
    return errorFromCatch(err);
  }
}
