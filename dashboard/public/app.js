"use strict";
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  jobs: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M8 12h8m-8 4h5"/>',
  clips:
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield:
    '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v5l3 2"/>',
  youtube:
    '<rect x="2" y="5" width="20" height="14" rx="5"/><path d="m10 9 5 3-5 3z"/>',
  settings:
    '<path d="m10 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1z"/><circle cx="12" cy="12" r="3"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13 0 5 5 0 0 1 0 10z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  refresh:
    '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-6v6h6m-5 6a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  link: '<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  film: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18m8-18v18M4 8h4m8 0h4M4 16h4m8 0h4"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.clips}</svg>`;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  CREATED: "Created",
  VALIDATING: "Validating",
  AWAITING_SOURCE_AUTHORIZATION: "Needs authorization",
  QUEUED: "Queued",
  TRANSCRIBING: "Transcribing",
  SELECTING_HIGHLIGHTS: "Selecting highlights",
  RENDERING: "Rendering",
  GENERATING_METADATA: "Generating metadata",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
  PUBLISHING: "Publishing",
  PUBLISHED: "Published",
  FAILED: "Failed",
};
const activeStates = [
  "VALIDATING",
  "TRANSCRIBING",
  "SELECTING_HIGHLIGHTS",
  "RENDERING",
  "GENERATING_METADATA",
];
const badge = (s) =>
  `<span class="badge ${s === "FAILED" ? "red" : s === "AWAITING_SOURCE_AUTHORIZATION" ? "amber" : ["PUBLISHED", "APPROVED"].includes(s) ? "green" : ["QUEUED", "CREATED", "REJECTED"].includes(s) ? "gray" : "purple"}">${esc(labels[s] || s.replaceAll("_", " ").toLowerCase())}</span>`;
const date = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const nav = [
  ["/", "grid", "Overview"],
  ["/jobs", "jobs", "Processing jobs"],
  ["/clips", "clips", "Generated clips"],
  ["/review", "shield", "Review & approval"],
  ["/publishing", "history", "Publishing history"],
  ["/youtube", "youtube", "YouTube connection"],
  ["/settings", "settings", "Settings"],
];
let state = null,
  detail = null,
  currentFilter = "All",
  search = "",
  refreshing = false;
let route = location.pathname;
const api = async (path, options = {}) => {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(
      "Cloud service returned an unexpected response. Please refresh.",
    );
  }
  if (!r.ok) {
    const error = new Error(data.error || "The cloud request failed.");
    Object.assign(error, data, { status: r.status });
    throw error;
  }
  return data;
};
const post = (path, data = {}) =>
  api(path, { method: "POST", body: JSON.stringify(data) });
const toast = (message) => {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 5000);
};
function go(path) {
  history.pushState({}, "", path);
  route = location.pathname;
  currentFilter = "All";
  search = "";
  detail = null;
  render();
  loadDetail();
  window.scrollTo(0, 0);
}
async function load() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api("/api/bootstrap");
    if (route !== "/jobs/new" && route !== "/settings") render();
    else if (!document.querySelector(".layout")) render();
    await loadDetail();
  } catch (error) {
    if (!state)
      document.querySelector("#app").innerHTML =
        `<div class="boot"><span class="brand-mark">p</span><h1>Your private cloud studio</h1><p>${esc(error.message)}</p>${error.status === 401 ? '<a class="btn primary" href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in to your workspace</a>' : '<button class="btn" data-action="refresh">Try again</button>'}</div>`;
    else toast(error.message);
  } finally {
    refreshing = false;
  }
}
async function loadDetail() {
  const match = route.match(/^\/jobs\/([\w-]+)$/);
  if (match) {
    try {
      detail = await api(`/api/jobs/${match[1]}`);
      if (document.activeElement?.closest("#auth-form")) return;
      render();
    } catch (error) {
      toast(error.message);
    }
  }
}
function shell(content) {
  const title =
    route === "/jobs/new"
      ? "New clipping job"
      : route.startsWith("/jobs/")
        ? "Job details"
        : nav.find((n) => n[0] === route)?.[2] || "Overview";
  const recent =
    state.worker &&
    Date.now() - Date.parse(state.worker.last_seen) < 20 * 60000;
  return `<div class="layout"><aside class="sidebar" id="sidebar"><a href="/" class="brand" data-nav><span class="brand-mark">p</span><span>purffle<small>CLOUD STUDIO</small></span></a><nav class="nav" aria-label="Main navigation"><a href="/jobs/new" data-nav class="nav-new">${icon("plus")} New clipping job</a><div class="nav-label">Workspace</div>${nav.map(([path, ic, label], i) => `${i === 5 ? '<div class="nav-label section-space">Manage</div>' : ""}<a href="${path}" data-nav class="${route === path || (path === "/jobs" && route.startsWith("/jobs/") && route !== "/jobs/new") ? "active" : ""}" ${route === path ? 'aria-current="page"' : ""}>${icon(ic)}${label}</a>`).join("")}</nav><div class="sidebar-foot"><div class="cloud-indicator"><strong>${icon("cloud").replace("<svg", '<svg style="width:13px;height:13px;vertical-align:middle;margin-right:5px"')} Cloud workspace</strong><span class="dot ${recent ? "green" : ""}"></span>${recent ? "CPU worker seen recently" : "Awaiting CPU worker"}<p style="margin-top:7px;font-size:10px;color:#7e738e">Your Mac only runs the browser.</p></div><div class="side-user"><div class="avatar">P</div><span>${esc(state.user.name)}<small style="display:block;font-size:9px">Private workspace</small></span></div></div></aside><header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-toggle" data-action="menu" aria-label="Toggle navigation">${icon("menu")}</button>Workspace <span>/</span><b>${title}</b></div><div class="header-right"><label class="search">${icon("search")}<input id="global-search" aria-label="Search jobs and clips" placeholder="Search your workspace" value="${esc(search)}"></label><div class="head-status">${icon("lock")}Private workspace</div><button class="icon-btn" data-action="refresh" aria-label="Refresh cloud status" title="Refresh cloud status">${icon("refresh")}</button><span class="avatar">P</span></div></header><main class="main" id="main">${content}<div class="footer-note">${icon("lock")}Private records · CPU processing in the cloud · Publishing disabled</div></main></div>`;
}
function head(title, subtitle, action = "") {
  return `<div class="page-head"><div><div class="eyebrow">Purffle Cloud Studio</div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}
const createLink = `<a href="/jobs/new" data-nav class="btn primary">${icon("plus")} New clipping job</a>`;
const empty = (ic, title, text, action = "") =>
  `<div class="empty"><div class="empty-icon">${icon(ic)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
function overview() {
  const jobs = state.jobs,
    clips = state.clips;
  const metrics = [
    ["Total jobs", jobs.length, "jobs", "Your saved clipping requests"],
    [
      "Processing",
      jobs.filter((j) => activeStates.includes(j.state)).length,
      "clock",
      "Reported by your cloud worker",
    ],
    [
      "Ready to review",
      clips.filter((c) => c.review_status === "PENDING").length,
      "shield",
      "Generated clips awaiting a decision",
    ],
    [
      "Published",
      state.publications.filter((p) => p.state === "PUBLISHED").length,
      "youtube",
      "Confirmed YouTube publications",
    ],
  ];
  return `${head("A little long-form. A lot of potential.", "Your cloud workspace for turning great moments into Shorts.", createLink)}<div class="metrics">${metrics.map(([label, n, ic, text]) => `<div class="card metric"><div class="metric-icon">${icon(ic)}</div><div class="metric-label">${label}</div><div class="metric-number">${n}</div><small>${text}</small></div>`).join("")}</div><div class="two-col"><div class="stack"><div class="welcome"><div><div class="eyebrow">Made for your best moments</div><h2>One source. A new way<br>to tell the story.</h2><p>Add a video, clear its source rights, and let a cloud worker handle the edit. You make the final call.</p><a href="/jobs/new" data-nav class="btn primary">${icon("plus")} Create your first${jobs.length ? " next" : ""} clips ${icon("arrow")}</a></div><div class="welcome-art" aria-hidden="true"><div class="mini-video back"><span class="mini-line"></span></div><div class="mini-video"><span class="play">${icon("play")}</span><span class="mini-line"></span><span class="mini-line"></span></div></div></div><section class="card"><div class="card-head"><div><h2>Your workflow, at a glance</h2><p>Real records at every stage. Your approval before publishing.</p></div><span class="badge purple">Cloud workflow</span></div><div class="workflow">${[
    [
      "link",
      "Source rights",
      jobs.filter((j) => j.state === "AWAITING_SOURCE_AUTHORIZATION").length,
      "awaiting authorization",
    ],
    [
      "film",
      "Cloud processing",
      jobs.filter((j) => j.state === "QUEUED" || activeStates.includes(j.state))
        .length,
      "queued or processing",
    ],
    [
      "shield",
      "Review & approve",
      clips.filter((c) => c.review_status === "PENDING").length,
      "clips to review",
    ],
    ["youtube", "Publishing", state.publications.length, "publication records"],
  ]
    .map(
      ([ic, t, n, d], i) =>
        `<div class="workflow-step"><div class="step-num">${icon(ic)}<span>0${i + 1}</span></div><h3>${t}</h3><p><span class="live-count">${n}</span> ${d}</p></div>`,
    )
    .join(
      "",
    )}</div></section><section class="card"><div class="card-head"><div><h2>Recent jobs</h2><p>Your latest requests and their reported status.</p></div><a href="/jobs" data-nav style="font-size:11px">View all ${icon("arrow").replace("<svg", '<svg style="width:12px;vertical-align:middle"')}</a></div>${jobs.length ? jobTable(jobs.slice(0, 4)) : empty("jobs", "Your next project starts here", "Create a clipping job to bring your source, cloud processing and review into one place.", `<a href="/jobs/new" data-nav class="btn">${icon("plus")} Create a clipping job</a>`)}</section></div><div class="stack right-stack"><section class="card"><div class="card-head"><h2>Workspace checklist</h2></div><div class="card-body" style="padding-top:5px;padding-bottom:10px">${[
    [
      "shield",
      "Source authorization",
      `${jobs.filter((j) => j.authorization?.approved).length} authorized source(s). Rights evidence is required for every job.`,
      "/jobs/new",
      "Add a source",
    ],
    [
      "cloud",
      "CPU worker",
      state.worker
        ? `Last heartbeat: ${date(state.worker.last_seen)}.`
        : "No worker has reported yet. Jobs cannot process until a cloud worker is connected.",
      "/settings",
      "View worker setup",
    ],
    [
      "youtube",
      "YouTube account",
      state.account
        ? `Connected to ${esc(state.account.channel_title)}.`
        : "Connect your channel when you are ready. Uploads remain off.",
      "/youtube",
      state.account ? "Manage connection" : "Set up connection",
    ],
  ]
    .map(
      ([ic, t, d, url, l]) =>
        `<div class="setup-item"><div class="setup-icon">${icon(ic)}</div><div><h3>${t}</h3><p>${d}</p><a href="${url}" data-nav>${l} →</a></div></div>`,
    )
    .join(
      "",
    )}</div></section><div class="note"><strong>${icon("shield").replace("<svg", '<svg style="width:13px;height:13px;vertical-align:middle"')} Your content. Your call.</strong>A YouTube link is a source reference, never permission to reuse it. Only authorized sources reach the processing queue.</div><section class="card"><div class="card-body"><span class="badge gray">Publishing off</span><h3 style="margin-top:15px">Create with a review step.</h3><p class="muted" style="font-size:11px;margin-top:9px">Generated clips and published videos have separate records. Approval does not trigger an upload.</p><a href="/review" data-nav style="display:inline-block;margin-top:15px;font-size:11px">Open review workspace →</a></div></section></div></div>`;
}
function authFields(prefix = "auth") {
  return `<div class="note amber"><strong>Source authorization required</strong>A public URL, a livestream or a Creative Commons label alone is not verified permission. Provide evidence and an authorized media file from the rights holder. YouTube extraction is not enabled.</div><div class="form-grid section-space"><label class="field">Rights basis<select name="license"><option value="owned">I own all rights</option><option value="written-permission">Written permission</option><option value="CC0-1.0">CC0 1.0</option><option value="CC-BY-4.0">CC BY 4.0</option></select></label><label class="field">Permitted media access<select name="method"><option value="direct_https">Rights-holder supplied HTTPS media file</option></select></label><label class="field full">Authorized media file URL<input name="media_url" type="url" placeholder="https://your-media-origin.example/video.mp4"><small>Public direct HTTPS file, up to 500 MiB and 30 minutes. No redirects or signed query strings. The CPU worker verifies the file checksum.</small></label><label class="field full">Media SHA-256<input name="sha256" placeholder="64 lowercase hexadecimal characters" maxlength="64" spellcheck="false" autocomplete="off"></label><label class="field full">Rights evidence<textarea name="evidence" maxlength="4000" placeholder="Identify the owner, permission record, permitted edits, commercial use and any restrictions. Do not paste secrets."></textarea></label><label class="field full">Attribution and edits<textarea name="attribution" maxlength="1200" placeholder="Creator, original source, license URL (if applicable), and a statement of the edits and subtitles added."></textarea></label><label class="field">Permission expires (optional)<input name="expires_on" type="date"></label></div><div class="checks"><label class="check"><input name="all_components_cleared" type="checkbox">I have cleared all footage, music, guest appearances and other components for this use and editing.</label><label class="check"><input name="platform_download_permitted" type="checkbox">The rights holder and applicable platform terms permit access through this direct media URL.</label><label class="check"><input name="approved" type="checkbox">I have reviewed the evidence and explicitly authorize this source for cloud clipping.</label></div>`;
}
function prefFields(p) {
  return `<div class="form-grid"><label class="field">Number of clips<select name="count">${Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}" ${p.count === i + 1 ? "selected" : ""}>${i + 1} clip${i ? "s" : ""}</option>`).join("")}</select><small>Up to 10 clips. Actual results depend on usable speech and source length.</small></label><label class="field">Preferred duration<select name="duration">${[15, 20, 30, 40, 45, 60].map((n) => `<option value="${n}" ${p.duration === n ? "selected" : ""}>About ${n} seconds</option>`).join("")}</select></label><label class="field">Aspect ratio<select name="aspect">${["9:16", "1:1", "16:9"].map((n) => `<option ${p.aspect === n ? "selected" : ""}>${n}</option>`).join("")}</select><small>9:16 is recommended for YouTube Shorts.</small></label><label class="field">Caption style<select name="caption_style">${["bold", "boxed", "neon", "clean", "karaoke", "minimal"].map((n) => `<option value="${n}" ${p.caption_style === n ? "selected" : ""}>${n[0].toUpperCase() + n.slice(1)}</option>`).join("")}</select></label><label class="field">Subtitle language<select name="language">${Object.entries(
    {
      en: "English",
      hi: "Hindi",
      es: "Spanish",
      fr: "French",
      de: "German",
      pt: "Portuguese",
      ja: "Japanese",
      ko: "Korean",
      ar: "Arabic",
      it: "Italian",
      te: "Telugu",
      ta: "Tamil",
    },
  )
    .map(
      ([code, name]) =>
        `<option value="${code}" ${p.language === code ? "selected" : ""}>${name}</option>`,
    )
    .join(
      "",
    )}</select><small>Select the spoken language. This transcribes speech, without translation.</small></label><label class="field">Content category <span class="muted">(optional)</span><input name="category" maxlength="80" value="${esc(p.category || "")}" placeholder="e.g. Education, technology, podcast"></label></div>`;
}
function newJob() {
  return `${head("Find the moments worth sharing.", "Start with a video or completed livestream. Your source rights come first.")}<div class="two-col"><form id="new-job-form" class="card"><div class="card-head"><div><h2>New clipping job</h2><p>Choose a source and tell us how you want to clip it.</p></div><span class="badge amber" id="source-status">Not authorized</span></div><div class="card-body"><div class="switch-tabs" role="group" aria-label="Source type"><button type="button" data-kind="video" class="selected">${icon("youtube").replace("<svg", '<svg style="width:14px;height:14px;vertical-align:middle;margin-right:5px"')} YouTube video</button><button type="button" data-kind="livestream">YouTube livestream</button></div><input type="hidden" name="source_kind" value="video"><label class="field full"><span id="url-label">YouTube video URL</span><div class="input-row"><input id="source-url" name="url" type="url" required placeholder="https://www.youtube.com/watch?v=…" autocomplete="off"><button class="btn" type="button" data-action="metadata">Look up</button></div><small id="source-hint">Video metadata can identify your source. It does not establish reuse rights.</small></label><div id="metadata-preview" aria-live="polite"></div><div class="section-space" style="padding-top:22px;border-top:1px solid var(--line)">${prefFields(state.preferences)}</div><div class="section-space"><h3 style="margin-bottom:12px">Caption direction</h3><div class="radio-preview" aria-hidden="true"><div class="caption-option"><b>MAKE IT COUNT</b>Bold & readable</div><div class="caption-option"><b>ONE GREAT MOMENT</b>Words with emphasis</div><div class="caption-option"><b>Let the story speak.</b>Clean & minimal</div></div><small style="display:block;margin-top:9px;font-size:10px">Illustrative typography only. Your chosen style is applied to the generated video.</small></div><details class="section-space"><summary>${icon("shield")} Source authorization & media access</summary>${authFields()}</details><div id="form-error" class="error" role="alert"></div><div class="form-footer"><small>Without approved evidence, the job is saved as “Awaiting source authorization” and cannot enter the processing queue.</small><button class="btn primary" type="submit">${icon("clips")} Generate clips ${icon("arrow")}</button></div></div></form><div class="stack"><div class="card"><div class="card-head"><h2>What happens next</h2></div><div class="card-body"><div class="key-values"><div><span>01</span><b>Validate link & settings</b></div><div><span>02</span><b>Check source authorization</b></div><div><span>03</span><b>Transcribe & clip in the cloud</b></div><div><span>04</span><b>Review each generated clip</b></div></div><p class="muted" style="font-size:11px;margin-top:24px">No processing runs on your Mac. The dashboard records reported stages, without estimated progress percentages.</p></div></div><div class="note amber"><strong>Livestreams need a finished media file.</strong>Live capture is not supported. Provide a completed recording with the same permissions required for a video.</div><div class="note"><strong>Uploading stays off.</strong>Generating or approving a clip never publishes it to YouTube.</div></div></div>`;
}
function jobTable(jobs) {
  return `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Stage</th><th>Clips / format</th><th>Updated</th><th></th></tr></thead><tbody>${jobs.map((j) => `<tr><td><a class="job-title" href="/jobs/${j.id}" data-nav><img src="${esc(j.thumbnail)}" alt="" loading="lazy"><div><strong>${esc(j.title)}</strong><small>${j.source_kind === "livestream" ? "Livestream recording" : "YouTube video"} · Attempt ${j.attempt}</small></div></a></td><td>${badge(j.state)}</td><td>${j.options.count} · ${esc(j.options.aspect)}<small style="display:block;margin-top:5px">~${j.options.duration}s per clip</small></td><td><small>${date(j.updated_at)}</small></td><td><a class="btn small" href="/jobs/${j.id}" data-nav>Open ${icon("arrow")}</a></td></tr>`).join("")}</tbody></table></div>`;
}
function jobsPage() {
  let jobs = state.jobs.filter((j) =>
    j.title.toLowerCase().includes(search.toLowerCase()),
  );
  if (currentFilter === "Needs rights")
    jobs = jobs.filter((j) => j.state === "AWAITING_SOURCE_AUTHORIZATION");
  if (currentFilter === "Processing")
    jobs = jobs.filter(
      (j) => j.state === "QUEUED" || activeStates.includes(j.state),
    );
  if (currentFilter === "Ready")
    jobs = jobs.filter((j) =>
      ["READY_FOR_REVIEW", "APPROVED"].includes(j.state),
    );
  if (currentFilter === "Failed")
    jobs = jobs.filter((j) => j.state === "FAILED");
  return `${head("Every job, in one place.", "Follow reported stages, source requirements and processing errors.", createLink)}<div class="toolbar"><div class="filters">${["All", "Needs rights", "Processing", "Ready", "Failed"].map((f) => `<button class="filter ${currentFilter === f ? "selected" : ""}" data-filter="${f}">${f}</button>`).join("")}</div><span class="loading-indicator">Refreshable cloud records · ${state.jobs.length} job(s)</span></div><section class="card">${jobs.length ? jobTable(jobs) : empty("jobs", state.jobs.length ? "No jobs match this view" : "No clipping jobs yet", state.jobs.length ? "Try another filter or search." : "Add a source and choose your clipping settings. Unauthorized sources stay out of the queue.", createLink)}</section>`;
}
function jobDetail() {
  if (!detail)
    return `${head("Opening job…", "Loading the persistent job record.")}<div class="card">${empty("cloud", "Loading cloud history", "The dashboard is fetching this job’s recorded stages.")}</div>`;
  const { job: j, events } = detail;
  return `${head(esc(j.title), "Job " + esc(j.id.slice(0, 8)) + " · Created " + date(j.created_at), `<div class="actions"><a href="/jobs" data-nav class="btn">All jobs</a><button class="btn" data-action="refresh">${icon("refresh")} Refresh</button></div>`)}<div class="two-col"><div class="stack"><section class="card"><div class="card-head"><h2>Current stage</h2>${badge(j.state)}</div><div class="card-body"><p style="font-size:12px">${j.state === "QUEUED" ? "This authorized job is waiting for a cloud CPU worker. No processing has started." : j.state === "AWAITING_SOURCE_AUTHORIZATION" ? "This job is saved, but it is outside the processing queue until you authorize the source." : j.state === "FAILED" ? "The last processing attempt failed. Its error and event history are preserved." : j.state === "READY_FOR_REVIEW" ? "Generated clips are saved privately and ready for your review." : j.state === "APPROVED" ? "Review decisions are saved. Publishing remains disabled." : "The cloud worker reports the current stage. Refresh to fetch the latest record."}</p><small style="display:block;margin-top:12px">Last update ${date(j.updated_at)} · Attempt ${j.attempt} · No estimated percentage</small>${j.error ? `<div class="note red section-space"><strong>Processing error</strong>${esc(j.error)}</div>` : ""}${j.state === "QUEUED" ? `<div class="note section-space"><strong>Worker dispatch: ${esc(j.dispatch_status || "not confirmed")}</strong>${esc(j.dispatch_error || "Waiting for an authorized cloud provider to report a claim.")} ${j.runner_url ? `<a href="${esc(j.runner_url)}" target="_blank" rel="noopener">View processing run ↗</a>` : ""}</div><button class="btn section-space" data-wake="${j.id}">Retry worker wake</button>` : ""}
${["READY_FOR_REVIEW", "APPROVED", "FAILED"].includes(j.state) ? `<button class="btn danger section-space" data-cleanup="${j.id}">Delete generated files · keep history</button>` : ""}
${j.state === "FAILED" && j.retryable ? `<button class="btn section-space" data-retry="${j.id}">${icon("refresh")} Retry processing safely</button>` : ""}${["READY_FOR_REVIEW", "APPROVED"].includes(j.state) ? '<a href="/review" data-nav class="btn primary section-space">Open review workspace →</a>' : ""}</div></section>${j.state === "AWAITING_SOURCE_AUTHORIZATION" ? `<form class="card" id="auth-form" data-job="${j.id}"><div class="card-head"><h2>Authorize this source</h2></div><div class="card-body">${authFields()}<div class="error" role="alert" id="auth-error"></div><button class="btn primary section-space" type="submit">${icon("shield")} Authorize & queue</button></div></form>` : ""}<section class="card"><div class="card-head"><h2>Recorded activity</h2><small>Server timestamps</small></div><div class="timeline">${events.map((e) => `<div class="timeline-item"><span class="timeline-dot"></span><div><h3>${esc(labels[e.state] || e.state)}</h3><p>${esc(e.message)}</p><small>${date(e.created_at)} · Attempt ${e.attempt}</small></div></div>`).join("")}</div></section></div><div class="stack"><section class="card"><div class="card-head"><h2>Job settings</h2></div><div class="card-body key-values">${[
    ["Clips requested", j.options.count],
    ["Preferred duration", j.options.duration + " seconds"],
    ["Aspect ratio", j.options.aspect],
    ["Caption style", j.options.caption_style],
    ["Language", j.options.language],
    ["Category", j.options.category || "Unspecified"],
  ]
    .map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`)
    .join(
      "",
    )}</div></section><section class="card"><div class="card-head"><h2>Source authorization</h2></div><div class="card-body">${badge(j.authorization ? "APPROVED" : "AWAITING_SOURCE_AUTHORIZATION")}<p class="muted word-wrap" style="font-size:11px;margin-top:15px">${j.authorization ? esc(j.authorization.evidence) : "No approved evidence has been recorded."}</p>${j.authorization ? `<div class="note section-space"><strong>${esc(j.authorization.license)} · Direct HTTPS media</strong>${esc(j.authorization.attribution)}</div><small style="display:block;margin-top:12px">Reviewed ${esc(j.authorization.reviewed_on)}${j.authorization.expires_on ? " · Expires " + esc(j.authorization.expires_on) : ""}</small>` : ""}<a href="${esc(j.source_url)}" target="_blank" rel="noopener noreferrer" class="btn small section-space">${icon("youtube")} Original source</a></div></section><div class="note">Clip selection uses sentence-based windows without a paid LLM. The worker may return fewer clips when there is insufficient usable speech.</div></div></div>`;
}
function metadataEditor(c) {
  return `<details class="section-space"><summary>Review title, description and hashtags</summary><form id="clip-metadata-${esc(c.id)}" data-metadata-clip="${esc(c.id)}" data-metadata-hash="${esc(c.metadata_hash || "")}">
  <label class="field">Title<input name="title" required maxlength="100" value="${esc(c.title)}"></label>
  <label class="field">Description<textarea name="description" maxlength="5000" rows="4">${esc(c.description)}</textarea></label>
  <label class="field">Hashtags<input name="hashtags" aria-label="Hashtags" value="${esc((c.hashtags || []).join(" "))}" placeholder="#Shorts #Topic"><small>Up to 15 hashtags, separated by spaces.</small></label>
  <label class="field">Opening hook<input name="opening_hook" maxlength="120" value="${esc(c.opening_hook || "")}"></label>
  <p><strong>Source attribution</strong><br>${esc(c.source_attribution || "Review source rights before publishing.")}</p>
  <p><strong>Original commentary suggestions</strong></p><ul>${(c.commentary_suggestions || []).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>
  <small>Suggestions have not been added to the video. Saving edits clears prior approval.</small><div class="error" role="alert"></div><button class="btn small" type="submit">Save metadata</button></form>
  <button class="btn small section-space" data-regenerate="${esc(c.id)}">Regenerate metadata</button><small>Regeneration replaces saved metadata and requires a new approval.</small></details>
  <div class="actions section-space"><button class="btn small" data-history="${esc(c.id)}">Approval history</button>
  <button class="btn small" data-readiness="${esc(c.id)}">Check upload readiness</button>
  <button class="btn small" data-intent="${esc(c.id)}">Prepare upload intent</button></div>
  <div data-review-result="${esc(c.id)}" role="status"></div>
  <button class="btn small section-space" data-prepare="${esc(c.id)}">Download publishing preparation</button>
  <button class="btn small section-space" disabled title="Separate explicit authorization is required before uploads">Upload to YouTube — disabled</button>`;
}
function clipsPage(review = false) {
  let clips = state.clips.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase()),
  );
  if (review && currentFilter !== "All")
    clips = clips.filter(
      (c) => c.review_status === currentFilter.toUpperCase(),
    );
  return `${head(review ? "Good edits deserve a second look." : "Your moments, made short.", review ? "Watch each clip, check its subtitles and record your decision." : "Generated videos are private cloud outputs. They are separate from publications.")}<div class="toolbar"><div class="filters">${(review ? ["All", "Pending", "Approved", "Rejected"] : ["All"]).map((f) => `<button class="filter ${currentFilter === f ? "selected" : ""}" data-filter="${f}">${f}</button>`).join("")}</div><span class="badge gray">Uploads disabled</span></div>${clips.length ? `<div class="clip-grid">${clips.map((c) => `<article class="card clip-card"><div class="clip-frame"><video controls playsinline preload="metadata" data-preview="${c.id}" src="/api/clips/${c.id}/video" aria-label="${esc(c.title)}"></video></div><div class="clip-info"><div class="note amber" data-preview-error role="status" hidden></div>${badge(c.review_status === "APPROVED" && !c.approval_valid ? "PENDING" : c.review_status)}<h3>${esc(c.title)}</h3>${metadataEditor(c)}<p>${Math.round(c.duration)} seconds · Generated ${date(c.created_at)} · 7-day media retention</p><div class="actions"><a class="btn small" href="/api/clips/${c.id}/subtitles">${icon("download")} Subtitles</a><a class="btn small" href="/jobs/${c.job_id}" data-nav>Source & history</a></div>${review ? `<div class="actions"><button class="btn small primary" data-review="${c.id}" data-decision="APPROVED">${icon("check")} Approve</button><button class="btn small danger" data-review="${c.id}" data-decision="REJECTED">Reject</button></div><small style="display:block;margin-top:12px">Approval saves your decision. It never starts an upload.</small>` : ""}</div></article>`).join("")}</div>` : `<section class="card large-empty">${empty(review ? "shield" : "clips", review ? "Nothing waiting for review" : "No generated clips yet", review ? "Completed cloud jobs will appear here with a video preview, subtitles and source history." : "Clips appear only after a worker saves completed video and subtitle files. No sample clips are mixed into your library.", createLink)}</section>`}`;
}
function publishing() {
  const intents=state.upload_intents || [];
  return `${head("Publishing preparation & history","Upload intents are preparation records. Only confirmed YouTube video IDs count as published.")}
  <div class="note section-space"><strong>Live uploads are disabled.</strong>OAuth connection and approval do not authorize an upload.</div>
  <section class="card section-space"><div class="card-head"><h2>Prepared upload intents</h2></div>${intents.length?`<div class="table-wrap"><table><thead><tr><th>Intent</th><th>State</th><th>Acknowledged bytes</th><th>Updated</th></tr></thead><tbody>${intents.map(x=>`<tr><td>${esc(x.id.slice(0,8))}</td><td>${badge(x.state)}</td><td>${x.acknowledged_bytes} / ${x.total_bytes}</td><td>${date(x.updated_at)}</td></tr>`).join("")}</tbody></table></div>`:empty("history","No upload intents","Approve a real clip, connect your channel and check readiness before preparing an intent.")}</section>
  <section class="card section-space"><div class="card-head"><h2>Confirmed publishing history</h2></div>${state.publications.length?`<div class="table-wrap"><table><thead><tr><th>Clip</th><th>Status</th><th>Published</th><th>YouTube</th></tr></thead><tbody>${state.publications.map(p=>`<tr><td>${esc(p.title)}</td><td>${badge(p.state)}</td><td>${date(p.published_at)}</td><td>${p.youtube_id?`<a href="https://www.youtube.com/watch?v=${encodeURIComponent(p.youtube_id)}" target="_blank" rel="noopener">View video ↗</a>`:"Not confirmed"}</td></tr>`).join("")}</tbody></table></div>`:empty("history","Nothing published","Prepared intents and approved clips are not published videos.")}</section>`;
}
function youtube() {
  const a=state.account;
  return `${head("YouTube account connection","Use Google's official consent screen. Never enter a password or token in this dashboard.")}
  <section class="card"><div class="card-head"><h2>${a?esc(a.channel_title):"No YouTube channel connected"}</h2><span class="badge gray">Uploads disabled</span></div><div class="card-body">
  ${a?`<p>Channel ID: ${esc(a.channel_id)}</p><p>Status: ${esc(a.status || "Reconnect required")}</p><p>Connected ${date(a.connected_at)}</p><button class="btn danger" data-action="disconnect">Disconnect YouTube account</button>`:"<p>Connect a channel to prepare publishing. Connecting does not enable uploads.</p>"}
  <a class="btn primary section-space" href="/api/youtube/connect">${a?"Reconnect":"Connect"} YouTube Account</a>
  <button class="btn section-space" data-oauth-readiness="true">Check connection readiness</button><div id="oauth-readiness" role="status"></div>
  ${!state.oauth_configured?'<div class="note amber section-space">Google OAuth client and encryption settings must be configured securely on the server before connection.</div>':""}
  <p class="muted section-space">Tokens are encrypted server-side. Disconnect removes local credentials and attempts Google revocation. Uploading requires a separate explicit authorization.</p></div></section>`;
}
function settings() {
  return `${head("A workspace that works your way.", "Save your clipping defaults and check your cloud configuration.")}<div class="two-col"><div class="stack"><form class="card" id="settings-form"><div class="card-head"><h2>Clipping defaults</h2><span class="badge purple">Saved in the cloud</span></div><div class="card-body">${prefFields(state.preferences)}<div id="settings-error" class="error" role="alert"></div><div class="form-footer"><small>These defaults apply to new jobs. Existing jobs keep their recorded settings.</small><button class="btn primary">Save preferences</button></div></div></form><section class="card"><div class="card-head"><h2>Cloud worker</h2>${badge(state.worker ? "CREATED" : "QUEUED")}</div><div class="card-body"><div class="key-values"><div><span>Storage connection</span><b>${state.generation?.connection?.storage_verified ? "Verified " + date(state.generation.connection.storage_verified_at) : "Not verified"}</b></div><div><span>Last reported heartbeat</span><b>${state.worker ? date(state.worker.last_seen) : "No worker has reported"}</b></div><div><span>Inference</span><b>Whisper base · CPU / int8</b></div><div><span>Media limit</span><b>500 MiB · 30 minutes</b></div><div><span>Per-clip file limit</span><b>25 MiB</b></div><div><span>Publishing</span><b>Disabled</b></div></div><div class="note section-space"><strong>Processing needs a connected remote worker.</strong>No cloud processing provider is connected by default. The worker must have verified service permission, no-charge limits and a current private storage check before generation is enabled. Credentials stay in secure server settings.</div><a class="btn small section-space" href="https://github.com/Saisathwik045/purffle-shorts/blob/codex/phase2-6-worker-provider/docs/phase2-6-worker-feasibility.md" target="_blank" rel="noopener">Cloud setup guide ↗</a></div></section></div><div class="stack"><section class="card"><div class="card-head"><h2>Cost & execution</h2></div><div class="card-body key-values"><div><span>Inference APIs</span><b>None</b></div><div><span>Video processing</span><b>Remote Linux CPU</b></div><div><span>Dashboard data</span><b>Private D1 database</b></div><div><span>Generated media</span><b>Private object storage</b></div></div></section><div class="note amber"><strong>Free allowances have limits.</strong>Free compute pricing alone does not authorize application processing. Verify provider terms, storage, hosting and account limits without enabling paid overages.</div><div class="note"><strong>Browser-only on your Mac.</strong>Viewing the dashboard and playing a clip require no local server, Python environment, Docker or ML model.</div></div></div>`;
}
function render() {
  if (!state) return;
  let content;
  if (route === "/") content = overview();
  else if (route === "/jobs/new") content = newJob();
  else if (route === "/jobs") content = jobsPage();
  else if (route.startsWith("/jobs/")) content = jobDetail();
  else if (route === "/clips") content = clipsPage();
  else if (route === "/review") content = clipsPage(true);
  else if (route === "/publishing") content = publishing();
  else if (route === "/youtube") content = youtube();
  else if (route === "/settings") content = settings();
  else
    content = head(
      "Page not found",
      "Choose a page from your workspace navigation.",
    );
  if (
    state.generation &&
    !state.generation.enabled &&
    ["/", "/jobs/new", "/settings"].includes(route)
  )
    content =
      `<div class="note amber" style="margin-bottom:20px"><strong>Cloud generation is paused — setup required</strong>${state.generation.blockers.map(esc).join(" ")} No video processing will start until these checks pass.</div>` +
      content;
  document.querySelector("#app").innerHTML = shell(content);
}
function generationNotice(result) {
  if (result.state === "AWAITING_SOURCE_AUTHORIZATION")
    return "Job saved. Add current source authorization before processing.";
  if (result.state === "FAILED")
    return "Cloud generation is blocked. Open this job to review its recorded error.";
  if (result.dispatch_status === "UNCONFIRMED")
    return "Worker wake was not confirmed. Follow the existing job; do not create a duplicate.";
  return "Cloud generation requested. Follow the recorded job stages; publishing remains disabled.";
}
function formOptions(form) {
  const f = new FormData(form);
  return {
    count: Number(f.get("count")),
    duration: Number(f.get("duration")),
    aspect: f.get("aspect"),
    caption_style: f.get("caption_style"),
    language: f.get("language"),
    category: f.get("category") || "",
  };
}
function formAuth(form) {
  const f = new FormData(form);
  return Object.fromEntries(
    [
      "license",
      "method",
      "media_url",
      "sha256",
      "evidence",
      "attribution",
      "expires_on",
    ]
      .map((k) => [k, String(f.get(k) || "")])
      .concat(
        [
          "approved",
          "all_components_cleared",
          "platform_download_permitted",
        ].map((k) => [k, f.get(k) === "on"]),
      ),
  );
}
let metadataBusy = false;
async function lookup() {
  if (metadataBusy) return;
  const input = document.querySelector("#source-url");
  if (!input?.value) return;
  metadataBusy = true;
  const target = document.querySelector("#metadata-preview");
  target.innerHTML =
    '<p class="muted" style="font-size:11px;padding:15px 0">Looking up source metadata…</p>';
  try {
    const data = await api(
      "/api/metadata?url=" + encodeURIComponent(input.value),
    );
    target.innerHTML = `<div class="meta-preview"><img src="https://i.ytimg.com/vi/${esc(data.source.id)}/hqdefault.jpg" alt="Source thumbnail"><div><h3>${esc(data.title || "Metadata is unavailable for this source")}</h3><small>${esc(data.author || "Private, restricted or live sources may not provide metadata.")}</small><div style="margin-top:8px"><span class="badge amber">Reuse permission not established</span></div></div></div>`;
  } catch (error) {
    target.innerHTML = `<div class="error" role="alert">${esc(error.message)}</div>`;
  } finally {
    metadataBusy = false;
  }
}
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-nav]");
  if (link && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    go(link.getAttribute("href"));
    return;
  }
  const kind = e.target.closest("[data-kind]");
  if (kind) {
    document
      .querySelectorAll("[data-kind]")
      .forEach((b) => b.classList.toggle("selected", b === kind));
    document.querySelector("[name=source_kind]").value = kind.dataset.kind;
    document.querySelector("#url-label").textContent =
      kind.dataset.kind === "video"
        ? "YouTube video URL"
        : "YouTube livestream URL";
    return;
  }
  const filter = e.target.closest("[data-filter]");
  if (filter) {
    currentFilter = filter.dataset.filter;
    render();
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "refresh") {
    await load();
    return;
  }
  if (action === "menu") {
    document.querySelector("#sidebar").classList.toggle("open");
    return;
  }
  if (action === "metadata") {
    await lookup();
    return;
  }
  if(e.target.closest("[data-oauth-readiness]")) {
    try {
      const r=await api("/api/youtube/readiness");
      document.querySelector("#oauth-readiness").innerHTML="<ul>"+r.blockers.map(x=>"<li>"+esc(x)+"</li>").join("")+"</ul><p>Channel connected: "+(r.channel_connected?"yes":"no")+" · Required scopes: "+(r.scopes_ready?"ready":"not ready")+"</p>";
    } catch(error){toast(error.message);}
    return;
  }
  const operation=e.target.closest("[data-regenerate],[data-history],[data-readiness],[data-intent]");
  if(operation) {
    const kind=["regenerate","history","readiness","intent"].find(k=>operation.dataset[k]);
    const id=operation.dataset[kind],c=state.clips.find(x=>x.id===id);
    operation.disabled=true;
    try {
      const result=kind==="history"?await api("/api/clips/"+id+"/history"):
        await post("/api/clips/"+id+"/"+(kind==="intent"?"upload-intent":kind),{expected_hash:c.metadata_hash});
      if(kind==="regenerate") {toast("Deterministic metadata regenerated. Review and approve it again.");await load();}
      else {
        if(result.media_changed)await load();
        const box=document.querySelector('[data-review-result="'+id+'"]');
        if(box) {
          if(kind==="history")box.innerHTML="<h4>Approval history</h4>"+(result.history.length?result.history.map(x=>'<p><strong>'+esc(x.action)+'</strong> · '+esc(date(x.created_at))+'<br>'+esc(x.snapshot.title)+' · Metadata '+esc(x.snapshot.metadata_version)+' / Media '+esc(x.snapshot.media_revision)+'</p>').join(""):"<p>No review events yet.</p>");
          else if(kind==="intent") {box.textContent="Upload intent "+result.intent.id+" saved as "+result.intent.state+". Nothing was uploaded.";await load();}
          else box.innerHTML="<p><strong>"+(result.preparation_ready?"Ready to prepare an upload intent.":"Preparation is blocked.")+"</strong></p><ul>"+result.blockers.map(x=>"<li>"+esc(x)+"</li>").join("")+"</ul><p>Live uploads remain disabled.</p>";
        }
      }
    } catch(error) {toast(error.message);}
    finally {operation.disabled=false;}
    return;
  }
  const preparation = e.target.closest("[data-prepare]");
  if (preparation) {
    preparation.disabled = true;
    try {
      const c = state.clips.find((clip) => clip.id === preparation.dataset.prepare);
      if (!c) throw new Error("Refresh the clip library before preparing metadata.");
      const data = await post("/api/clips/" + c.id + "/preparation", { expected_hash: c.metadata_hash });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = "publishing-preparation-" + c.id + ".json";
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Preparation downloaded. It does not authorize an upload.");
    } catch (error) { toast(error.message); }
    finally { preparation.disabled = false; }
    return;
  }
  const wake = e.target.closest("[data-wake]");
  const remove = e.target.closest("[data-cleanup]");
  if (wake || remove) {
    const b = wake || remove;
    b.disabled = true;
    try {
      await post(
        `/api/jobs/${b.dataset.wake || b.dataset.cleanup}/${wake ? "dispatch" : "cleanup"}`,
      );
      toast(
        wake
          ? "Worker wake requested for the existing job."
          : "Generated files removed; job history retained.",
      );
      await load();
    } catch (error) {
      toast(error.message);
      b.disabled = false;
    }
    return;
  }
  const retry = e.target.closest("[data-retry]");
  const review = e.target.closest("[data-review]");
  try {
    if (retry) {
      retry.disabled = true;
      const result = await post(`/api/jobs/${retry.dataset.retry}/retry`);
      toast(generationNotice(result));
      await load();
    }
    if (review) {
      review.disabled = true;
      await post(`/api/clips/${review.dataset.review}/review`, {
        decision: review.dataset.decision,
        expected_hash: state.clips.find((clip) => clip.id === review.dataset.review)?.metadata_hash,
      });
      toast("Review decision saved. Nothing was uploaded.");
      await load();
    }
    if (action === "disconnect") {
      await post("/api/youtube/disconnect");
      toast("Saved channel connection removed.");
      await load();
    }
  } catch (error) {
    toast(error.message);
    if (retry) retry.disabled = false;
    if (review) review.disabled = false;
  }
});
document.addEventListener(
  "error",
  async (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !video.dataset.preview) return;
    const box = video
      .closest(".clip-card")
      ?.querySelector("[data-preview-error]");
    if (!box) return;
    box.hidden = false;
    box.textContent = "Checking private video availability…";
    try {
      const result = await fetch(`/api/clips/${video.dataset.preview}/video`, {
        method: "HEAD",
        credentials: "same-origin",
        redirect: "error",
      });
      const messages = {
        401: "Your session has ended. Refresh this page and sign in again to view the private clip.",
        403: "Private clip access was denied. Refresh this page to check your sign-in.",
        404: "This clip is no longer available. Open Source & history to check its job.",
        410: "The clip expired or its file is missing. Open Source & history to review cleanup and regeneration with current source rights.",
        429: "The private storage request limit was reached. Check cloud usage before retrying playback.",
        503: "Private media serving is paused. Check account allowances and cloud configuration in Settings.",
      };
      box.textContent =
        messages[result.status] ||
        "Playback could not start. Retry the preview or open Source & history to review the cloud result.";
      if (result.ok) {
        const retry = document.createElement("button");
        retry.className = "btn small section-space";
        retry.textContent = "Retry preview";
        retry.onclick = () => {
          box.hidden = true;
          video.load();
        };
        box.append(document.createElement("br"), retry);
      }
    } catch {
      box.textContent =
        "The private video connection failed or sign-in is required. Refresh the page, then check Source & history if playback still fails.";
    }
  },
  true,
);
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.matches("[data-metadata-clip]")) {
    e.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const errorEl = form.querySelector(".error");
    button.disabled = true; errorEl.textContent = "";
    try {
      const values = new FormData(form);
      await post("/api/clips/" + form.dataset.metadataClip + "/metadata", {
        title: values.get("title"), description: values.get("description"), hashtags: String(values.get("hashtags") || "").split(/[\s,]+/).filter(Boolean), opening_hook: values.get("opening_hook"), expected_hash: form.dataset.metadataHash,
      });
      toast("Metadata saved. Changed metadata requires a new approval; nothing was uploaded.");
      await load();
    } catch (error) { errorEl.textContent = error.message; button.disabled = false; }
    return;
  }
  if (!["new-job-form", "auth-form", "settings-form"].includes(form.id)) return;
  e.preventDefault();
  const button = form.querySelector("button[type=submit],.form-footer button");
  const errorEl = form.querySelector(".error");
  if (errorEl) errorEl.textContent = "";
  if (button) button.disabled = true;
  try {
    if (form.id === "new-job-form") {
      const f = new FormData(form);
      const result = await post("/api/jobs", {
        url: f.get("url"),
        source_kind: f.get("source_kind"),
        options: formOptions(form),
        authorization: formAuth(form),
      });
      await load();
      go("/jobs/" + result.id);
      toast(generationNotice(result));
    }
    if (form.id === "auth-form") {
      const result = await post(
        `/api/jobs/${form.dataset.job}/authorization`,
        formAuth(form),
      );
      document.activeElement?.blur();
      await load();
      toast(generationNotice(result));
    }
    if (form.id === "settings-form") {
      const result = await post("/api/settings", formOptions(form));
      state.preferences = result.preferences;
      toast("Clipping defaults saved in the cloud.");
    }
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = error.message;
      if (error.existing_job) {
        const a = document.createElement("a");
        a.href = "/jobs/" + error.existing_job;
        a.dataset.nav = "";
        a.textContent = " Open the existing job →";
        errorEl.append(a);
      }
    } else toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "global-search") {
    search = e.target.value;
    if (!["/jobs", "/clips", "/review"].includes(route)) {
      route = "/jobs";
      history.pushState({}, "", route);
    }
    const pos = e.target.selectionStart;
    render();
    const next = document.querySelector("#global-search");
    next.focus();
    next.setSelectionRange(pos, pos);
  }
});
document.addEventListener("change", (e) => {
  if (
    e.target.name === "approved" &&
    document.querySelector("#source-status")
  ) {
    const b = document.querySelector("#source-status");
    b.textContent = e.target.checked
      ? "Evidence will be validated"
      : "Not authorized";
    b.className = "badge amber";
  }
});
window.addEventListener("popstate", () => {
  route = location.pathname;
  detail = null;
  render();
  loadDetail();
});
load();
setInterval(() => {
  if (
    document.visibilityState === "visible" &&
    !document.activeElement?.closest("form") &&
    route !== "/jobs/new" &&
    route !== "/settings" &&
    !Array.from(document.querySelectorAll("video")).some((v) => !v.paused)
  )
    load();
}, 30000);
