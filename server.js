import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/assets", express.static("public/assets", { maxAge: "1h", fallthrough: true }));

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const MCP_API_KEY = process.env.MCP_API_KEY;
// Optional extra key for Claude (can be removed from Render at any time).
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const MASCOT_B64 = process.env.DIAGASSIST_MASCOT_B64 || "";
const FEATURES_B64 = process.env.DIAGASSIST_FEATURES_B64 || "";

function auth(req, key) {
  return Boolean(key) && req.headers.authorization === `Bearer ${key}`;
}
function checkAuth(req, res, next) {
  if (!auth(req, BRIDGE_API_KEY) && !auth(req, CLAUDE_API_KEY)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function checkMcpAuth(req, res, next) {
  if (!auth(req, MCP_API_KEY) && !auth(req, CLAUDE_API_KEY)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function signedDownloadToken(operationName, expiresAt) {
  return crypto.createHmac("sha256", BRIDGE_API_KEY).update(`${operationName}.${expiresAt}`).digest("hex");
}
function verifyDownloadToken(operationName, expiresAt, token) {
  if (!operationName || !expiresAt || !token || Date.now() > Number(expiresAt)) return false;
  const expected = Buffer.from(signedDownloadToken(operationName, expiresAt));
  const given = Buffer.from(String(token));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Veo only accepts raster images (PNG/JPEG/WebP) as references: no SVG.
const assets = [
  { name: "diagassist-logo.png", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-logo.png", type: "logo" },
  { name: "diagassist-mascot.png", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-mascot.png", type: "mascot" },
  { name: "diagassist-features.jpg", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-features.jpg", type: "features" }
];

function serveEnvImage(req, res, b64, type) {
  if (!b64) return res.status(404).json({ error: "Asset not configured" });
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(Buffer.from(b64, "base64"));
}
app.get("/assets/diagassist-features.jpg", (req,res) => serveEnvImage(req,res,FEATURES_B64,"image/jpeg"));

const ALLOWED_REF_TYPES = ["image/png", "image/jpeg", "image/webp"];
const { GoogleGenAI } = await import("@google/genai");
const googleAI = GOOGLE_API_KEY ? new GoogleGenAI({ apiKey: GOOGLE_API_KEY }) : null;

async function startVeoGeneration({ prompt, model = "veo-3.1-generate-preview", aspect_ratio = "16:9", resolution = "720p", duration_seconds = 8, reference_image_urls = [] }) {
  if (!Array.isArray(reference_image_urls) || reference_image_urls.length > 3) {
    throw new Error("reference_image_urls must contain at most 3 public HTTPS image URLs");
  }
  duration_seconds = Number(duration_seconds);
  // Veo 3.1: only 4, 6 or 8 s; 1080p/4k and reference images require 8 s.
  if (![4, 6, 8].includes(duration_seconds)) duration_seconds = 8;
  if (reference_image_urls.length > 0 || resolution !== "720p") duration_seconds = 8;
  if (!GOOGLE_API_KEY || !googleAI) throw new Error("GOOGLE_API_KEY is not configured on the server");
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  if (!/^veo-3\.1-(generate|fast-generate)-preview$/.test(model)) {
    throw new Error("Reference-image generation requires a Veo 3.1 model");
  }

  const referenceImages = [];
  for (const imageUrl of reference_image_urls) {
    if (!/^https:\/\//i.test(imageUrl)) throw new Error("Reference images must use HTTPS URLs");
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error(`Unable to fetch reference image: ${imageUrl}`);
    const mimeType = (imageResponse.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!ALLOWED_REF_TYPES.includes(mimeType)) throw new Error(`Reference image must be PNG, JPEG or WebP (got ${mimeType}): ${imageUrl}`);
    const imageBytes = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
    referenceImages.push({
      image: { imageBytes, mimeType },
      referenceType: "asset"
    });
  }

  const operation = await googleAI.models.generateVideos({
    model,
    prompt,
    config: {
      aspectRatio: aspect_ratio,
      resolution,
      durationSeconds: duration_seconds,
      ...(referenceImages.length ? { referenceImages } : {})
    }
  });
  return operation;
}

async function getVeoOperation(operationName) {
  if (!GOOGLE_API_KEY || !googleAI) throw new Error("GOOGLE_API_KEY is not configured on the server");
  return await googleAI.operations.getVideosOperation({ operation: { name: operationName } });
}

function extractVideoUri(o) {
  return o?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || o?.response?.generatedVideos?.[0]?.video?.uri || null;
}
function buildDownloadUrl(operationName) {
  const expiresAt=Date.now()+2*60*60*1000;
  const token=signedDownloadToken(operationName,expiresAt);
  return `https://gpt-veo-bridge.onrender.com/download-video?operation=${encodeURIComponent(operationName)}&expires=${expiresAt}&token=${token}`;
}


// ---- Seedance (BytePlus ModelArk) ----
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_BASE_URL = process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3";
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || "dreamina-seedance-2-0-260128";
async function arkFetch(path, options = {}) {
  if (!ARK_API_KEY) throw new Error("ARK_API_KEY is not configured on the server");
  const r = await fetch(`${ARK_BASE_URL}${path}`, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${ARK_API_KEY}`, ...(options.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data?.error?.message || `Seedance API error ${r.status}`); e.status = r.status; e.details = data; throw e; }
  return data;
}
async function startSeedance({ prompt, model, aspect_ratio = "9:16", resolution = "720p", duration_seconds = 8, generate_audio = true, reference_image_urls = [] }) {
  const content = [{ type: "text", text: prompt }];
  for (const url of reference_image_urls) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  return arkFetch("/contents/generations/tasks", { method: "POST", body: JSON.stringify({ model: model || SEEDANCE_MODEL, content, ratio: aspect_ratio, resolution, duration: duration_seconds, generate_audio, watermark: false }) });
}
function seedanceResult(t) {
  if (t.status === "succeeded") return { success: true, status: "completed", task_id: t.id, video_url: t.content?.video_url };
  if (t.status === "failed" || t.status === "cancelled" || t.status === "expired") return { success: false, status: t.status, task_id: t.id, error: t.error || null };
  return { success: true, status: "processing", task_id: t.id };
}

async function createMcpServer() {
  const server=new McpServer({name:"gpt-veo-bridge",version:"2.1.0"},{capabilities:{tools:{}}});
  server.registerTool("list_visual_assets",{
    title:"List visual assets",
    description:"List the DiagAssist logo, mascot and features visual available as public HTTPS references for Veo.",
    inputSchema:{}
  },async()=>{
    const available=assets.filter(a=>a.type!=="features" || FEATURES_B64);
    return {content:[{type:"text",text:JSON.stringify({assets:available})}],structuredContent:{assets:available}};
  });
  server.registerTool("generate_video",{
    title:"Generate a Veo video",
    description:"Generate a video with Google Veo 3.1. Supports up to 3 public HTTPS reference images.",
    inputSchema:{
      prompt:z.string().min(1),
      aspect_ratio:z.enum(["16:9","9:16"]).optional().default("16:9"),
      resolution:z.enum(["720p","1080p","4k"]).optional().default("720p"),
      duration_seconds:z.union([z.literal(4),z.literal(6),z.literal(8)]).optional().default(8).describe("4, 6 or 8 seconds. Forced to 8 for 1080p/4k or when reference images are used."),
      model:z.enum(["veo-3.1-generate-preview","veo-3.1-fast-generate-preview"]).optional().default("veo-3.1-generate-preview").describe("Fast model is cheaper."),
      reference_image_urls:z.array(z.string().url()).max(3).optional().default([])
    }
  },async(args)=>{
    try {
      const operation=await startVeoGeneration(args);
      const operationName=operation?.name;
      if(!operationName) throw new Error("Google did not return an operation name");
      const deadline=Date.now()+150000; let current=operation;
      while(!current.done && Date.now()<deadline){ await new Promise(r=>setTimeout(r,8000)); current=await getVeoOperation(operationName); }
      if(!current.done) return {content:[{type:"text",text:JSON.stringify({success:true,status:"processing",operation:operationName})}]};
      if(current.error) return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:current.error})}]};
      if(!extractVideoUri(current)) throw new Error("Video completed but no video URI was returned");
      const result={success:true,status:"completed",operation:operationName,video_url:buildDownloadUrl(operationName)};
      return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result};
    } catch(error) {
      return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:error.message,details:error.details||null})}]};
    }
  });
  server.registerTool("check_video_generation",{
    title:"Check Veo video generation",
    description:"Check a Google Veo operation and return a temporary MP4 URL when complete.",
    inputSchema:{operation:z.string().min(1)}
  },async({operation})=>{
    try{
      const current=await getVeoOperation(operation);
      if(!current.done) return {content:[{type:"text",text:JSON.stringify({success:true,status:"processing",operation})}]};
      if(current.error) return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:current.error})}]};
      if(!extractVideoUri(current)) throw new Error("Video completed but no video URI was returned");
      const result={success:true,status:"completed",operation,video_url:buildDownloadUrl(operation)};
      return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result};
    }catch(error){return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:error.message})}]};}
  });
  server.registerTool("generate_video_seedance",{
    title:"Generate a Seedance video",
    description:"Generate a video (with audio) using ByteDance Seedance via BytePlus ModelArk. Returns a task_id; poll with check_seedance_video.",
    inputSchema:{
      prompt:z.string().min(1),
      aspect_ratio:z.enum(["16:9","4:3","1:1","3:4","9:16","21:9"]).optional().default("9:16"),
      resolution:z.enum(["480p","720p","1080p"]).optional().default("720p"),
      duration_seconds:z.number().int().min(4).max(15).optional().default(8),
      generate_audio:z.boolean().optional().default(true),
      model:z.string().optional().describe("Override the Seedance model id."),
      reference_image_urls:z.array(z.string().url()).max(4).optional().default([])
    }
  },async(args)=>{
    try{const t=await startSeedance(args);const res={success:true,status:"processing",task_id:t.id};return {content:[{type:"text",text:JSON.stringify(res)}],structuredContent:res};}
    catch(error){return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:error.message,details:error.details||null})}]};}
  });
  server.registerTool("generate_series_seedance",{
    title:"Generate a video series with Seedance",
    description:"Start several Seedance videos at once (one per scene) with a shared style and shared reference images (e.g. the mascot) so a series stays consistent. Returns one task_id per scene; poll each with check_seedance_video.",
    inputSchema:{
      style:z.string().optional().default("").describe("Shared visual/voice style prepended to every scene prompt."),
      scenes:z.array(z.string().min(1)).min(1).max(10),
      aspect_ratio:z.enum(["16:9","4:3","1:1","3:4","9:16","21:9"]).optional().default("9:16"),
      resolution:z.enum(["480p","720p","1080p"]).optional().default("720p"),
      duration_seconds:z.number().int().min(4).max(15).optional().default(8),
      generate_audio:z.boolean().optional().default(true),
      reference_image_urls:z.array(z.string().url()).max(4).optional().default([])
    }
  },async({style,scenes,...rest})=>{
    const out=[];
    for(let i=0;i<scenes.length;i++){
      try{const t=await startSeedance({...rest,prompt:(style?style+"\n":"")+scenes[i]});out.push({scene:i+1,task_id:t.id,status:"processing"});}
      catch(error){out.push({scene:i+1,error:error.message,details:error.details||null});}
    }
    return {content:[{type:"text",text:JSON.stringify({success:out.every(o=>o.task_id),scenes:out})}]};
  });
  server.registerTool("check_seedance_video",{
    title:"Check Seedance video generation",
    description:"Check a Seedance task; returns video_url when completed.",
    inputSchema:{task_id:z.string().min(1)}
  },async({task_id})=>{
    try{const res=seedanceResult(await arkFetch(`/contents/generations/tasks/${encodeURIComponent(task_id)}`));return {isError:!res.success,content:[{type:"text",text:JSON.stringify(res)}]};}
    catch(error){return {isError:true,content:[{type:"text",text:JSON.stringify({success:false,error:error.message,details:error.details||null})}]};}
  });
  return server;
}

app.get("/",(req,res)=>res.json({service:"GPT Veo Bridge",status:"online",version:"2.1.0",mcp:"/mcp"}));
app.get("/health",(req,res)=>res.json({status:"ok",google_api_configured:Boolean(GOOGLE_API_KEY),bridge_auth_configured:Boolean(BRIDGE_API_KEY),mcp_auth_configured:Boolean(MCP_API_KEY),seedance_configured:Boolean(ARK_API_KEY),diagassist_mascot_configured:true,diagassist_features_configured:Boolean(FEATURES_B64)}));
app.post("/generate-video",checkAuth,async(req,res)=>{try{res.json({success:true,status:"processing",operation:await startVeoGeneration(req.body)});}catch(error){res.status(error.status||500).json({error:error.message,details:error.details||null});}});
app.get("/download-video",async(req,res)=>{
  try{
    const {operation,expires,token}=req.query;
    if(!verifyDownloadToken(operation,expires,token)) return res.status(401).json({error:"Invalid or expired download token"});
    const current=await getVeoOperation(operation);
    if(!current.done) return res.status(409).json({error:"Video is still processing"});
    const videoUri=extractVideoUri(current); if(!videoUri) return res.status(404).json({error:"Video URI not available"});
    const r=await fetch(videoUri,{headers:{"x-goog-api-key":GOOGLE_API_KEY}});
    if(!r.ok) return res.status(r.status).send(await r.text());
    res.setHeader("Content-Type","video/mp4"); res.setHeader("Content-Disposition",'attachment; filename="veo-video.mp4"'); res.send(Buffer.from(await r.arrayBuffer()));
  }catch(error){res.status(500).json({error:error.message});}
});
app.all("/mcp",checkMcpAuth,async(req,res)=>{
  const server=await createMcpServer();
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on("close",()=>{transport.close().catch(()=>{});server.close().catch(()=>{});});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
  catch(error){console.error("MCP error:",error);if(!res.headersSent)res.status(500).json({jsonrpc:"2.0",error:{code:-32603,message:"Internal server error"},id:null});}
});
app.listen(PORT,()=>console.log(`GPT Veo Bridge 2.1 running on port ${PORT}`));