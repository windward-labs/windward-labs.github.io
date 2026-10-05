import {normalCreditsPerHour} from '../pricing.mjs';

// Stable update/entry/file IDs let a failed save resume without another charge.
export async function saveProgress({api,clientId,taskId,id,status,note,hours,occurredAt,files,pricingModel='hourly'}) {
  const credits=hours*normalCreditsPerHour;
  if(!Number.isSafeInteger(credits) || credits<0 || credits>10000)throw new Error('Enter hours in 0.25-hour increments, up to 2,500, or leave blank.');
  if(credits>0 && status==='cancelled')throw new Error('Save hours before cancelling, or leave hours blank to cancel this project.');
  const path=`/clients/${clientId}/tasks/${taskId}`;
  if(credits>0)await api(`${path}/${pricingModel==='fixed' ? 'time-entries' : 'work-entries'}`,'POST',{id,occurredAt,hours,...(pricingModel==='fixed' ? {} : {credits}),note});
  let client;
  try {
    client=await api(path,'PATCH',{id,status,note,...(occurredAt ? {occurredAt} : {})});
  } catch(error) {
    if(credits>0)throw new Error(`Hours were recorded. ${error instanceof Error ? error.message : 'Progress could not be saved.'} Retry with the same details; credits will not be deducted again.`);
    throw error;
  }
  try {
    for(const {id:fileId,file} of files)await api(`${path}/attachments/${fileId}?update=${encodeURIComponent(id)}`,'POST',file);
  } catch(error) {
    throw new Error(`Progress was saved. ${error instanceof Error ? error.message : 'An attachment could not be uploaded.'} Retry with the same details; hours, credits and the update will not be duplicated.`);
  }
  return files.length ? await api(`/clients/${clientId}`) : client;
}
