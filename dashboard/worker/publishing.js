import { Problem,currentAuthorization } from "./domain.js";
import { approvalValid,contentHash } from "./review.js";
import { clipFields } from "./metadata.js";
import { YOUTUBE_SCOPES,oauthConfigured } from "./oauth.js";
import { charge } from "./generation.js";
export const LIVE_UPLOADS_ENABLED=false; // A separate, explicit user authorization and audited rollout are required.
const now=()=>new Date().toISOString();
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
export function publicIntent(i) {
  return {id:i.id,clip_id:i.clip_id,job_id:i.job_id,channel_id:i.channel_id,state:i.state,
    media_revision:i.media_revision,acknowledged_bytes:i.acknowledged_bytes,total_bytes:i.total_bytes,
    remote_video_id:i.remote_video_id||null,error:i.error||null,created_at:i.created_at,updated_at:i.updated_at,
    invalidated:!!i.invalidated_at,execution_authorized:false};
}
export async function uploadReadiness(env,db,clip,authorization,account) {
  const blockers=[];
  if(!await approvalValid(clip)) blockers.push("Approve the current metadata and video revision.");
  if(!currentAuthorization(authorization)) blockers.push("Record current source authorization.");
  if(!oauthConfigured(env)) blockers.push("Google OAuth server configuration is incomplete.");
  let scopes=[];try{scopes=JSON.parse(account?.scopes||"[]");}catch{}
  if(!account?.connection_id||account.status!=="CONNECTED"||!YOUTUBE_SCOPES.every(s=>scopes.includes(s)))
    blockers.push("Connect YouTube with upload and channel-read permissions.");
  const created=Date.parse(clip.created_at||"");
  if(!Number.isFinite(created)||created>Date.now()||Date.now()-created>=7*86400000) blockers.push("Media retention has expired.");
  if(!/^[a-f0-9]{64}$/.test(clip.content_sha256||"")||!clip.media_etag||clip.media_revision<1)
    blockers.push("The video needs a recorded content fingerprint from an authorized worker.");
  let media_verified=false,total_bytes=0,changed=false;
  if(env.FREE_TIER_VERIFIED!=="true"||!env.BUCKET) blockers.push("Verify private storage allowances and binding before checking media.");
  else if(clip.video_key&&clip.subtitle_key) {
    await charge(db,"r2-read",10000);
    const video=await env.BUCKET.head(clip.video_key);
    await charge(db,"r2-read",10000);
    const subtitles=await env.BUCKET.head(clip.subtitle_key);
    const etag=video?.etag||video?.httpEtag;
    if(!video||!subtitles) blockers.push("Private video or subtitles are missing.");
    else if(!Number.isSafeInteger(video.size)||video.size<1||video.size>25*1024*1024) blockers.push("Video size is outside the prepared upload limits.");
    else if(!etag||etag!==clip.media_etag||video.customMetadata?.sha256!==clip.content_sha256) {
      blockers.push("Stored video changed or cannot be matched to its approved fingerprint."); changed=true;
    } else { media_verified=true;total_bytes=video.size; }
  } else blockers.push("Both private video and subtitle files are required.");
  const account_ready=!!account?.connection_id&&account.status==="CONNECTED"&&YOUTUBE_SCOPES.every(s=>scopes.includes(s));
  return {preparation_ready:blockers.length===0,upload_enabled:LIVE_UPLOADS_ENABLED,execution_authorized:false,
    blockers,media_verified,total_bytes,account_ready,media_changed:changed,
    upload_blocker:"Live uploads require separate explicit authorization and remain disabled."};
}
export async function invalidateIntents(db,clipId,reason) {
  await run(db,"UPDATE upload_intents SET invalidated_at=?,state=CASE WHEN state IN ('INITIATING','UPLOADING','RECONCILING') THEN 'RECONCILING' ELSE 'INVALIDATED' END,error=?,updated_at=? WHERE clip_id=? AND state NOT IN ('COMPLETED','CANCELLED')",now(),reason,now(),clipId);
}
export async function prepareIntent(env,db,clip,authorization,account) {
  const ready=await uploadReadiness(env,db,clip,authorization,account);
  if(!ready.preparation_ready) throw new Problem(ready.blockers.join(" "),409);
  const fingerprint=await contentHash(clip),c=clipFields(clip),timestamp=now(),id=crypto.randomUUID();
  const metadata={title:c.title,description:c.description,hashtags:c.hashtags,
    source_attribution:c.source_attribution,opening_hook:c.opening_hook,privacyStatus:"private"};
  await run(db,"INSERT INTO upload_intents(id,owner,clip_id,job_id,channel_id,connection_id,metadata_hash,media_revision,content_sha256,metadata,total_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,clip_id,channel_id,media_revision) DO NOTHING",
    id,c.owner,c.id,c.job_id,account.channel_id,account.connection_id,fingerprint,c.media_revision,c.content_sha256,JSON.stringify(metadata),ready.total_bytes,timestamp,timestamp);
  let intent=await one(db,"SELECT * FROM upload_intents WHERE owner=? AND clip_id=? AND channel_id=? AND media_revision=?",c.owner,c.id,account.channel_id,c.media_revision);
  if(intent.state==="INVALIDATED"&&!intent.session_blob&&intent.acknowledged_bytes===0) {
    await run(db,"UPDATE upload_intents SET metadata_hash=?,metadata=?,connection_id=?,state='PREPARED',invalidated_at=NULL,error=NULL,total_bytes=?,updated_at=? WHERE id=? AND state='INVALIDATED' AND session_blob IS NULL AND acknowledged_bytes=0",fingerprint,JSON.stringify(metadata),account.connection_id,ready.total_bytes,now(),intent.id);
    intent=await one(db,"SELECT * FROM upload_intents WHERE id=?",intent.id);
  }
  if(intent.metadata_hash!==fingerprint||intent.connection_id!==account.connection_id)
    throw new Problem("An earlier intent must be reconciled before this clip can be prepared again.",409);
  if(intent.id===id) await run(db,"INSERT INTO upload_events(id,intent_id,owner,state,message,created_at) VALUES(?,?,?,'PREPARED','Owner prepared an approved clip. No upload was authorized or started.',?)",crypto.randomUUID(),id,c.owner,timestamp);
  return publicIntent(intent);
}
