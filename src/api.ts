export interface Env {
  WAVS_IN: R2Bucket;
  JOB_STATUS: KVNamespace;
  CLONE_JOBS: Queue;
  BOT_PUBLIC_BASE: string;   // p.ej. https://kits-clone-bot.lucasmallo.workers.dev
  PUBLIC_ORIGINS?: string;   // lista CSV de orígenes permitidos
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return withCors(new Response(null, {status:204}), env);

    try {
      if (url.pathname === "/ping") {
        return withCors(json({ok:true, ts:Date.now()}), env);
      }

      // 1) Subida de WAV (multipart/form-data con campo "file")
      if (url.pathname === "/upload" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file") as File | null;
        if (!file) return withCors(json({ok:false, error:"file missing"},400), env);

        const key = `u/${crypto.randomUUID()}_${sanitize(file.name || "clip.wav")}`;
        await env.WAVS_IN.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "audio/wav" }
        });

        // URL pública que el Bot puede fetch-ear (la sirve tu Bot Worker actual)
        const fileUrl = `${env.BOT_PUBLIC_BASE}/file/${encodeURIComponent(key)}`;
        return withCors(json({ok:true, fileKey:key, fileUrl}), env);
      }

      // 2) Crear job y encolarlo
      if (url.pathname === "/jobs" && req.method === "POST") {
        const body = await safeJson(req);
        const fileUrl = String(body.fileUrl || "");
        const voiceName = String(body.voiceName || "");
        const userId = String(body.userId || "anon");
        const consent = !!body.consent;

        if (!fileUrl || !voiceName) {
          return withCors(json({ok:false, error:"fileUrl and voiceName required"},400), env);
        }

        // Rate-limit simple: 10 jobs/min por user
        const allowed = await rateLimit(env, userId, 10, 60_000);
        if (!allowed) return withCors(json({ok:false, error:"rate_limited"},429), env);

        const jobId = crypto.randomUUID();
        const job = { jobId, fileUrl, voiceName, userId, consent, createdAt: Date.now() };

        await env.JOB_STATUS.put(jobId, JSON.stringify({status:"queued", job}));
        await env.CLONE_JOBS.send(job);

        return withCors(json({ok:true, jobId}), env);
      }

      // 3) Consultar estado del job
      const m = url.pathname.match(/^\/jobs\/([0-9a-f-]{36})$/i);
      if (m && req.method === "GET") {
        const jobId = m[1];
        const raw = await env.JOB_STATUS.get(jobId, "json") as any;
        if (!raw) return withCors(json({ok:false, error:"not_found"},404), env);
        return withCors(json({ok:true, ...raw}), env);
      }

      return withCors(new Response("Not found", {status:404}), env);
    } catch (err:any) {
      return withCors(json({ok:false, error: err?.message || String(err)},500), env);
    }
  }
};

// ---------- helpers ----------
function sanitize(s:string){ return s.replace(/[^a-z0-9_\-\.]/gi,"_"); }
function json(obj:any,status=200){ return new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}}); }
async function safeJson(req:Request){ try{ return await req.json(); }catch{ return {}; } }

function withCors(resp:Response, env:Env){
  const h = new Headers(resp.headers);
  const origins = (env.PUBLIC_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
  h.set("Access-Control-Allow-Origin", origins.length ? origins.join(",") : "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Vary", "Origin");
  return new Response(resp.body, {status:resp.status, headers:h});
}

// Token bucket en KV
async function rateLimit(env:Env, key:string, maxCount:number, windowMs:number){
  const now = Date.now();
  const bucketKey = `rl:${key}:${Math.floor(now/windowMs)}`;
  const n = await env.JOB_STATUS.get(bucketKey);
  const count = n ? parseInt(n) : 0;
  if (count >= maxCount) return false;
  await env.JOB_STATUS.put(bucketKey, String(count+1), {expirationTtl: Math.ceil(windowMs/1000)+5});
  return true;
}
