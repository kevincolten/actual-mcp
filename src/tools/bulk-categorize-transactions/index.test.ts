import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler, schema } from './index.js';

vi.mock('../../actual-api.js', () => ({
  updateTransaction: vi.fn(),
}));

vi.mock('../../core/data/fetch-categories.js', () => ({
  fetchAllCategories: vi.fn(),
}));

vi.mock('../../core/data/fetch-accounts.js', () => ({
  fetchAllAccounts: vi.fn(),
}));

vi.mock('../../core/data/fetch-transactions.js', () => ({
  fetchAllTransactions: vi.fn(),
}));

import { updateTransaction } from '../../actual-api.js';
import { fetchAllCategories } from '../../core/data/fetch-categories.js';
import { fetchAllAccounts } from '../../core/data/fetch-accounts.js';
import { fetchAllTransactions } from '../../core/data/fetch-transactions.js';

const CATEGORIES = [
  { id: 'cat-coffee', name: 'Coffee', group_id: 'grp-1' },
  { id: 'cat-groceries', name: 'Groceries', group_id: 'grp-1' },
];

const ACCOUNTS = [
  { id: 'acct-1', name: 'Checking', offbudget: false, closed: false },
  { id: 'acct-2', name: 'Old Card', offbudget: false, closed: true },
];

function text(result: Awaited<ReturnType<typeof handler>>): string {
  return (result.content[0] as { text: string }).text;
}

describe('bulk-categorize-transactions tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fetchAllCategories).mockResolvedValue(CATEGORIES as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fetchAllAccounts).mockResolvedValue(ACCOUNTS as any);
    vi.mocked(fetchAllTransactions).mockResolvedValue([]);
    vi.mocked(updateTransaction).mockResolvedValue(undefined);
  });

  describe('schema', () => {
    it('should have correct name', () => {
      expect(schema.name).toBe('bulk-categorize-transactions');
      expect(schema.description).toContain('Categorize many transactions');
    });

    it('should have inputSchema defined', () => {
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe('object');
    });
  });

  describe('validation', () => {
    it('should error when neither assignments nor patterns are provided', async () => {
      const result = await handler({ dryRun: true, onlyUncategorized: true });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('at least one of');
      expect(updateTransaction).not.toHaveBeenCalled();
    });

    it('should error on an unknown category', async () => {
      const result = await handler({
        assignments: [{ transactionId: 'txn-1', category: 'Nonexistent' }],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Unknown category');
      expect(updateTransaction).not.toHaveBeenCalled();
    });

    it('should error on an invalid regex before fetching anything', async () => {
      const result = await handler({
        patterns: [{ payeeMatch: '([', category: 'Coffee', matchType: 'regex' }],
        dryRun: true,
        onlyUncategorized: true,
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Invalid regular expression');
      expect(fetchAllCategories).not.toHaveBeenCalled();
    });

    it('should error when startDate is after endDate', async () => {
      const result = await handler({
        patterns: [{ payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' }],
        startDate: '2026-05-01',
        endDate: '2026-01-01',
        dryRun: true,
        onlyUncategorized: true,
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('must not be after');
    });
  });

  describe('dry run', () => {
    it('should preview without writing', async () => {
      const result = await handler({
        assignments: [{ transactionId: 'txn-1', category: 'Coffee' }],
        dryRun: true,
        onlyUncategorized: true,
      });

      expect(result.isError).toBeUndefined();
      expect(text(result)).toContain('DRY RUN');
      expect(text(result)).toContain('1 transaction(s) would be categorized');
      expect(updateTransaction).not.toHaveBeenCalled();
    });

    it('should default to dry run when dryRun is omitted', async () => {
      const result = await handler({
        assignments: [{ transactionId: 'txn-1', category: 'Coffee' }],
        onlyUncategorized: true,
      } as Parameters<typeof handler>[0]);

      expect(text(result)).toContain('DRY RUN');
      expect(updateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('assignments', () => {
    it('should apply explicit assignments by category name', async () => {
      const result = await handler({
        assignments: [
          { transactionId: 'txn-1', category: 'Coffee' },
          { transactionId: 'txn-2', category: 'cat-groceries' },
        ],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(updateTransaction).toHaveBeenCalledTimes(2);
      expect(updateTransaction).toHaveBeenCalledWith('txn-1', { category: 'cat-coffee' });
      expect(updateTransaction).toHaveBeenCalledWith('txn-2', { category: 'cat-groceries' });
      expect(text(result)).toContain('Successfully categorized 2 transaction(s)');
    });

    it('should resolve category names case-insensitively', async () => {
      await handler({
        assignments: [{ transactionId: 'txn-1', category: 'coffee' }],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(updateTransaction).toHaveBeenCalledWith('txn-1', { category: 'cat-coffee' });
    });

    it('should report partial failures without discarding successes', async () => {
      vi.mocked(updateTransaction)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('transaction not found'));

      const result = await handler({
        assignments: [
          { transactionId: 'txn-1', category: 'Coffee' },
          { transactionId: 'txn-bad', category: 'Coffee' },
        ],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(text(result)).toContain('Categorized 1 of 2');
      expect(text(result)).toContain('transaction not found');
    });
  });

  describe('patterns', () => {
    const TRANSACTIONS = [
      { id: 'txn-a', date: '2026-07-01', amount: -540, payee_name: 'Starbucks #123', category: null },
      { id: 'txn-b', date: '2026-07-02', amount: -8210, payee_name: 'Whole Foods', category: null },
      {
        id: 'txn-c',
        date: '2026-07-03',
        amount: -320,
        payee_name: 'Starbucks Reserve',
        category: 'cat-groceries',
        category_name: 'Groceries',
      },
    ];

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fetchAllTransactions).mockResolvedValue(TRANSACTIONS as any);
    });

    it('should match uncategorized transactions by payee substring', async () => {
      const result = await handler({
        patterns: [{ payeeMatch: 'starbucks', category: 'Coffee', matchType: 'contains' }],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(updateTransaction).toHaveBeenCalledTimes(1);
      expect(updateTransaction).toHaveBeenCalledWith('txn-a', { category: 'cat-coffee' });
      expect(text(result)).toContain('Successfully categorized 1 transaction(s)');
    });

    it('should include already-categorized transactions when onlyUncategorized is false', async () => {
      await handler({
        patterns: [{ payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' }],
        dryRun: false,
        onlyUncategorized: false,
      });

      expect(updateTransaction).toHaveBeenCalledTimes(2);
      expect(updateTransaction).toHaveBeenCalledWith('txn-c', { category: 'cat-coffee' });
    });

    it('should skip closed accounts when no accountId is given', async () => {
      await handler({
        patterns: [{ payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' }],
        dryRun: true,
        onlyUncategorized: true,
      });

      const scoped = vi.mocked(fetchAllTransactions).mock.calls[0][0];
      expect(scoped.map((a) => a.id)).toEqual(['acct-1']);
    });

    it('should error when the requested accountId does not exist', async () => {
      const result = await handler({
        patterns: [{ payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' }],
        accountId: 'acct-missing',
        dryRun: true,
        onlyUncategorized: true,
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('No account found');
    });

    it('should support exact and regex match types', async () => {
      await handler({
        patterns: [{ payeeMatch: 'Whole Foods', category: 'Groceries', matchType: 'exact' }],
        dryRun: false,
        onlyUncategorized: true,
      });
      expect(updateTransaction).toHaveBeenCalledWith('txn-b', { category: 'cat-groceries' });

      vi.clearAllMocks();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fetchAllCategories).mockResolvedValue(CATEGORIES as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fetchAllAccounts).mockResolvedValue(ACCOUNTS as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fetchAllTransactions).mockResolvedValue(TRANSACTIONS as any);
      vi.mocked(updateTransaction).mockResolvedValue(undefined);

      await handler({
        patterns: [{ payeeMatch: '^starbucks\\s+#', category: 'Coffee', matchType: 'regex' }],
        dryRun: false,
        onlyUncategorized: true,
      });
      expect(updateTransaction).toHaveBeenCalledTimes(1);
      expect(updateTransaction).toHaveBeenCalledWith('txn-a', { category: 'cat-coffee' });
    });

    it('should let explicit assignments override a pattern match', async () => {
      await handler({
        patterns: [{ payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' }],
        assignments: [{ transactionId: 'txn-a', category: 'Groceries' }],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(updateTransaction).toHaveBeenCalledTimes(1);
      expect(updateTransaction).toHaveBeenCalledWith('txn-a', { category: 'cat-groceries' });
    });

    it('should skip transactions that already carry the target category', async () => {
      const result = await handler({
        patterns: [{ payeeMatch: 'Starbucks Reserve', category: 'Groceries', matchType: 'contains' }],
        dryRun: false,
        onlyUncategorized: false,
      });

      expect(updateTransaction).not.toHaveBeenCalled();
      expect(text(result)).toContain('Nothing to categorize');
    });

    it('should use the first matching pattern when several apply', async () => {
      await handler({
        patterns: [
          { payeeMatch: 'Starbucks', category: 'Coffee', matchType: 'contains' },
          { payeeMatch: 'Starbucks', category: 'Groceries', matchType: 'contains' },
        ],
        dryRun: false,
        onlyUncategorized: true,
      });

      expect(updateTransaction).toHaveBeenCalledWith('txn-a', { category: 'cat-coffee' });
    });
  });
});
