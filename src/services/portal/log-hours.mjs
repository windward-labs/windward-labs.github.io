import { normalCreditsPerHour } from '../pricing.mjs';
import { saveProgress } from './save-progress.mjs';

export function canLogHours(task) {
  return task.status !== 'cancelled' && (task.pricing_model === 'fixed' || task.billing_mode === 'entries');
}

// A time entry alone: no status change, progress update, attachment, or milestone charge.
export async function logHours({ api, clientId, task, id, hours, occurredAt, note }) {
  if (!canLogHours(task)) throw new Error('Open this project to resolve its original time allocation before logging hours.');
  const credits = hours * normalCreditsPerHour;
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(credits) || credits > 10000) throw new Error('Enter hours in 0.25-hour increments, up to 2,500.');
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt) > Date.now()) throw new Error('Choose a work date that is not in the future.');
  const fixed = task.pricing_model === 'fixed';
  return api(`/clients/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(task.id)}/${fixed ? 'time-entries' : 'work-entries'}`, 'POST', {
    id, hours, occurredAt, note: note.trim() || `Work on ${task.title}`, ...(fixed ? {} : { credits }),
  });
}

/** @param {import('./types').ClientDetail[]} clients @param {string} email */
export function staffProjects(clients, email) {
  return clients.flatMap(client => client.tasks.map(task => {
    const entries = [...(client.workEntries || []), ...(client.timeEntries || [])]
      .filter(entry => entry.task_id === task.id && entry.actor_email === email);
    const recent = entries.reduce((latest, entry) => Math.max(latest, Date.parse(entry.created_at || entry.occurred_at) || 0), 0);
    const frequencies = new Map();
    for (const entry of entries) frequencies.set(entry.hours, (frequencies.get(entry.hours) || 0) + 1);
    const frequent = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    return { client, task, recent, frequent };
  })).sort((a, b) => b.recent - a.recent || a.client.name.localeCompare(b.client.name) || a.task.title.localeCompare(b.task.title));
}

export function validateWorkLog({task,hours,note,occurredAt}) {
  if(!canLogHours(task))throw new Error('Choose a project that can accept hours.');
  const credits=hours*normalCreditsPerHour;
  if(!Number.isFinite(hours) || hours<=0 || !Number.isSafeInteger(credits) || credits>10000)throw new Error('Enter hours in 0.25-hour increments, up to 2,500.');
  if(!note.trim() || note.trim().length>2000)throw new Error('Describe your work in up to 2,000 characters.');
  if(!occurredAt || !Number.isFinite(Date.parse(occurredAt)) || Date.parse(occurredAt)>Date.now())throw new Error('Choose a work date that is not in the future.');
}

export async function saveWorkLog({api,clientId,task,id,hours,note,occurredAt,files}) {
  validateWorkLog({task,hours,note,occurredAt});
  await logHours({api,clientId,task,id,hours,note,occurredAt});
  try {
    // Omit status: the server preserves the current project status, even after a retry.
    return await saveProgress({api,clientId,taskId:task.id,id,status:undefined,note,hours:0,occurredAt,files,pricingModel:task.pricing_model});
  } catch(error) {
    throw new Error(`Hours were recorded. ${error instanceof Error ? error.message : 'The work summary could not be saved.'}`);
  }
}
