const {chromium}=require("playwright");
const {spawn}=require("node:child_process");
const assert=require("node:assert/strict");
(async()=>{
 const server=spawn(process.execPath,["dashboard/scripts/phase3-browser-server.mjs"],{env:process.env,stdio:["ignore","pipe","inherit"]});
 let browser;
 try{
  const origin=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error("Browser fixture startup timed out")),30000);
   server.once("exit",code=>reject(new Error("Browser fixture exited "+code)));
   server.stdout.on("data",data=>{for(const line of data.toString().split("\n"))try{const parsed=JSON.parse(line);if(parsed.origin){clearTimeout(timer);resolve(parsed.origin);}}catch{}});
  });
  browser=await chromium.launch({headless:true,channel:"chrome"});
  const context=await browser.newContext({extraHTTPHeaders:{"x-test-owner":"owner"}});
  const page=await context.newPage();const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin+"/review");
  await page.waitForSelector(".clip-card video");
  const media=await page.request.get(origin+"/api/clips/clip/video");
  assert.equal(media.status(),200);assert(media.headers()["content-type"].startsWith("video/mp4"));assert((await media.body()).length>100);
  console.log("Browser media check",JSON.stringify({status:media.status(),type:media.headers()["content-type"],h264:await page.locator("video").evaluate(v=>v.canPlayType('video/mp4; codecs="avc1.42E01E"'))}));
  await page.locator("video").evaluate(async v=>{v.muted=true;await v.play();});
  await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0);
  await page.locator("video").evaluate(v=>v.pause());
  async function editor(){if(await page.locator(".clip-card details").getAttribute("open")===null)await page.locator(".clip-card summary").click();}
  async function click(name,suffix){
    const response=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()==="POST");
    await page.getByRole("button",{name,exact:true}).click();
    assert.equal((await response).status(),200);
    await page.waitForTimeout(150);
  }
  await editor();
  await page.getByLabel("Title",{exact:true}).fill("Browser reviewed title");
  await page.getByLabel("Description",{exact:true}).fill("Owner-edited description for a synthetic test.");
  await page.getByLabel("Hashtags",{exact:true}).fill("#Shorts #Testing");
  await page.getByLabel("Opening hook",{exact:true}).fill("Test the idea");
  await click("Save metadata","/metadata");
  await page.reload();await page.waitForSelector(".clip-card");await editor();
  assert.equal(await page.getByLabel("Title",{exact:true}).inputValue(),"Browser reviewed title");
  assert((await page.getByLabel("Hashtags",{exact:true}).inputValue()).includes("#Testing"));
  await click("Approve","/review");
  await page.waitForFunction(()=>document.querySelector(".clip-card .badge")?.textContent.trim().toLowerCase()==="approved");
  await page.getByRole("button",{name:"Approval history",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("[data-review-result]")?.textContent.includes("APPROVED"));
  await editor();
  await page.getByLabel("Title",{exact:true}).fill("Changed after approval");
  await click("Save metadata","/metadata");
  await page.waitForFunction(()=>document.querySelector(".clip-card .badge")?.textContent.trim().toLowerCase()==="pending");
  await editor();await click("Regenerate metadata","/regenerate");
  await click("Reject","/review");
  await page.waitForFunction(()=>document.querySelector(".clip-card .badge")?.textContent.trim().toLowerCase()==="rejected");
  await click("Approve","/review");
  await page.getByRole("button",{name:"Check upload readiness",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("[data-review-result]")?.textContent.includes("Ready to prepare"));
  await click("Prepare upload intent","/upload-intent");
  const download=page.waitForEvent("download");
  await page.getByRole("button",{name:"Download publishing preparation",exact:true}).click();
  assert((await download).suggestedFilename().includes("publishing-preparation-"));
  assert(await page.getByRole("button",{name:"Upload to YouTube — disabled",exact:true}).isDisabled());
  await page.goto(origin+"/publishing");
  await page.waitForFunction(()=>document.body.textContent.includes("Prepared upload intents")&&document.body.textContent.includes("prepared"));
  assert((await page.locator("body").innerText()).includes("Nothing published"));
  await page.goto(origin+"/youtube");
  await page.waitForSelector("[data-oauth-readiness]");
  await page.getByRole("button",{name:"Check connection readiness",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#oauth-readiness")?.textContent.includes("Channel connected: yes"));
  await page.getByRole("button",{name:"Disconnect YouTube account",exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent.includes("No YouTube channel connected"));
  const other=await browser.newContext({extraHTTPHeaders:{"x-test-owner":"other"}});
  assert.equal((await other.request.get(origin+"/api/clips/clip/history")).status(),404);
  assert.equal((await page.request.post(origin+"/api/clips/clip/publish",{data:{}})).status(),403);
  assert.deepEqual(errors,[]);
  console.log("PHASE3_BROWSER PASS: actual video playback, persisted edits, hashtags, approval invalidation/history, regeneration, rejection, intent, preparation download, disabled upload, connection readiness, disconnect and owner isolation. Mock account/storage only.");
 }finally{if(browser)await browser.close();server.kill("SIGTERM");}
})().catch(e=>{console.error(e);process.exitCode=1;});
