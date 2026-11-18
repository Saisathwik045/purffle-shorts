// Future publishing transport and durable engine. No production route calls this module.
// Tests inject mock HTTP and storage. There is deliberately no default network client.
import { Problem,currentAuthorization } from "./domain.js";
import { contentHash,approvalValid } from "./review.js";
import { seal,unseal } from "./oauth.js";
const now=()=>new Date().toISOString();
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
export const CHUNK_BYTES=256*1024;
export function sessionURL(value) {
  const u=new URL(value);
  if(u.protocol!=="https:"||!["www.googleapis.com","youtube.googleapis.com"].includes(u.hostname)||u.username||u.password||u.port||u.hash||u.pathname!=="/upload/youtube/v3/videos")
    throw new Problem("Invalid resumable upload session.",502);
  return u.href;
}
function acknowledged(response,total) {
  const range=response.headers.get("range");
  if(!range)return 0;
  const match=/^bytes=0-(\d+)$/.exec(range);
  const value=match?Number(match[1])+1:NaN;
  if(!Number.isSafeInteger(value)||value<0||value>total)throw new Problem("Invalid upload acknowledgement.",502);
  return value;
}
export class YouTubeResumableClient {
  constructor(request,token) {
    if(typeof request!=="function"||typeof token!=="string"||!token)throw new Problem("An explicitly authorized transport is required.",403);
    this.request=request;this.token=token;
  }
  async send(url,init) {
    return this.request(url,{...init,redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{...init.headers,Authorization:"Bearer "+this.token}});
  }
  async initiate(metadata,total) {
    const description=[metadata.description,metadata.source_attribution&&!metadata.description.includes(metadata.source_attribution)?"Source attribution: "+metadata.source_attribution:"",
      (metadata.hashtags||[]).join(" ")].filter(Boolean).join("\n\n");
    if([...description].length>5000)throw new Problem("Combined publishing description exceeds 5,000 characters.",409);
    const response=await this.send("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",{
      method:"POST",headers:{"Content-Type":"application/json; charset=UTF-8","X-Upload-Content-Length":String(total),"X-Upload-Content-Type":"video/mp4"},
      body:JSON.stringify({snippet:{title:metadata.title,description},status:{privacyStatus:"private"}})});
    if(!response.ok)throw new Problem("Upload session could not be established.",response.status===401?401:502);
    return sessionURL(response.headers.get("location")||"");
  }
  async result(response,total) {
    if(response.status===308)return {done:false,offset:acknowledged(response,total)};
    if(response.status===200||response.status===201) {
      const data=await response.json();
      if(!/^[\w-]{11}$/.test(data.id||""))throw new Problem("Upload completion could not be confirmed.",502);
      return {done:true,offset:total,video_id:data.id};
    }
    if(response.status===404||response.status===410)throw new Problem("Upload session is unavailable; manual reconciliation is required.",410);
    if(response.status===401||response.status===403)throw new Problem("YouTube authorization must be checked before resuming.",401);
    throw new Problem("Upload response is unconfirmed; reconcile before sending more bytes.",502);
  }
  async status(url,total) {return this.result(await this.send(sessionURL(url),{method:"PUT",headers:{"Content-Length":"0","Content-Range":"bytes */"+total}}),total);}
  async chunk(url,bytes,offset,total) {
    if(!bytes.length||bytes.length>CHUNK_BYTES||offset<0||offset+bytes.length>total||
      (offset+bytes.length<total&&bytes.length%CHUNK_BYTES!==0))throw new Problem("Invalid upload chunk.",409);
    return this.result(await this.send(sessionURL(url),{method:"PUT",headers:{"Content-Length":String(bytes.length),
      "Content-Type":"video/mp4","Content-Range":"bytes "+offset+"-"+(offset+bytes.length-1)+"/"+total},body:bytes}),total);
  }
}
async function event(db,i,state,message) {
  await run(db,"INSERT INTO upload_events(id,intent_id,owner,state,message,created_at) VALUES(?,?,?,?,?,?)",crypto.randomUUID(),i.id,i.owner,state,message,now());
}
// Single resumable step. A runner must supply an authorized adapter after a future user-approved rollout.
export async function advanceIntent(env,db,id,transport,readChunk) {
  let i=await one(db,"SELECT * FROM upload_intents WHERE id=?",id);
  if(!i)throw new Problem("Upload intent not found.",404);
  if(i.state==="COMPLETED")return {state:i.state,video_id:i.remote_video_id};
  if(["CANCELLED","INVALIDATED","REQUIRES_REVIEW"].includes(i.state))throw new Problem("This upload intent needs owner review.",409);
  if(i.retry_at&&Date.parse(i.retry_at)>Date.now())throw new Problem("Wait before reconciling this upload.",429);
  const claim=crypto.randomUUID();
  const locked=await one(db,"UPDATE upload_intents SET lease_id=?,lease_expires=? WHERE id=? AND (lease_id IS NULL OR lease_expires<?) RETURNING *",
    claim,new Date(Date.now()+120000).toISOString(),id,now());
  if(!locked)throw new Problem("An upload step is already running.",409);
  i=locked;
  const update=async(state,error=null)=>run(db,"UPDATE upload_intents SET state=?,error=?,updated_at=? WHERE id=? AND lease_id=?",state,error,now(),id,claim);
  const finish=async(result)=>{
    const clip=await one(db,"SELECT * FROM clips WHERE id=?",i.clip_id);
    const valid=clip&&await approvalValid(clip)&&await contentHash(clip)===i.metadata_hash;
    await db.batch([
      db.prepare("UPDATE upload_intents SET state='COMPLETED',acknowledged_bytes=total_bytes,remote_video_id=?,error=?,updated_at=? WHERE id=? AND lease_id=?").bind(result.video_id,valid?null:"Upload completed for an earlier approved revision; current clip requires review.",now(),id,claim),
      db.prepare("INSERT INTO publications(id,clip_id,owner,state,youtube_id,created_at,published_at,upload_intent_id,channel_id) SELECT ?,?,?,'PUBLISHED',?,?,?,?,? FROM upload_intents WHERE id=? AND lease_id=? AND state='COMPLETED' ON CONFLICT(upload_intent_id) DO NOTHING").bind(crypto.randomUUID(),i.clip_id,i.owner,result.video_id,i.created_at,now(),id,i.channel_id,id,claim),
      db.prepare("INSERT INTO upload_events(id,intent_id,owner,state,message,created_at) SELECT ?,?,?,'COMPLETED','Remote video ID confirmed; recorded once.',? FROM upload_intents WHERE id=? AND lease_id=? AND state='COMPLETED'").bind(crypto.randomUUID(),id,i.owner,now(),id,claim)
    ]);
    return {state:"COMPLETED",video_id:result.video_id};
  };
  try {
    const clip=await one(db,"SELECT c.*,j.authorization AS source_authorization,j.attempt AS current_attempt FROM clips c JOIN jobs j ON j.id=c.job_id WHERE c.id=? AND c.owner=?",i.clip_id,i.owner);
    const account=await one(db,"SELECT connection_id,status FROM youtube_accounts WHERE owner=?",i.owner);
    const mediaCurrent=typeof readChunk.verify==="function"&&await readChunk.verify(i);
    const current=mediaCurrent&&clip&&clip.attempt===clip.current_attempt&&await approvalValid(clip)&&await contentHash(clip)===i.metadata_hash&&
      currentAuthorization(JSON.parse(clip.source_authorization||"null"))&&account?.connection_id===i.connection_id&&account.status==="CONNECTED"&&!i.invalidated_at;
    if(!current) {
      // Never send another media chunk after approval/account/content changes.
      if(i.session_blob) {
        const {url}=await unseal(env,i.session_blob,"upload:"+i.owner+":"+id);
        const result=await transport.status(url,i.total_bytes);
        if(result.done)return await finish(result);
      }
      await update("REQUIRES_REVIEW","Approval, content, source rights or channel connection changed.");
      return {state:"REQUIRES_REVIEW"};
    }
    if(i.state==="PREPARED") {
      // Persist ambiguity BEFORE the side effect. A lost initiation response is never blindly replayed.
      await update("INITIATING");
      await event(db,i,"INITIATING","Beginning one resumable session.");
      const url=await transport.initiate(JSON.parse(i.metadata),i.total_bytes);
      await run(db,"UPDATE upload_intents SET session_blob=?,state='UPLOADING',updated_at=? WHERE id=? AND lease_id=?",
        await seal(env,{url},"upload:"+i.owner+":"+id),now(),id,claim);
      return {state:"UPLOADING",offset:0};
    }
    if(!i.session_blob) {
      await update("REQUIRES_REVIEW","Session initiation was interrupted. Do not start another upload automatically.");
      return {state:"REQUIRES_REVIEW"};
    }
    const {url}=await unseal(env,i.session_blob,"upload:"+i.owner+":"+id);
    // Always ask the remote session first, including after process restart or a lost chunk response.
    const status=await transport.status(url,i.total_bytes);
    if(status.done)return await finish(status);
    if(status.offset<i.acknowledged_bytes||status.offset>i.total_bytes)throw new Problem("Remote progress is inconsistent.",409);
    await run(db,"UPDATE upload_intents SET acknowledged_bytes=?,state='UPLOADING',retry_at=NULL WHERE id=? AND lease_id=?",status.offset,id,claim);
    if(status.offset===i.total_bytes) {
      await update("RECONCILING","All bytes acknowledged; waiting for a confirmed video ID.");
      return {state:"RECONCILING"};
    }
    const bytes=await readChunk(status.offset,Math.min(CHUNK_BYTES,i.total_bytes-status.offset));
    if(bytes.length!==Math.min(CHUNK_BYTES,i.total_bytes-status.offset))throw new Problem("Stored media length changed.",409);
    const result=await transport.chunk(url,bytes,status.offset,i.total_bytes);
    if(result.done)return await finish(result);
    if(result.offset<status.offset||result.offset>status.offset+bytes.length)throw new Problem("Invalid chunk progress.",409);
    await run(db,"UPDATE upload_intents SET acknowledged_bytes=?,state='UPLOADING',error=NULL,updated_at=? WHERE id=? AND lease_id=?",result.offset,now(),id,claim);
    return {state:"UPLOADING",offset:result.offset};
  } catch(error) {
    const state=error.status===410||error.status===409||i.attempts>=4?"REQUIRES_REVIEW":error.status===401?"AUTHORIZATION_REQUIRED":i.state==="PREPARED"?"REQUIRES_REVIEW":"RECONCILING";
    await run(db,"UPDATE upload_intents SET attempts=attempts+1 WHERE id=? AND lease_id=?",id,claim);
    await update(state,state==="REQUIRES_REVIEW"?"Manual reconciliation is required; no duplicate upload will be started.":"Remote progress or authorization is unconfirmed. Reconcile before continuing.");
    await run(db,"UPDATE upload_intents SET retry_at=? WHERE id=? AND lease_id=?",new Date(Date.now()+30000).toISOString(),id,claim);
    await event(db,i,state,"Upload step paused safely. Credentials and session URLs are omitted.");
    return {state};
  } finally {
    await run(db,"UPDATE upload_intents SET lease_id=NULL,lease_expires=NULL WHERE id=? AND lease_id=?",id,claim);
  }
}
