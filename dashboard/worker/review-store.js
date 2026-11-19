import { Problem,currentAuthorization } from "./domain.js";
import { metadataHash,contentHash,expectedMetadata } from "./review.js";
import { completeMetadata,generateMetadata,clipFields } from "./metadata.js";
import { uploadReadiness,prepareIntent,invalidateIntents } from "./publishing.js";
const now=()=>new Date().toISOString();
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
function row(value) {return Array.isArray(value)?value[0]:value?.results?.[0];}
export function snapshot(clip) {
  const c=clipFields(clip);
  return {title:c.title,description:c.description,hashtags:c.hashtags,opening_hook:c.opening_hook||"",
    source_attribution:c.source_attribution||"",commentary_suggestions:c.commentary_suggestions,
    metadata_version:c.metadata_version||1,media_revision:c.media_revision||0,content_sha256:c.content_sha256||null,
    review_status:c.review_status};
}
export async function appendReviewHistory(db,clip,action) {
  await db.prepare("INSERT INTO clip_review_history(id,clip_id,job_id,owner,attempt,action,metadata_hash,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),clip.id,clip.job_id,clip.owner,clip.attempt,action,await contentHash(clip),JSON.stringify(snapshot(clip)),now()).run();
}
export async function clipReviewRoute(request,env,db,c,owner,action,input) {
  if(action==="history"&&request.method==="GET") {
    return {history:(await all(db,"SELECT id,action,metadata_hash,snapshot,created_at FROM clip_review_history WHERE owner=? AND clip_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200",owner,c.id))
      .map(r=>({...r,snapshot:JSON.parse(r.snapshot)}))};
  }
  if(action==="readiness"&&request.method==="POST") {
    await expectedMetadata(input,c);
    const account=await one(db,"SELECT channel_id,connection_id,status,scopes FROM youtube_accounts WHERE owner=?",owner);
    const status=await uploadReadiness(env,db,c,c.source_authorization?JSON.parse(c.source_authorization):null,account);
    if(status.media_changed) {
      await db.prepare("UPDATE clips SET review_status='PENDING',reviewed_at=NULL,approval_hash=NULL,media_revision=media_revision+1,mutation_id=? WHERE id=? AND owner=? AND media_revision=?")
        .bind(crypto.randomUUID(),c.id,owner,c.media_revision).run();
      await invalidateIntents(db,c.id,"Stored media changed; re-review is required.");
      await db.prepare("UPDATE jobs SET state='READY_FOR_REVIEW',updated_at=? WHERE id=? AND state='APPROVED'").bind(now(),c.job_id).run();
      const changed=await one(db,"SELECT * FROM clips WHERE id=?",c.id);
      await appendReviewHistory(db,changed,"MEDIA_CHANGED");
    }
    return status;
  }
  if(action==="upload-intent"&&request.method==="POST") {
    await expectedMetadata(input,c);
    const account=await one(db,"SELECT channel_id,connection_id,status,scopes FROM youtube_accounts WHERE owner=?",owner);
    return {intent:await prepareIntent(env,db,c,c.source_authorization?JSON.parse(c.source_authorization):null,account),publishing_enabled:false};
  }
  if(!["metadata","regenerate","review"].includes(action)||request.method!=="POST")return null;
  if(!["READY_FOR_REVIEW","APPROVED"].includes(c.job_state))throw new Problem("This clip cannot be changed in its current state.",409);
  await expectedMetadata(input,c);
  let next={...c},event;
  if(action==="review") {
    if(!["APPROVED","REJECTED"].includes(input.decision))throw new Problem("Choose approve or reject.",409);
    if(input.decision==="APPROVED"&&!currentAuthorization(c.source_authorization?JSON.parse(c.source_authorization):null))throw new Problem("Source authorization expired. Review the source rights first.",409);
    next.review_status=input.decision;next.reviewed_at=now();
    next.approval_hash=input.decision==="APPROVED"?await contentHash(c):null;event=input.decision;
  } else {
    const values=action==="regenerate"?generateMetadata({transcript:c.transcript_excerpt,sourceTitle:c.title,attribution:c.source_attribution,position:c.position,variant:c.metadata_version||1}):completeMetadata(input,c);
    next={...next,...values,hashtags:JSON.stringify(values.hashtags),commentary_suggestions:values.commentary_suggestions?JSON.stringify(values.commentary_suggestions):c.commentary_suggestions,
      metadata_version:(c.metadata_version||1)+1,review_status:"PENDING",reviewed_at:null,approval_hash:null};
    event=action==="regenerate"?"REGENERATED":"EDITED";
    if(action==="metadata"&&values.title===c.title&&values.description===c.description&&JSON.stringify(values.hashtags)===c.hashtags&&values.opening_hook===c.opening_hook)
      return {saved:false,unchanged:true,metadata_hash:await metadataHash(c)};
  }
  const mutation=crypto.randomUUID(),timestamp=now();
  const batch=await db.batch([
    db.prepare("UPDATE clips SET title=?,description=?,hashtags=?,opening_hook=?,commentary_suggestions=?,metadata_version=?,metadata_method=?,review_status=?,reviewed_at=?,approval_hash=?,mutation_id=? WHERE id=? AND owner=? AND attempt=? AND metadata_version=? AND media_revision=? AND review_status=? AND reviewed_at IS ? AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=clips.job_id AND j.attempt=clips.attempt AND j.state IN ('READY_FOR_REVIEW','APPROVED')) RETURNING id")
      .bind(next.title,next.description,next.hashtags||"[]",next.opening_hook||"",next.commentary_suggestions||"[]",next.metadata_version||1,next.metadata_method||"legacy",next.review_status,next.reviewed_at,next.approval_hash,mutation,c.id,owner,c.attempt,c.metadata_version||1,c.media_revision||0,c.review_status,c.reviewed_at||null),
    db.prepare("INSERT INTO clip_review_history(id,clip_id,job_id,owner,attempt,action,metadata_hash,snapshot,created_at) SELECT ?,id,job_id,owner,attempt,?,?,?,? FROM clips WHERE id=? AND mutation_id=?")
      .bind(crypto.randomUUID(),event,await contentHash(next),JSON.stringify(snapshot(next)),timestamp,c.id,mutation),
    db.prepare("UPDATE jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM clips WHERE job_id=jobs.id AND attempt=jobs.attempt AND review_status='PENDING') AND EXISTS(SELECT 1 FROM clips WHERE job_id=jobs.id AND attempt=jobs.attempt AND review_status='APPROVED') THEN 'APPROVED' ELSE 'READY_FOR_REVIEW' END,updated_at=? WHERE id=? AND attempt=? AND EXISTS(SELECT 1 FROM clips WHERE id=? AND mutation_id=?)")
      .bind(timestamp,c.job_id,c.attempt,c.id,mutation),
    db.prepare("UPDATE upload_intents SET invalidated_at=?,state=CASE WHEN state IN ('INITIATING','UPLOADING','RECONCILING') THEN 'RECONCILING' ELSE 'INVALIDATED' END,error='Clip metadata or approval changed.',updated_at=? WHERE clip_id=? AND state NOT IN ('COMPLETED','CANCELLED') AND EXISTS(SELECT 1 FROM clips WHERE id=? AND mutation_id=? AND (review_status<>'APPROVED' OR approval_hash<>upload_intents.metadata_hash))")
      .bind(timestamp,timestamp,c.id,c.id,mutation),
    db.prepare("INSERT INTO job_events(job_id,state,message,created_at,attempt) SELECT job_id,'READY_FOR_REVIEW',?, ?,attempt FROM clips WHERE id=? AND mutation_id=?")
      .bind("Owner "+event.toLowerCase()+" clip "+c.position+". Uploads remain disabled.",timestamp,c.id,mutation)
  ]);
  if(!row(batch[0]))throw new Problem("This clip changed. Refresh before continuing.",409);
  const job=await one(db,"SELECT state FROM jobs WHERE id=?",c.job_id);
  return {saved:true,review_status:next.review_status,state:job.state,publishing_enabled:false};
}
