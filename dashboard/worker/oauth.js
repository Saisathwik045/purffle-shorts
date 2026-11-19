import { Problem, hash } from "./domain.js";
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const now=()=>new Date().toISOString();
export const YOUTUBE_SCOPES=["https://www.googleapis.com/auth/youtube.upload","https://www.googleapis.com/auth/youtube.readonly"];
export function oauthConfigured(env) { return !!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.TOKEN_ENCRYPTION_KEY); }
async function key(env) {
  let bytes;
  try { bytes=Uint8Array.from(atob(env.TOKEN_ENCRYPTION_KEY||""),c=>c.charCodeAt(0)); } catch { throw new Problem("OAuth encryption is not configured.",503); }
  if(bytes.length!==32) throw new Problem("OAuth requires a 32-byte encryption key.",503);
  return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);
}
export async function seal(env,value,purpose) {
  const iv=crypto.getRandomValues(new Uint8Array(12)),aad=new TextEncoder().encode(purpose);
  const data=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},await key(env),new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({version:2,iv:[...iv],data:[...new Uint8Array(data)]});
}
export async function unseal(env,value,purpose) {
  try {
    const blob=JSON.parse(value);
    const data=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(blob.iv),...(blob.version===2?{additionalData:new TextEncoder().encode(purpose)}:{})},await key(env),new Uint8Array(blob.data));
    return JSON.parse(new TextDecoder().decode(data));
  } catch { throw new Problem("Stored authorization cannot be read. Reconnect the account.",409); }
}
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function google(send,url,init) {
  try { return await send(url,{...init,redirect:"error",signal:AbortSignal.timeout(10000)}); }
  catch { throw new Problem("Google authorization is temporarily unavailable. Retry the connection.",502); }
}
function redirect(url) { return new Response(null,{status:302,headers:{Location:url,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}}); }
export async function startOAuth(env,db,owner,origin) {
  if(!oauthConfigured(env)) throw new Problem("Configure the Google OAuth client and encryption key in secure server settings first.",503);
  await key(env);
  await run(db,"INSERT INTO oauth_connection_epochs(owner,epoch) VALUES(?,0) ON CONFLICT(owner) DO NOTHING",owner);
  const epoch=(await one(db,"SELECT epoch FROM oauth_connection_epochs WHERE owner=?",owner)).epoch;
  const state=base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier=base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge=base64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  const stateHash=await hash(state),uri=origin+"/api/youtube/callback";
  await run(db,"DELETE FROM oauth_states WHERE owner=? AND expires_at<?",owner,now());
  await run(db,"INSERT INTO oauth_states(hash,owner,expires_at,verifier_blob,redirect_uri,epoch) VALUES(?,?,?,?,?,?)",
    stateHash,owner,new Date(Date.now()+600000).toISOString(),await seal(env,{verifier},"pkce:"+owner+":"+stateHash),uri,epoch);
  const target=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:uri,response_type:"code",
    scope:YOUTUBE_SCOPES.join(" "),access_type:"offline",prompt:"consent",include_granted_scopes:"true",
    state,code_challenge:challenge,code_challenge_method:"S256"}).toString();
  return redirect(target.href);
}
export async function finishOAuth(env,db,owner,url,send=fetch) {
  const state=url.searchParams.get("state");
  if(!state||state.length>200) throw new Problem("Missing or invalid OAuth state.",403);
  const stateHash=await hash(state);
  const saved=await one(db,"DELETE FROM oauth_states WHERE hash=? AND owner=? AND expires_at>? RETURNING *",stateHash,owner,now());
  if(!saved||saved.redirect_uri!==url.origin+"/api/youtube/callback"||!saved.verifier_blob)
    throw new Problem("Connection expired or was already used. Start a new connection.",403);
  if(url.searchParams.get("error")) return redirect(url.origin+"/youtube?connection=cancelled");
  const code=url.searchParams.get("code");
  if(!code||code.length>4096) throw new Problem("Google did not return a valid authorization code.");
  const {verifier}=await unseal(env,saved.verifier_blob,"pkce:"+owner+":"+stateHash);
  const response=await google(send,"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({code,code_verifier:verifier,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:saved.redirect_uri,grant_type:"authorization_code"})});
  if(!response.ok) throw new Problem("Google rejected authorization. Start a new connection.",409);
  const tokens=await response.json(),scopes=String(tokens.scope||"").split(/\s+/);
  if(!tokens.refresh_token||!tokens.access_token||!YOUTUBE_SCOPES.every(s=>scopes.includes(s)))
    throw new Problem("Offline access and both YouTube permissions are required. Reconnect with consent.",409);
  const channels=await google(send,"https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",{headers:{Authorization:"Bearer "+tokens.access_token}});
  if(!channels.ok) throw new Problem("Unable to verify the authorized YouTube channel.",409);
  const channel=(await channels.json()).items?.[0];
  if(!channel?.id||!channel.snippet?.title) throw new Problem("No accessible YouTube channel was returned.",409);
  const connection=crypto.randomUUID(),encrypted=await seal(env,{...tokens,obtained_at:now()},"oauth:"+owner);
  const result=await one(db,
    "INSERT INTO youtube_accounts(owner,channel_id,channel_title,encrypted_tokens,connected_at,connection_id,status,scopes) SELECT ?,?,?,?,?,?,'CONNECTED',? WHERE EXISTS(SELECT 1 FROM oauth_connection_epochs WHERE owner=? AND epoch=?) ON CONFLICT(owner) DO UPDATE SET channel_id=excluded.channel_id,channel_title=excluded.channel_title,encrypted_tokens=excluded.encrypted_tokens,connected_at=excluded.connected_at,connection_id=excluded.connection_id,status='CONNECTED',scopes=excluded.scopes RETURNING owner",
    owner,channel.id,channel.snippet.title,encrypted,now(),connection,JSON.stringify(scopes),owner,saved.epoch);
  if(!result) throw new Problem("Connection was cancelled while Google was responding.",409);
  await run(db,"UPDATE upload_intents SET invalidated_at=?,state=CASE WHEN state IN ('INITIATING','UPLOADING','RECONCILING') THEN 'RECONCILING' ELSE 'INVALIDATED' END,error='Account connection changed.',updated_at=? WHERE owner=? AND state NOT IN ('COMPLETED','CANCELLED')",now(),now(),owner);
  return redirect(url.origin+"/youtube?connection=success");
}
export async function accessToken(env,db,owner,connectionId,send=fetch) {
  const account=await one(db,"SELECT * FROM youtube_accounts WHERE owner=? AND connection_id=? AND status='CONNECTED'",owner,connectionId);
  if(!account) throw new Problem("Reconnect YouTube before continuing.",409);
  const tokens=await unseal(env,account.encrypted_tokens,"oauth:"+owner);
  if(tokens.access_token&&Date.parse(tokens.obtained_at||"")+Number(tokens.expires_in||0)*1000>Date.now()+60000) return tokens.access_token;
  const response=await google(send,"https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:tokens.refresh_token,grant_type:"refresh_token"})});
  if(!response.ok) {
    if(response.status===400||response.status===401) await run(db,"UPDATE youtube_accounts SET status='RECONNECT_REQUIRED' WHERE owner=? AND connection_id=?",owner,connectionId);
    throw new Problem("Google access needs reconnection or is temporarily unavailable.",409);
  }
  const next=await response.json();
  if(!next.access_token) throw new Problem("Google returned an invalid refresh response.",502);
  const updated=await one(db,"UPDATE youtube_accounts SET encrypted_tokens=? WHERE owner=? AND connection_id=? AND status='CONNECTED' RETURNING owner",
    await seal(env,{...tokens,...next,refresh_token:next.refresh_token||tokens.refresh_token,obtained_at:now()},"oauth:"+owner),owner,connectionId);
  if(!updated) throw new Problem("Account connection changed during refresh.",409);
  return next.access_token;
}
export async function disconnectOAuth(env,db,owner,send=fetch) {
  const old=await one(db,"SELECT encrypted_tokens FROM youtube_accounts WHERE owner=?",owner);
  await db.batch([
    db.prepare("INSERT INTO oauth_connection_epochs(owner,epoch) VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET epoch=epoch+1").bind(owner),
    db.prepare("DELETE FROM oauth_states WHERE owner=?").bind(owner),
    db.prepare("DELETE FROM youtube_accounts WHERE owner=?").bind(owner),
    db.prepare("UPDATE upload_intents SET invalidated_at=?,state=CASE WHEN state IN ('INITIATING','UPLOADING','RECONCILING') THEN 'RECONCILING' ELSE 'INVALIDATED' END,error='YouTube disconnected.',updated_at=? WHERE owner=? AND state NOT IN ('COMPLETED','CANCELLED')").bind(now(),now(),owner)
  ]);
  let revoked=!old;
  if(old) try {
    const tokens=await unseal(env,old.encrypted_tokens,"oauth:"+owner);
    const response=await google(send,"https://oauth2.googleapis.com/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:tokens.refresh_token||tokens.access_token})});
    revoked=response.ok;
  } catch { /* Local credentials remain deleted even when Google is unavailable. */ }
  return {disconnected:true,remote_revocation_confirmed:revoked,publishing_enabled:false,
    ...(!revoked?{notice:"Local access removed. Review this app in Google Account permissions if remote revocation could not be confirmed."}:{})};
}
