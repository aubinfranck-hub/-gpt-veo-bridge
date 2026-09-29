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
const MASCOT_B64 = process.env.DIAGASSIST_MASCOT_B64 || "";
const FEATURES_B64 = process.env.DIAGASSIST_FEATURES_B64 || "";

function auth(req, key) {
  return Boolean(key) && req.headers.authorization === `Bearer ${key}`;
}
function checkAuth(req, res, next) {
  if (!auth(req, BRIDGE_API_KEY)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function checkMcpAuth(req, res, next) {
  if (!auth(req, MCP_API_KEY)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function signedDownloadToken(operationName, expiresAt) {
  return crypto.createHmac("sha256", BRIDGE_API_KEY).update(`${operationName}.${expiresAt}`).digest("hex");
}
function verifyDownloadToken(operationName, expiresAt, token) {
  if (!operationName || !expiresAt || !token || Date.now() > Number(expiresAt)) return false;
  const expected = signedDownloadToken(operationName, expiresAt);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

const assets = [
  { name: "diagassist-logo.svg", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-logo.svg", type: "logo" },
  { name: "diagassist-mascot.jpg", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-mascot.jpg", type: "mascot" },
  { name: "diagassist-features.jpg", url: "https://gpt-veo-bridge.onrender.com/assets/diagassist-features.jpg", type: "features" }
];

function serveEnvImage(req, res, b64, type) {
  if (!b64) return res.status(404).json({ error: "Asset not configured" });
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(Buffer.from(b64, "base64"));
}
app.get("/assets/diagassist-mascot.jpg", (req,res) => serveEnvImage(req,res,MASCOT_B64,"image/jpeg"));
app.get("/assets/diagassist-features.jpg", (req,res) => serveEnvImage(req,res,FEATURES_B64,"image/jpeg"));

async function startVeoGeneration({ prompt, model="veo-3.1-generate-preview", aspect_ratio="16:9", resolution="720p", duration_seconds=8, reference_image_urls=[] }) {
  if (!Array.isArray(reference_image_urls) || reference_image_urls.length > 3) throw new Error("reference_image_urls must contain at most 3 public HTTPS image URLs");
  if (reference_image_urls.length && duration_seconds !== 8) duration_seconds = 8;
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured on the server");
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`;
  const instance = { prompt };
  if (reference_image_urls.length) {
    instance.referenceImages = [];
    for (const imageUrl of reference_image_urls) {
      if (!/^https:\/\//i.test(imageUrl)) throw new Error("Reference images must use HTTPS URLs");
      const r = await fetch(imageUrl);
      if (!r.ok) throw new Error(`Unable to fetch reference image: ${imageUrl}`);
      const mimeType = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
      if (!mimeType.startsWith("image/")) throw new Error(`Reference URL is not an image: ${imageUrl}`);
      const data = Buffer.from(await r.arrayBuffer()).toString("base64");
      instance.referenceImages.push({ image:{inlineData:{mimeType,data}}, referenceType:"asset" });
    }
  }
  const response = await fetch(endpoint,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":GOOGLE_API_KEY},
    body:JSON.stringify({instances:[instance],parameters:{aspectRatio:aspect_ratio,resolution,durationSeconds:duration_seconds}})
  });
  const data = await response.json();
  if (!response.ok) { const e=new Error("Google Veo API error"); e.status=response.status; e.details=data; throw e; }
  return data;
}
async function getVeoOperation(operationName) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured on the server");
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/${operationName}`,{headers:{"x-goog-api-key":GOOGLE_API_KEY}});
  const data=await r.json();
  if (!r.ok) { const e=new Error("Google operation API error"); e.status=r.status; e.details=data; throw e; }
  return data;
}
function extractVideoUri(o) {
  return o?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri || o?.response?.generatedVideos?.[0]?.video?.uri || null;
}
function buildDownloadUrl(operationName) {
  const expiresAt=Date.now()+2*60*60*1000;
  const token=signedDownloadToken(operationName,expiresAt);
  return `https://gpt-veo-bridge.onrender.com/download-video?operation=${encodeURIComponent(operationName)}&expires=${expiresAt}&token=${token}`;
}

async function createMcpServer() {
  const server=new McpServer({name:"gpt-veo-bridge",version:"2.1.0"},{capabilities:{tools:{}}});
  server.registerTool("list_visual_assets",{
    title:"List visual assets",
    description:"List the DiagAssist logo, mascot and features visual available as public HTTPS references for Veo.",
    inputSchema:{}
  },async()=>{
    const available=assets.filter(a=>a.type==="logo" || (a.type==="mascot" && MASCOT_B64) || (a.type==="features" && FEATURES_B64));
    return {content:[{type:"text",text:JSON.stringify({assets:available})}],structuredContent:{assets:available}};
  });
  server.registerTool("generate_video",{
    title:"Generate a Veo video",
    description:"Generate a video with Google Veo 3.1. Supports up to 3 public HTTPS reference images.",
    inputSchema:{
      prompt:z.string().min(1),
      aspect_ratio:z.enum(["16:9","9:16"]).optional().default("16:9"),
      resolution:z.enum(["720p","1080p","4k"]).optional().default("720p"),
      duration_seconds:z.number().int().min(4).max(8).optional().default(8),
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
  return server;
}

app.get("/",(req,res)=>res.json({service:"GPT Veo Bridge",status:"online",version:"2.1.0",mcp:"/mcp"}));
app.get("/health",(req,res)=>res.json({status:"ok",google_api_configured:Boolean(GOOGLE_API_KEY),bridge_auth_configured:Boolean(BRIDGE_API_KEY),mcp_auth_configured:Boolean(MCP_API_KEY),diagassist_mascot_configured:Boolean(MASCOT_B64),diagassist_features_configured:Boolean(FEATURES_B64)}));
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