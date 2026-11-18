import { Problem } from "./domain.js";

// This is a transport contract, not provider approval. No provider is enabled by default.
export const PROVIDER_CONTRACT = "purffle.worker.v1";
export const HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;
export function providerConfiguration(env) {
  const blockers = [];
  const provider = env.WORKER_PROVIDER || "none";
  if (provider !== "https")
    blockers.push("No authorized cloud worker is connected. GitHub Actions is not an application backend.");
  if (env.WORKER_BACKEND_AUTHORIZED !== "true")
    blockers.push("The selected provider's application-backend permission has not been verified.");
  if (env.WORKER_NO_CHARGE_VERIFIED !== "true")
    blockers.push("No-card, no-additional-charge worker allowances and enforced limits have not been verified.");
  let endpoint = null;
  try {
    const url = new URL(env.WORKER_DISPATCH_URL || "");
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        (url.port && url.port !== "443") || !host.includes(".") ||
        /[\[\]:]/.test(host) || /^[\d.]+$/.test(host) ||
        /(?:^|\.)(?:localhost|local|internal|test|example|invalid)$/.test(host) ||
        host !== String(env.WORKER_DISPATCH_HOST || "").toLowerCase() ||
        host === "api.github.com" || host.endsWith(".github.com"))
      throw new Error("invalid dispatch endpoint");
    endpoint = url.href;
  } catch {
    blockers.push("Configure one explicitly allowlisted public HTTPS cloud dispatch endpoint. Redirects and GitHub dispatch are disabled.");
  }
  if (typeof env.WORKER_DISPATCH_TOKEN !== "string" || env.WORKER_DISPATCH_TOKEN.length < 32)
    blockers.push("Configure a dedicated server-side dispatch secret of at least 32 characters.");
  return { provider, endpoint, blockers };
}
export function freshHeartbeat(value, time = Date.now()) {
  const seen = Date.parse(value || "");
  return Number.isFinite(seen) && seen <= time && time - seen <= HEARTBEAT_MAX_AGE_MS;
}
export async function dispatchToProvider(env, job, send = fetch) {
  const config = providerConfiguration(env);
  if (config.blockers.length) throw new Problem(config.blockers.join(" "), 503);
  if (!job || !/^[\w-]{1,128}$/.test(job.id) || !Number.isInteger(job.attempt) || job.attempt < 1)
    throw new Problem("Invalid job dispatch identity.", 409);
  const idempotencyKey = job.id + ":" + job.attempt;
  let response;
  try {
    response = await send(config.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: "Bearer " + env.WORKER_DISPATCH_TOKEN,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      // No source URL, rights evidence, owner identity or worker callback credentials leave here.
      body: JSON.stringify({
        contract: PROVIDER_CONTRACT,
        job_id: job.id,
        attempt: job.attempt,
        idempotency_key: idempotencyKey,
      }),
    });
  } catch {
    throw new Problem("Cloud worker acceptance is unconfirmed. Retry waking this job, never create a duplicate.", 502);
  }
  if (response.status !== 202 || !response.headers.get("content-type")?.includes("application/json"))
    throw new Problem("The worker did not acknowledge this job using the dispatch contract.", 502);
  const text = await response.text();
  if (text.length > 4096) throw new Problem("Invalid worker acknowledgement.", 502);
  let ack;
  try { ack = JSON.parse(text); } catch { throw new Problem("Invalid worker acknowledgement.", 502); }
  if (ack.contract !== PROVIDER_CONTRACT || ack.job_id !== job.id ||
      ack.attempt !== job.attempt || ack.accepted !== true)
    throw new Problem("The worker acknowledgement does not match this job attempt.", 502);
  return { accepted: true, idempotency_key: idempotencyKey };
}
