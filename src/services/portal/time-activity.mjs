// Use the same local work dates as the logging form, including around DST.
export function workDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

/** @param {import('./types').ClientDetail[]} clients @param {string} email */
export function timeActivity(clients, email) {
  return clients.flatMap(client => [...(client.workEntries || []), ...(client.timeEntries || [])].flatMap(entry => {
    if (entry.actor_email !== email || !(entry.hours > 0)) return [];
    const day = workDay(entry.occurred_at);
    if (!day) return [];
    const task = client.tasks.find(task => task.id === entry.task_id);
    return [{...entry, day, clientId:client.id, clientName:client.name, taskTitle:task?.title || 'Project'}];
  })).sort((a,b) => b.day.localeCompare(a.day) || (b.created_at || '').localeCompare(a.created_at || '') || a.id.localeCompare(b.id));
}

export function calendarMonth(month) {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(year,number-1,1,12);
  const count = new Date(year,number,0,12).getDate();
  return [
    ...Array(first.getDay()).fill(null),
    ...Array.from({length:count},(_,index)=>`${month}-${String(index+1).padStart(2,'0')}`),
  ];
}

export function shiftMonth(month, offset) {
  const [year, number] = month.split('-').map(Number);
  return workDay(new Date(year,number-1+offset,1,12)).slice(0,7);
}
