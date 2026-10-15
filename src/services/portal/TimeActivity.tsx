import { useId, useState } from 'react';
import { calendarMonth, shiftMonth, timeActivity, workDay } from './time-activity.mjs';
import type { ClientDetail } from './types';

const dayLabel = (day:string) => new Intl.DateTimeFormat('en-US',{weekday:'long',month:'short',day:'numeric',year:'numeric'}).format(new Date(`${day}T12:00:00`));
const hoursLabel = (hours:number) => `${hours} ${hours===1 ? 'hour' : 'hours'}`;

export function TimeActivity({clients,email}:{clients:ClientDetail[];email:string}) {
  const today=workDay(new Date());
  const [selected,setSelected]=useState(today);
  const [month,setMonth]=useState(today.slice(0,7));
  const detailId=useId();
  const entries=timeActivity(clients,email);
  const totals=new Map<string,number>();
  for(const entry of entries)totals.set(entry.day,(totals.get(entry.day) || 0)+entry.hours);
  const daily=entries.filter(entry=>entry.day===selected);
  const monthly=entries.filter(entry=>entry.day.startsWith(month)).reduce((sum,entry)=>sum+entry.hours,0);
  const selectDay=(day:string)=>{setSelected(day);setMonth(day.slice(0,7));};
  const move=(offset:number)=>{const next=shiftMonth(month,offset);setMonth(next);setSelected(next===today.slice(0,7) ? today : `${next}-01`);};
  return <section className="portal-time-activity stack" aria-label="Your logged time">
    <div className="row"><div><h3>Your logged time</h3><p className="caption muted">{hoursLabel(totals.get(today) || 0)} today · Your local time zone</p></div><button type="button" className="plain-button" onClick={()=>selectDay(today)}>Today</button></div>
    <div className="portal-time-layout">
      <div className="stack">
        <div className="row"><button type="button" className="plain-button" aria-label="Previous month" onClick={()=>move(-1)}>←</button><div className="portal-time-month"><strong>{new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(new Date(`${month}-01T12:00:00`))}</strong><p className="caption muted">{hoursLabel(monthly)} logged</p></div><button type="button" className="plain-button" aria-label="Next month" disabled={month>=today.slice(0,7)} onClick={()=>move(1)}>→</button></div>
        <div className="portal-time-calendar" role="group" aria-label="Choose a work date">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=><span className="caption muted" key={day}>{day}</span>)}
          {calendarMonth(month).map((day:string|null,index:number)=>day ? <button key={day} type="button" className="portal-time-day" data-level={Math.min(4,Math.ceil((totals.get(day) || 0)/2))} aria-pressed={selected===day} aria-current={day===today ? 'date' : undefined} aria-controls={detailId} aria-label={`${dayLabel(day)}: ${hoursLabel(totals.get(day) || 0)} logged`} title={`${dayLabel(day)}: ${hoursLabel(totals.get(day) || 0)}`} disabled={day>today} onClick={()=>selectDay(day)}>{Number(day.slice(-2))}</button> : <span key={`empty-${index}`}/>)}
        </div>
        <p className="caption muted">Darker days = more hours. Select a day to see its entries.</p>
      </div>
      <div id={detailId} className="stack" aria-live="polite" aria-atomic="true">
        <div><h4>{selected===today ? 'Today' : dayLabel(selected)}</h4><p className="caption muted">{hoursLabel(totals.get(selected) || 0)} logged · {daily.length} {daily.length===1 ? 'entry' : 'entries'}</p></div>
        {daily.length ? <ul className="portal-time-entries">{daily.map(entry=><li key={`${entry.clientId}-${entry.id}`}><div className="row"><a href={`/service/project/?id=${encodeURIComponent(entry.clientId)}&project=${encodeURIComponent(entry.task_id)}`}>{entry.taskTitle}</a><strong>{entry.hours}h</strong></div><p className="caption muted">{entry.clientName}</p><p className="portal-description">{entry.note}</p></li>)}</ul> : <div className="stack"><p className="muted">No time logged for this day.</p>{entries[0] && <div><button type="button" className="plain-button" onClick={()=>selectDay(entries[0].day)}>View most recent · {dayLabel(entries[0].day)}</button></div>}</div>}
      </div>
    </div>
  </section>;
}
