import { Problem } from "./domain.js";
const stop = new Set("the and that this with from have your you are for was were will not but can our they their about just into what when how then than also been its it's clip source video".split(" "));
const clean = (s, max) => String(s || "").normalize("NFKC").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export function hashtags(value = []) {
  const input = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  if (input.length > 15) throw new Problem("Use at most 15 hashtags.");
  const result = [];
  for (const item of input) {
    if (typeof item !== "string") throw new Problem("Hashtags must be text.");
    const tag = item.replace(/^#/, "").trim();
    if (!tag) continue;
    if (!/^[\p{L}\p{N}_]{1,40}$/u.test(tag)) throw new Problem("Hashtags use 1–40 letters, digits or underscores.");
    if (!result.some((x) => x.toLowerCase() === ("#" + tag).toLowerCase())) result.push("#" + tag);
  }
  return result;
}
export function generateMetadata({ transcript = "", sourceTitle = "", attribution = "", position = 1, variant = 0 } = {}) {
  const excerpt = clean(transcript, 6000);
  const fallback = clean(sourceTitle, 160) || "Source recording";
  const sentences = excerpt.split(/(?<=[.!?])\s+/u).filter((s) => s.length > 12);
  const sentence = sentences[variant % Math.max(1, sentences.length)] || excerpt;
  const title = clean(sentence, 100) || clean("Excerpt " + position + ": " + fallback, 100);
  const words = (excerpt || fallback).toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) || [];
  const frequencies = new Map();
  for (const word of words) if (!stop.has(word) && [...word].length <= 40) frequencies.set(word, (frequencies.get(word) || 0) + 1);
  const keywords = [...frequencies].sort((a,b) => b[1]-a[1] || (a[0]<b[0]?-1:1)).slice(0,4).map(([word])=>word);
  const tags = hashtags(["Shorts", ...keywords]);
  const source_attribution = String(attribution || "").trim().slice(0,1200);
  const summary = excerpt ? clean(excerpt, 800) : "An excerpt from " + fallback + ". Review the recording before publishing.";
  return {
    title, description: (summary + (source_attribution ? "\n\nSource attribution: " + source_attribution : "")).slice(0,5000),
    hashtags: tags, opening_hook: clean((sentence || fallback).split(/\s+/).slice(0,6).join(" "),120),
    source_attribution,
    commentary_suggestions: [
      "After watching, explain why this point matters in your own words.",
      "Add a concrete example or a counterpoint to the excerpt.",
      "Ask viewers what evidence would support or challenge this point."
    ],
    transcript_excerpt: excerpt,
    metadata_method: excerpt ? "deterministic-extractive-v1" : "source-title-fallback-v1",
    commentary_notice: "Suggestions only. No original commentary has been added to the video."
  };
}
export function completeMetadata(input, clip = {}) {
  if (!input || typeof input.title !== "string" || typeof input.description !== "string") throw new Problem("Title and description must be text.");
  const title = input.title.trim(), description = input.description.trim();
  if (!title || [...title].length > 100 || /[<>\r\n\u0000-\u001f]/.test(title)) throw new Problem("Use a title of 1–100 characters without angle brackets or control characters.");
  if ([...description].length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description)) throw new Problem("Description is limited to 5,000 characters.");
  const hook = input.opening_hook ?? clip.opening_hook ?? "";
  if (typeof hook !== "string" || [...hook].length > 120 || /[\u0000-\u001f<>]/.test(hook)) throw new Problem("Opening hook is limited to 120 plain-text characters.");
  let prior = clip.hashtags || [];
  if (typeof prior === "string") { try { prior = JSON.parse(prior); } catch { prior = []; } }
  return { title, description, hashtags: hashtags(input.hashtags ?? prior), opening_hook: hook.trim() };
}
export function clipFields(clip) {
  const parse = (value, fallback) => { try { return typeof value === "string" ? JSON.parse(value) : value || fallback; } catch { return fallback; } };
  return { ...clip, hashtags: parse(clip.hashtags,[]), commentary_suggestions: parse(clip.commentary_suggestions,[]) };
}
