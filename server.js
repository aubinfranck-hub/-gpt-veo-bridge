import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const MCP_API_KEY = process.env.MCP_API_KEY;

function checkAuth(req, res, next) {
  if (!BRIDGE_API_KEY) return res.status(500).json({ error: "BRIDGE_API_KEY is not configured" });
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${BRIDGE_API_KEY}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function checkMcpAuth(req, res, next) {
  if (!MCP_API_KEY) return res.status(500).json({ error: "MCP_API_KEY is not configured" });
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_API_KEY}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function signedDownloadToken(operationName, expiresAt) {
  return crypto.createHmac("sha256", BRIDGE_API_KEY)
    .update(`${operationName}.${expiresAt}`)
    .digest("hex");
}

function verifyDownloadToken(operationName, expiresAt, token) {
  if (!operationName || !expiresAt || !token || Date.now() > Number(expiresAt)) return false;
  const expected = signedDownloadToken(operationName, expiresAt);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

async function startVeoGeneration({ prompt, model = "veo-3.1-generate-preview", aspect_ratio = "16:9", resolution = "720p", duration_seconds = 8 }) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured on the server");
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`;

  const body = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio: aspect_ratio,
      resolution,
      durationSeconds: duration_seconds
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GOOGLE_API_KEY
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error("Google Veo API error");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function getVeoOperation(operationName) {
  if (!GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured on the server");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${operationName}`;
  const response = await fetch(endpoint, {
    headers: { "x-goog-api-key": GOOGLE_API_KEY }
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error("Google operation API error");
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

function extractVideoUri(operation) {
  return operation?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
      || operation?.response?.generatedVideos?.[0]?.video?.uri
      || null;
}

function buildDownloadUrl(operationName) {
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  const token = signedDownloadToken(operationName, expiresAt);
  return `https://gpt-veo-bridge.onrender.com/download-video?operation=${encodeURIComponent(operationName)}&expires=${expiresAt}&token=${token}`;
}

async function createMcpServer() {
  const server = new McpServer(
    { name: "gpt-veo-bridge", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate a Veo video",
      description: "Generate a video with Google Veo 3.1 from a text prompt. Waits for completion and returns a temporary MP4 download URL.",
      inputSchema: {
        prompt: z.string().min(1).describe("Detailed video prompt"),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional().default("16:9"),
        resolution: z.enum(["720p", "1080p", "4k"]).optional().default("720p"),
        duration_seconds: z.number().int().min(4).max(8).optional().default(8)
      }
    },
    async ({ prompt, aspect_ratio, resolution, duration_seconds }) => {
      try {
        const operation = await startVeoGeneration({ prompt, aspect_ratio, resolution, duration_seconds });
        const operationName = operation?.name;
        if (!operationName) throw new Error("Google did not return an operation name");

        const deadline = Date.now() + 150000;
        let current = operation;
        while (!current.done && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 8000));
          current = await getVeoOperation(operationName);
        }

        if (!current.done) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              success: true,
              status: "processing",
              operation: operationName,
              message: "Video generation is still processing. Use check_video_generation with the operation name."
            }) }]
          };
        }

        if (current.error) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ success: false, error: current.error }) }]
          };
        }

        const videoUri = extractVideoUri(current);
        if (!videoUri) throw new Error("Video completed but no video URI was returned");

        return {
          content: [{ type: "text", text: JSON.stringify({
            success: true,
            status: "completed",
            operation: operationName,
            video_url: buildDownloadUrl(operationName)
          }) }],
          structuredContent: {
            success: true,
            status: "completed",
            operation: operationName,
            video_url: buildDownloadUrl(operationName)
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({
            success: false,
            error: error.message,
            details: error.details || null
          }) }]
        };
      }
    }
  );

  server.registerTool(
    "check_video_generation",
    {
      title: "Check Veo video generation",
      description: "Check a previously started Google Veo video generation operation and return a temporary MP4 download URL when complete.",
      inputSchema: {
        operation: z.string().min(1).describe("Google operation name returned by generate_video")
      }
    },
    async ({ operation }) => {
      try {
        const current = await getVeoOperation(operation);
        if (!current.done) {
          return { content: [{ type: "text", text: JSON.stringify({ success: true, status: "processing", operation }) }] };
        }
        if (current.error) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: current.error }) }] };
        }
        const videoUri = extractVideoUri(current);
        if (!videoUri) throw new Error("Video completed but no video URI was returned");
        const result = { success: true, status: "completed", operation, video_url: buildDownloadUrl(operation) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: error.message }) }] };
      }
    }
  );

  return server;
}

app.get("/", (req, res) => res.json({ service: "GPT Veo Bridge", status: "online", version: "2.0.0", mcp: "/mcp" }));
app.get("/health", (req, res) => res.json({
  status: "ok",
  google_api_configured: Boolean(GOOGLE_API_KEY),
  bridge_auth_configured: Boolean(BRIDGE_API_KEY),
  mcp_auth_configured: Boolean(MCP_API_KEY)
}));

app.post("/generate-video", checkAuth, async (req, res) => {
  try {
    const operation = await startVeoGeneration(req.body);
    res.json({ success: true, status: "processing", operation });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, details: error.details || null });
  }
});

app.get("/download-video", async (req, res) => {
  try {
    const { operation, expires, token } = req.query;
    if (!verifyDownloadToken(operation, expires, token)) return res.status(401).json({ error: "Invalid or expired download token" });
    const current = await getVeoOperation(operation);
    if (!current.done) return res.status(409).json({ error: "Video is still processing" });
    const videoUri = extractVideoUri(current);
    if (!videoUri) return res.status(404).json({ error: "Video URI not available" });

    const videoResponse = await fetch(videoUri, { headers: { "x-goog-api-key": GOOGLE_API_KEY } });
    if (!videoResponse.ok) return res.status(videoResponse.status).send(await videoResponse.text());

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="veo-video.mp4"');
    res.setHeader("Cache-Control", "private, max-age=300");
    const buffer = Buffer.from(await videoResponse.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.all("/mcp", checkMcpAuth, async (req, res) => {
  const server = await createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.listen(PORT, () => console.log(`GPT Veo Bridge 2.0 running on port ${PORT}`));
