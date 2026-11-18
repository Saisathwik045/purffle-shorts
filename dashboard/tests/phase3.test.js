import test from "node:test";
import assert from "node:assert/strict";
import {generateMetadata} from "../worker/metadata.js";
import {contentHash,metadataHash} from "../worker/review.js";
import {startOAuth,finishOAuth,disconnectOAuth,accessToken,seal,unseal,YOUTUBE_SCOPES} from "../worker/oauth.js";
import {advanceIntent,YouTubeResumableClient,CHUNK_BYTES} from "../worker/youtube-resumable.js";
import {fixture} from "./support/phase3-fixture.js";
test("deterministic metadata supplies all six fields without paid APIs",()=>{
 const input={transcript:"Testing ideas improves learning. Testing ideas needs evidence.",sourceTitle:"Learning",attribution:"Owned recording"};
 const a=generateMetadata(input);
 assert.deepEqual(a,generateMetadata(input));
 assert(a.title&&a.description&&a.hashtags.length&&a.opening_hook&&a.source_attribution&&a.commentary_suggestions.length);
 assert.equal(a.metadata_method,"deterministic-extractive-v1");
 assert(a.commentary_notice.includes("No original commentary"));
 assert(generateMetadata({sourceTitle:"Source",position:2}).title.includes("Excerpt 2"));
 assert(generateMetadata({transcript:"x".repeat(200)}).hashtags.every(t=>[...t].length<=41));
});
test("metadata, hashtags, regeneration and approval history persist",async()=>{
 const x=await fixture();await x.approve();assert(x.row().approval_hash);
 const before=await metadataHash(x.row());
 await x.call("/api/clips/clip/metadata","POST",{title:"Edited title",description:"Owner description",hashtags:["#Shorts","#Learning"],opening_hook:"Test your ideas",expected_hash:before});
 assert.equal(x.row().review_status,"PENDING");assert.equal(x.row().approval_hash,null);
 assert.deepEqual(JSON.parse(x.row().hashtags),["#Shorts","#Learning"]);
 await assert.rejects(x.call("/api/clips/clip/review","POST",{decision:"APPROVED",expected_hash:before}),e=>e.status===409);
 await x.call("/api/clips/clip/regenerate","POST",{expected_hash:await metadataHash(x.row())});
 assert.equal(x.row().metadata_version,3);assert.equal(x.row().review_status,"PENDING");
 const history=await(await x.call("/api/clips/clip/history")).json();
 assert.deepEqual(history.history.map(e=>e.action).sort(),["APPROVED","EDITED","REGENERATED"].sort());
 assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM publications").get().n,0);
 await assert.rejects(x.call("/api/clips/clip/history","GET",null,"other"),e=>e.status===404);
});
test("intent preparation is idempotent, content-bound and never enables uploads",async()=>{
 const x=await fixture(),a=await x.prepare();
 const b=await(await x.call("/api/clips/clip/upload-intent","POST",{expected_hash:await metadataHash(x.row())})).json();
 assert.equal(a.id,b.intent.id);assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM upload_intents").get().n,1);
 x.env.PUBLISHING_ENABLED="true";x.env.UPLOADS_ENABLED="true";
 await assert.rejects(x.call("/api/clips/clip/publish","POST",{}),e=>e.status===403);
 await assert.rejects(x.call("/api/upload-intents/"+a.id+"/execute","POST",{}),e=>e.status===403||e.status===404);
 await x.call("/api/clips/clip/metadata","POST",{title:"New revision",description:"Changed",expected_hash:await metadataHash(x.row())});
 assert.equal(x.DB.db.prepare("SELECT state FROM upload_intents").get().state,"INVALIDATED");
 await x.approve();
 const next=await(await x.call("/api/clips/clip/upload-intent","POST",{expected_hash:await metadataHash(x.row())})).json();
 assert.equal(next.intent.id,a.id);assert.equal(next.intent.state,"PREPARED");
 await assert.rejects(x.call("/api/upload-intents/"+a.id,"GET",null,"other"),e=>e.status===404);
 const ready=await(await x.call("/api/clips/clip/readiness","POST",{expected_hash:await metadataHash(x.row())})).json();
 assert(ready.preparation_ready&&ready.media_verified);assert.equal(ready.upload_enabled,false);
});
test("changed stored video invalidates approval and existing intent",async()=>{
 const x=await fixture();await x.prepare();
 x.env.BUCKET.head=async()=>({size:600000,etag:"changed",customMetadata:{sha256:"b".repeat(64)}});
 const ready=await(await x.call("/api/clips/clip/readiness","POST",{expected_hash:await metadataHash(x.row())})).json();
 assert(ready.media_changed);assert.equal(x.row().review_status,"PENDING");assert.equal(x.row().approval_hash,null);
 assert.equal(x.DB.db.prepare("SELECT state FROM upload_intents").get().state,"INVALIDATED");
});
test("resumable upload reconciles a lost chunk response and records one publication",async()=>{
 const x=await fixture(),intent=await x.prepare();let ack=0,initializations=0,lost=true,chunkCalls=0;
 const transport=new YouTubeResumableClient(async(url,init)=>{
   if(init.method==="POST"){initializations++;return new Response(null,{status:200,headers:{Location:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=private-session"}});}
   if(init.headers["Content-Range"].startsWith("bytes */"))return ack===x.bytes.length?Response.json({id:"abcdefghijk"}):new Response(null,{status:308,headers:ack?{Range:"bytes=0-"+(ack-1)}:{}});
   const m=/bytes (\d+)-(\d+)\/(\d+)/.exec(init.headers["Content-Range"]);
   assert.equal(Number(m[1]),ack);chunkCalls++;ack=Number(m[2])+1;
   if(lost){lost=false;throw new Error("response lost after remote commit");}
   return ack===x.bytes.length?Response.json({id:"abcdefghijk"},{status:201}):new Response(null,{status:308,headers:{Range:"bytes=0-"+(ack-1)}});
 },"mock-access");
 const read=async(offset,length)=>x.bytes.subarray(offset,offset+length);read.verify=async()=>true;
 assert.equal((await advanceIntent(x.env,x.DB,intent.id,transport,read)).state,"UPLOADING");
 assert.equal((await advanceIntent(x.env,x.DB,intent.id,transport,read)).state,"RECONCILING");
 x.DB.db.prepare("UPDATE upload_intents SET retry_at=NULL").run();
 for(let k=0;k<5;k++){const r=await advanceIntent(x.env,x.DB,intent.id,transport,read);if(r.state==="COMPLETED")break;}
 assert.equal(x.DB.db.prepare("SELECT state FROM upload_intents").get().state,"COMPLETED");
 assert.equal(initializations,1);assert.equal(chunkCalls,3);
 assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM publications").get().n,1);
 await advanceIntent(x.env,x.DB,intent.id,transport,read);
 assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM publications").get().n,1);
 const publicData=JSON.stringify(await(await x.call("/api/upload-intents/"+intent.id)).json());
 assert(!publicData.includes("private-session")&&!publicData.includes("session_blob")&&!publicData.includes("mock-access"));
});
test("ambiguous initiation never starts a second session",async()=>{
 const x=await fixture(),intent=await x.prepare();let calls=0;
 const transport={async initiate(){calls++;throw new Error("unknown acceptance");}};
 const read=async()=>Buffer.alloc(0);read.verify=async()=>true;
 const r=await advanceIntent(x.env,x.DB,intent.id,transport,read);assert.equal(r.state,"REQUIRES_REVIEW");
 await assert.rejects(advanceIntent(x.env,x.DB,intent.id,transport,read));
 assert.equal(calls,1);assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM publications").get().n,0);
});
test("unavailable sessions and revoked approvals stop media transmission",async()=>{
 const x=await fixture(),intent=await x.prepare();let chunks=0;
 const transport={async initiate(){return "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=session";},
   async status(){return {done:false,offset:0};},async chunk(){chunks++;return {done:false,offset:CHUNK_BYTES};}};
 const read=async(o,n)=>x.bytes.subarray(o,o+n);read.verify=async()=>true;
 await advanceIntent(x.env,x.DB,intent.id,transport,read);
 await x.call("/api/clips/clip/review","POST",{decision:"REJECTED",expected_hash:await metadataHash(x.row())});
 assert.equal((await advanceIntent(x.env,x.DB,intent.id,transport,read)).state,"REQUIRES_REVIEW");
 assert.equal(chunks,0);
});
test("OAuth uses owner-bound state and PKCE; secrets never enter owner API",async()=>{
 const x=await fixture();x.DB.db.exec("DELETE FROM youtube_accounts");
 const started=await startOAuth(x.env,x.DB,"owner","https://purffle.test");
 const url=new URL(started.headers.get("location")),state=url.searchParams.get("state");
 assert.equal(url.hostname,"accounts.google.com");assert.equal(url.searchParams.get("code_challenge_method"),"S256");
 const saved=x.DB.db.prepare("SELECT * FROM oauth_states").get();assert(saved.verifier_blob&&!saved.verifier_blob.includes("verifier"));
 const send=async(url,init)=>{
   if(url.includes("/token")){assert(new URLSearchParams(init.body).get("code_verifier"));return Response.json({access_token:"secret-access",refresh_token:"secret-refresh",scope:YOUTUBE_SCOPES.join(" "),expires_in:3600});}
   return Response.json({items:[{id:"channel",snippet:{title:"Channel"}}]});
 };
 const callback=new URL("https://purffle.test/api/youtube/callback?state="+state+"&code=mock-code");
 await assert.rejects(finishOAuth(x.env,x.DB,"other",callback,send),e=>e.status===403);
 const completed=await finishOAuth(x.env,x.DB,"owner",callback,send);assert.equal(completed.status,302);
 const row=x.DB.db.prepare("SELECT * FROM youtube_accounts").get();
 assert(!row.encrypted_tokens.includes("secret-refresh"));
 const boot=JSON.stringify(await(await x.call("/api/bootstrap")).json());assert(!boot.includes("secret-refresh")&&!boot.includes("secret-access")&&!boot.includes("encrypted_tokens"));
 await assert.rejects(finishOAuth(x.env,x.DB,"owner",callback,send),e=>e.status===403);
});
test("refresh rotation and disconnect do not resurrect credentials",async()=>{
 const x=await fixture();
 const token=await accessToken(x.env,x.DB,"owner","connection",async()=>Response.json({access_token:"refreshed-access",expires_in:3600}));
 assert.equal(token,"refreshed-access");
 const account=x.DB.db.prepare("SELECT * FROM youtube_accounts").get();
 const tokens=await unseal(x.env,account.encrypted_tokens,"oauth:owner");
 assert.equal(tokens.refresh_token,"mock-refresh");
 await assert.rejects(unseal(x.env,account.encrypted_tokens,"oauth:other"));
 await x.prepare();
 const gone=await disconnectOAuth(x.env,x.DB,"owner",async()=>new Response(null,{status:200}));
 assert(gone.disconnected&&gone.remote_revocation_confirmed);
 assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM youtube_accounts").get().n,0);
 assert.equal(x.DB.db.prepare("SELECT state FROM upload_intents").get().state,"INVALIDATED");
});
test("disconnect cancels an OAuth callback already exchanging its code",async()=>{
 const x=await fixture();const start=await startOAuth(x.env,x.DB,"owner","https://purffle.test");
 const state=new URL(start.headers.get("location")).searchParams.get("state");
 const send=async(url)=>{
  if(url.includes("/token")){
   await disconnectOAuth(x.env,x.DB,"owner",async()=>new Response(null,{status:200}));
   return Response.json({access_token:"late-access",refresh_token:"late-refresh",scope:YOUTUBE_SCOPES.join(" "),expires_in:3600});
  }
  return Response.json({items:[{id:"late-channel",snippet:{title:"Late"}}]});
 };
 await assert.rejects(finishOAuth(x.env,x.DB,"owner",new URL("https://purffle.test/api/youtube/callback?state="+state+"&code=code"),send),e=>e.status===409);
 assert.equal(x.DB.db.prepare("SELECT COUNT(*) n FROM youtube_accounts").get().n,0);
});

test("resumable transport rejects unsafe session locations and expired sessions",async()=>{
 const denied=new YouTubeResumableClient(async()=>new Response(null,{status:200,headers:{Location:"https://attacker.test/upload/youtube/v3/videos?token=secret"}}),"mock-token");
 await assert.rejects(denied.initiate({title:"Test",description:"",hashtags:[]},100),e=>e.status===502);
 const expired=new YouTubeResumableClient(async()=>new Response(null,{status:410}),"mock-token");
 await assert.rejects(expired.status("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=old",100),e=>e.status===410);
});
test("active intent lease prevents duplicate concurrent initiation",async()=>{
 const x=await fixture(),intent=await x.prepare();let release,entered;
 const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);let count=0;
 const transport={async initiate(){count++;entered();await waiting;return "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one";}};
 const read=async()=>Buffer.alloc(0);read.verify=async()=>true;
 const first=advanceIntent(x.env,x.DB,intent.id,transport,read);await started;
 await assert.rejects(advanceIntent(x.env,x.DB,intent.id,transport,read),e=>e.status===409);
 release();await first;assert.equal(count,1);
});
test("expired OAuth state is rejected before exchanging any code",async()=>{
 const x=await fixture(),response=await startOAuth(x.env,x.DB,"owner","https://purffle.test");
 const state=new URL(response.headers.get("location")).searchParams.get("state");
 x.DB.db.prepare("UPDATE oauth_states SET expires_at='2000-01-01T00:00:00.000Z'").run();
 let sent=false;
 await assert.rejects(finishOAuth(x.env,x.DB,"owner",new URL("https://purffle.test/api/youtube/callback?state="+state+"&code=expired"),async()=>{sent=true;}),e=>e.status===403);
 assert.equal(sent,false);
});
