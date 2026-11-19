import {createHash} from "node:crypto";
import {D1} from "./d1.js";
import {api} from "../../worker/index.js";
import {generateMetadata} from "../../worker/metadata.js";
import {metadataHash} from "../../worker/review.js";
import {seal,YOUTUBE_SCOPES} from "../../worker/oauth.js";
const time=()=>new Date().toISOString();
const authorization={approved:true,attribution:"Owned source recording. Edited excerpt.",license:"owned"};
export async function fixture() {
 const DB=new D1(),bytes=Buffer.alloc(600000,17),sha=createHash("sha256").update(bytes).digest("hex");
 const env={DB,FREE_TIER_VERIFIED:"true",GOOGLE_CLIENT_ID:"mock-client",GOOGLE_CLIENT_SECRET:"mock-client-secret",
   TOKEN_ENCRYPTION_KEY:btoa("k".repeat(32)),WORKER_TOKEN:"fixture-worker",
   BUCKET:{async head(key){return key==="private/video"?{size:bytes.length,etag:"fixture-etag",customMetadata:{sha256:sha}}:{size:40,etag:"srt-etag"};}}};
 DB.db.prepare("INSERT INTO jobs(id,owner,fingerprint,source_url,source_kind,title,options,authorization,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .run("job","owner","fingerprint","https://www.youtube.com/watch?v=abcdefghijk","video","Source",JSON.stringify({count:1}),JSON.stringify(authorization),"READY_FOR_REVIEW",time(),time());
 const m=generateMetadata({transcript:"Learning improves when we test ideas. Examples make difficult ideas easier to understand.",sourceTitle:"Learning",attribution:authorization.attribution});
 DB.db.prepare("INSERT INTO clips(id,job_id,owner,attempt,position,title,description,duration,video_key,subtitle_key,hashtags,opening_hook,source_attribution,commentary_suggestions,transcript_excerpt,metadata_method,media_revision,content_sha256,media_etag,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .run("clip","job","owner",1,1,m.title,m.description,30,"private/video","private/subtitles",JSON.stringify(m.hashtags),m.opening_hook,m.source_attribution,JSON.stringify(m.commentary_suggestions),m.transcript_excerpt,m.metadata_method,1,sha,"fixture-etag",time());
 DB.db.prepare("INSERT INTO youtube_accounts(owner,channel_id,channel_title,encrypted_tokens,connected_at,connection_id,status,scopes) VALUES(?,?,?,?,?,?,?,?)")
   .run("owner","mock-channel","Mock channel",await seal(env,{refresh_token:"mock-refresh",access_token:"mock-access",expires_in:0,obtained_at:time()},"oauth:owner"),time(),"connection","CONNECTED",JSON.stringify(YOUTUBE_SCOPES));
 const row=()=>DB.db.prepare("SELECT * FROM clips WHERE id='clip'").get();
 const call=async(path,method="GET",data=null,owner="owner")=>api(new Request("https://purffle.test"+path,{method,
   headers:{"Content-Type":"application/json",...(owner?{"oai-authenticated-user-id":owner}:{}),...(!["GET","HEAD"].includes(method)?{Origin:"https://purffle.test"}:{})},
   ...(data!==null?{body:JSON.stringify(data)}:{})}),env);
 const approve=async()=>call("/api/clips/clip/review","POST",{decision:"APPROVED",expected_hash:await metadataHash(row())});
 const prepare=async()=>{await approve();return (await(await call("/api/clips/clip/upload-intent","POST",{expected_hash:await metadataHash(row())})).json()).intent;};
 return {env,DB,row,call,approve,prepare,bytes,sha};
}
