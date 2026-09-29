import express from "express";

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

function checkAuth(req, res, next) {
    if (!BRIDGE_API_KEY) {
        return res.status(500).json({
            error: "BRIDGE_API_KEY is not configured"
        });
    }

    const auth = req.headers.authorization || "";

    if (auth !== `Bearer ${BRIDGE_API_KEY}`) {
        return res.status(401).json({
            error: "Unauthorized"
        });
    }

    next();
}

app.get("/", (req, res) => {
    res.json({
        service: "GPT Veo Bridge",
        status: "online",
        version: "1.0.0"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        google_api_configured: Boolean(GOOGLE_API_KEY),
        bridge_auth_configured: Boolean(BRIDGE_API_KEY)
    });
});

app.post("/generate-video", checkAuth, async (req, res) => {

    try {

        if (!GOOGLE_API_KEY) {
            return res.status(500).json({
                error: "GOOGLE_API_KEY is not configured on the server"
            });
        }

        const {
            prompt,
            model = "veo-3.1-generate-preview",
            aspect_ratio = "16:9",
            resolution = "720p",
            duration_seconds = 8
        } = req.body;

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({
                error: "prompt is required"
            });
        }

        /*
         * Google Veo API
         *
         * IMPORTANT:
         * The exact Veo model/API endpoint can change.
         * This bridge keeps the Google call isolated here.
         */

        const endpoint =
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning?key=${encodeURIComponent(GOOGLE_API_KEY)}`;

        const body = {
            instances: [
                {
                    prompt
                }
            ],
            parameters: {
                aspectRatio: aspect_ratio,
                resolution,
                durationSeconds: duration_seconds
            }
        };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: "Google Veo API error",
                details: data
            });
        }

        return res.json({
            success: true,
            status: "processing",
            operation: data
        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({
            error: "Internal server error",
            message: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`GPT Veo Bridge running on port ${PORT}`);
});
