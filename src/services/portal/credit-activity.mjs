// Display attribution without changing the immutable accounting ledger. Replace
// an original debit only when all its credits have dated allocation entries.
/**
 * @param {import('./types').LedgerEntry[]} ledger
 * @param {import('./types').WorkEntry[]} [workEntries]
 * @returns {(import('./types').LedgerEntry & {allocation?:boolean})[]}
 */
export function creditActivity(ledger, workEntries = []) {
  const allocations = new Map();
  const debits = new Map();
  for (const entry of workEntries) {
    if (entry.kind === 'allocation') {
      const entries = allocations.get(entry.task_id) || [];
      entries.push(entry);
      allocations.set(entry.task_id, entries);
    } else if (entry.kind === 'debit') debits.set(`work-entry:${entry.id}`, entry);
  }
  return ledger.flatMap(row => {
    const entries = row.kind === 'work' && row.id === `work:${row.task_id}` ? allocations.get(row.task_id) : null;
    if (entries?.length && entries.reduce((total, entry) => total + entry.credits, 0) === -row.credits) {
      return entries.map(entry => ({
        ...row, id: `allocation:${entry.id}`, credits: -entry.credits,
        note: entry.note, occurred_at: entry.occurred_at, allocation: true,
      }));
    }
    const debit = row.kind === 'work' ? debits.get(row.id) : null;
    return [{ ...row, ...(debit && debit.task_id === row.task_id ? { occurred_at: debit.occurred_at, note: debit.note } : {}) }];
  }).sort((a, b) => (b.occurred_at || b.created_at).localeCompare(a.occurred_at || a.created_at) || b.id.localeCompare(a.id));
}
