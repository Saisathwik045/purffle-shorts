// Isolated loopback software-test fixture. Never deploy this file or trust x-test-owner in production.
import http from "node:http";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fixture} from "../tests/support/phase3-fixture.js";
import worker from "../dist/server/index.js";
const x=await fixture(),video=await readFile(process.env.PURFFLE_BROWSER_VIDEO);
const sha=createHash("sha256").update(video).digest("hex");
x.DB.db.prepare("UPDATE clips SET content_sha256=?").run(sha);
const subtitles=Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nSynthetic test recording.\n");
x.env.BUCKET={
 async head(key){return key==="private/video"?{size:video.length,etag:"fixture-etag",customMetadata:{sha256:sha}}:{size:subtitles.length,etag:"srt"};},
 async get(key,opts){
  const all=key==="private/video"?video:subtitles;
  const offset=opts?.range?.offset||0,length=opts?.range?.length||all.length;
  return {body:all.subarray(offset,offset+length),size:all.length,range:opts?.range?{offset,length:Math.min(length,all.length-offset)}:undefined,
   writeHttpMetadata(headers){headers.set("Content-Type",key==="private/video"?"video/mp4":"application/x-subrip");}};
 }
};
globalThis.fetch=async(url)=>{
 if(String(url)==="https://oauth2.googleapis.com/revoke")return new Response(null,{status:200});
 throw new Error("External network is disabled in this browser fixture.");
};
const server=http.createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const c of req)chunks.push(c);
  const headers={...req.headers};
  if(headers["x-test-owner"])headers["oai-authenticated-user-id"]=headers["x-test-owner"];
  const request=new Request("http://127.0.0.1:"+server.address().port+req.url,{method:req.method,headers,
   ...(!["GET","HEAD"].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
  const response=await worker.fetch(request,x.env);
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end("Browser fixture failure");}
});
server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({origin:"http://127.0.0.1:"+server.address().port})));
