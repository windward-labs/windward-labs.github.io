export type Actor = { id: string; email: string; staff: boolean; automaticPayments?: boolean };
export type ClientSummary = { id: string; name: string; balance: number; active_tasks: number; created_at: string };
export type WorkStatus = 'queued' | 'in_progress' | 'completed' | 'cancelled';
export type Task = { id: string; title: string; description: string; requested_by: string; source: string; credits: number; status: WorkStatus; actor_email: string; created_at: string; updated_at: string };
export type TaskUpdate = { id: string; task_id: string; status: WorkStatus; note: string; actor_email: string; created_at: string };
export type LedgerEntry = { id: string; task_id: string | null; kind: 'purchase' | 'work' | 'refund'; credits: number; reference: string | null; note: string; actor_email: string; created_at: string };
export type ClientDetail = ClientSummary & { members: string[]; tasks: Task[]; updates: TaskUpdate[]; ledger: LedgerEntry[] };
