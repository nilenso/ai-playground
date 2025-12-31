import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import {
	addTranscript,
	getOrCreateMeeting,
	getTranscripts,
	isLensoActive,
	setLensoActive,
	type TranscriptEntry,
} from "./db";
import { handleLensoQuery, transcribeWithGemini } from "./gemini";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// Cloudflare Calls credentials from environment
const CF_APP_ID = process.env.CF_APP_ID || "";
const CF_APP_TOKEN = process.env.CF_APP_TOKEN || "";
const CF_API_BASE = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`;

if (!CF_APP_ID || !CF_APP_TOKEN) {
	console.warn("Warning: CF_APP_ID and CF_APP_TOKEN not set. Cloudflare Calls will not work.");
}

const app = new Hono();

// Store connected peers - keyed by peerId, not ws internals
interface Peer {
	id: string;
	ws: WSContext;
	sessionId?: string;
	trackNames: string[];
	name: string;
	roomId: string;
}

const peers = new Map<string, Peer>();
const rooms = new Map<string, Set<string>>(); // roomId -> Set of peerIds

// Cloudflare Calls API helpers
async function cfFetch(endpoint: string, method: string, body?: unknown) {
	const res = await fetch(`${CF_API_BASE}${endpoint}`, {
		method,
		headers: {
			Authorization: `Bearer ${CF_APP_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json();
	if (!res.ok) {
		console.error("Cloudflare API error:", data);
		throw new Error(`CF API error: ${res.status}`);
	}
	return data;
}

async function createSession(): Promise<string> {
	const data = await cfFetch("/sessions/new", "POST");
	return data.sessionId;
}

async function pushTracks(
	sessionId: string,
	offer: RTCSessionDescriptionInit,
	tracks: { location: string; trackName: string }[],
) {
	const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, "POST", {
		sessionDescription: { type: "offer", sdp: offer.sdp },
		tracks,
	});
	return data;
}

async function pullTracks(sessionId: string, tracks: { location: string; trackName: string; sessionId: string }[]) {
	const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, "POST", {
		tracks,
	});
	return data;
}

async function renegotiate(sessionId: string, sdp: string) {
	const data = await cfFetch(`/sessions/${sessionId}/renegotiate`, "PUT", {
		sessionDescription: { type: "answer", sdp },
	});
	return data;
}

// API endpoints for Cloudflare Calls
app.post("/api/session/new", async (c) => {
	try {
		const sessionId = await createSession();
		return c.json({ sessionId });
	} catch (_e) {
		return c.json({ error: "Failed to create session" }, 500);
	}
});

app.post("/api/session/:sessionId/push", async (c) => {
	try {
		const { sessionId } = c.req.param();
		const { offer, tracks } = await c.req.json();

		console.log("[SERVER] Push request:", {
			sessionId,
			tracks,
			offerSdpLength: offer?.sdp?.length,
		});

		const result = await pushTracks(sessionId, offer, tracks);

		console.log("[SERVER] Push response:", {
			hasSessionDescription: !!result.sessionDescription,
			tracks: result.tracks,
			errorCode: result.errorCode,
		});

		return c.json(result);
	} catch (e) {
		console.error("[SERVER] Push tracks error:", e);
		return c.json({ error: "Failed to push tracks" }, 500);
	}
});

app.post("/api/session/:sessionId/pull", async (c) => {
	try {
		const { sessionId } = c.req.param();
		const { remoteSessionId, trackName } = await c.req.json();

		console.log("[SERVER] Pull request:", {
			mySessionId: sessionId,
			remoteSessionId,
			trackName,
		});

		const tracks = [
			{
				location: "remote",
				sessionId: remoteSessionId,
				trackName: trackName,
			},
		];

		console.log("[SERVER] Sending to CF API:", JSON.stringify({ tracks }, null, 2));

		const result = await pullTracks(sessionId, tracks);

		console.log("[SERVER] CF API response:", {
			requiresImmediateRenegotiation: result.requiresImmediateRenegotiation,
			hasSessionDescription: !!result.sessionDescription,
			tracks: result.tracks,
			errorCode: result.errorCode,
			errorDescription: result.errorDescription,
		});

		return c.json(result);
	} catch (e) {
		console.error("[SERVER] Pull tracks error:", e);
		return c.json({ error: "Failed to pull tracks" }, 500);
	}
});

app.put("/api/session/:sessionId/renegotiate", async (c) => {
	try {
		const { sessionId } = c.req.param();
		const { sdp } = await c.req.json();

		console.log("[SERVER] Renegotiate request:", {
			sessionId,
			sdpLength: sdp?.length,
		});

		const result = await renegotiate(sessionId, sdp);

		console.log("[SERVER] Renegotiate response:", {
			hasSessionDescription: !!result.sessionDescription,
			errorCode: result.errorCode,
		});

		return c.json(result);
	} catch (e) {
		console.error("[SERVER] Renegotiate error:", e);
		return c.json({ error: "Failed to renegotiate" }, 500);
	}
});

// Lenso API endpoints
app.post("/api/lenso/query", async (c) => {
	try {
		const { roomId, query } = await c.req.json();

		if (!roomId || !query) {
			return c.json({ error: "roomId and query are required" }, 400);
		}

		// Check if Lenso is active for this room
		if (!isLensoActive(roomId)) {
			return c.json({ error: "Lenso is not active for this room" }, 403);
		}

		const response = await handleLensoQuery(roomId, query);
		return c.json({ response });
	} catch (e) {
		console.error("[SERVER] Lenso query error:", e);
		return c.json({ error: "Failed to process query" }, 500);
	}
});

app.post("/api/lenso/toggle", async (c) => {
	try {
		const { roomId, active } = await c.req.json();

		if (!roomId || typeof active !== "boolean") {
			return c.json({ error: "roomId and active (boolean) are required" }, 400);
		}

		getOrCreateMeeting(roomId);
		setLensoActive(roomId, active);

		// Broadcast to all peers in the room
		const roomPeers = rooms.get(roomId);
		if (roomPeers) {
			roomPeers.forEach((peerId) => {
				const peer = peers.get(peerId);
				if (peer) {
					peer.ws.send(JSON.stringify({ type: "lenso-status", active }));
				}
			});
		}

		return c.json({ success: true, active });
	} catch (e) {
		console.error("[SERVER] Lenso toggle error:", e);
		return c.json({ error: "Failed to toggle Lenso" }, 500);
	}
});

app.get("/api/lenso/status/:roomId", async (c) => {
	try {
		const { roomId } = c.req.param();
		const active = isLensoActive(roomId);
		return c.json({ active });
	} catch (e) {
		return c.json({ error: "Failed to get status" }, 500);
	}
});

app.post("/api/transcript", async (c) => {
	try {
		const { roomId, speakerName, content } = await c.req.json();

		if (!roomId || !speakerName || !content) {
			return c.json({ error: "roomId, speakerName, and content are required" }, 400);
		}

		const entry = addTranscript(roomId, speakerName, content);

		// Broadcast transcript to all peers in the room
		const roomPeers = rooms.get(roomId);
		if (roomPeers) {
			roomPeers.forEach((peerId) => {
				const peer = peers.get(peerId);
				if (peer) {
					peer.ws.send(
						JSON.stringify({
							type: "transcript",
							entry: {
								speakerName: entry.speaker_name,
								content: entry.content,
								timestamp: entry.timestamp,
							},
						}),
					);
				}
			});
		}

		return c.json({ success: true, entry });
	} catch (e) {
		console.error("[SERVER] Transcript error:", e);
		return c.json({ error: "Failed to add transcript" }, 500);
	}
});

app.get("/api/transcripts/:roomId", async (c) => {
	try {
		const { roomId } = c.req.param();
		const limit = parseInt(c.req.query("limit") || "100");
		const transcripts = getTranscripts(roomId, limit);
		return c.json({ transcripts });
	} catch (e) {
		return c.json({ error: "Failed to get transcripts" }, 500);
	}
});

// Transcription endpoint for audio
app.post("/api/transcribe", async (c) => {
	try {
		const { audioBase64, mimeType, roomId, speakerName } = await c.req.json();

		if (!audioBase64 || !mimeType) {
			return c.json({ error: "audioBase64 and mimeType are required" }, 400);
		}

		// Check if Lenso is active
		if (roomId && !isLensoActive(roomId)) {
			return c.json({ text: "", skipped: true });
		}

		const text = await transcribeWithGemini(audioBase64, mimeType);

		// If we got text and have room info, save to transcript
		if (text && roomId && speakerName) {
			addTranscript(roomId, speakerName, text);

			// Broadcast to room
			const roomPeers = rooms.get(roomId);
			if (roomPeers) {
				roomPeers.forEach((peerId) => {
					const peer = peers.get(peerId);
					if (peer) {
						peer.ws.send(
							JSON.stringify({
								type: "transcript",
								entry: {
									speakerName,
									content: text,
									timestamp: Date.now(),
								},
							}),
						);
					}
				});
			}
		}

		return c.json({ text });
	} catch (e) {
		console.error("[SERVER] Transcription error:", e);
		return c.json({ error: "Failed to transcribe audio" }, 500);
	}
});

app.get("/", (c) => {
	return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lenso2 - Video Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      min-height: 100vh;
      color: white;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 15px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { font-size: 1.5rem; }
    .room-info { display: flex; align-items: center; gap: 15px; }
    .peer-count {
      background: rgba(255,255,255,0.2);
      padding: 8px 15px;
      border-radius: 20px;
      font-size: 0.9rem;
    }
    .lenso-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255,255,255,0.1);
      padding: 8px 15px;
      border-radius: 20px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .lenso-toggle:hover { background: rgba(255,255,255,0.2); }
    .lenso-toggle.active { background: rgba(76, 175, 80, 0.5); }
    .lenso-toggle .indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #666;
      transition: all 0.3s;
    }
    .lenso-toggle.active .indicator {
      background: #4CAF50;
      box-shadow: 0 0 10px #4CAF50;
    }
    .join-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: calc(100vh - 70px);
      padding: 20px;
    }
    .join-card {
      background: #16213e;
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .join-card h2 { margin-bottom: 10px; }
    .join-card p { color: #888; margin-bottom: 30px; }
    .input-group {
      margin-bottom: 20px;
    }
    .input-group label {
      display: block;
      text-align: left;
      margin-bottom: 8px;
      color: #aaa;
      font-size: 0.9rem;
    }
    .input-group input {
      width: 100%;
      padding: 15px 20px;
      font-size: 1rem;
      border: 2px solid #333;
      border-radius: 10px;
      background: #0f0f23;
      color: white;
      outline: none;
      transition: border-color 0.3s;
    }
    .input-group input:focus {
      border-color: #667eea;
    }
    .btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 15px 40px;
      font-size: 1.1rem;
      border-radius: 50px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      width: 100%;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .main-content {
      display: none;
      grid-template-columns: 1fr 350px;
      gap: 20px;
      padding: 20px;
      max-width: 1800px;
      margin: 0 auto;
      height: calc(100vh - 70px);
    }
    .main-content.active { display: grid; }
    .video-section {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    .video-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 15px;
      flex: 1;
    }
    .video-container {
      position: relative;
      background: #16213e;
      border-radius: 12px;
      overflow: hidden;
      aspect-ratio: 16/10;
    }
    .video-container video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .video-container.local { border: 2px solid #667eea; }
    .video-label {
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: rgba(0,0,0,0.7);
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 15px;
      height: 100%;
    }
    .transcript-panel {
      background: #16213e;
      border-radius: 12px;
      padding: 15px;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .transcript-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #333;
    }
    .transcript-header h3 { font-size: 1rem; }
    .transcript-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .transcript-entry {
      background: #0f0f23;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .transcript-entry .speaker {
      color: #667eea;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .transcript-entry .time {
      color: #666;
      font-size: 0.75rem;
      margin-left: 10px;
    }
    .transcript-entry .content {
      color: #ddd;
      line-height: 1.4;
    }
    .lenso-panel {
      background: #16213e;
      border-radius: 12px;
      padding: 15px;
    }
    .lenso-panel h3 {
      font-size: 1rem;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .lenso-panel h3 .bot-icon {
      font-size: 1.2rem;
    }
    .lenso-input-group {
      display: flex;
      gap: 10px;
    }
    .lenso-input {
      flex: 1;
      padding: 12px 15px;
      border: 2px solid #333;
      border-radius: 10px;
      background: #0f0f23;
      color: white;
      font-size: 0.9rem;
      outline: none;
    }
    .lenso-input:focus { border-color: #667eea; }
    .lenso-input:disabled { opacity: 0.5; }
    .lenso-btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: opacity 0.2s;
    }
    .lenso-btn:hover { opacity: 0.9; }
    .lenso-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .lenso-response {
      margin-top: 15px;
      padding: 12px;
      background: #0f0f23;
      border-radius: 8px;
      font-size: 0.9rem;
      line-height: 1.5;
      max-height: 200px;
      overflow-y: auto;
      display: none;
    }
    .lenso-response.visible { display: block; }
    .lenso-response .response-label {
      color: #4CAF50;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .lenso-inactive-msg {
      color: #888;
      font-size: 0.85rem;
      text-align: center;
      padding: 20px;
    }
    .controls {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%);
      display: none;
      gap: 15px;
      background: #16213e;
      padding: 15px 25px;
      border-radius: 50px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .controls.active { display: flex; }
    .control-btn {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .control-btn svg { width: 24px; height: 24px; }
    .control-btn.active { background: #667eea; color: white; }
    .control-btn.inactive { background: #dc3545; color: white; }
    .control-btn.leave { background: #dc3545; color: white; }
    .status-message { color: #888; margin-top: 20px; font-size: 0.9rem; }
    
    @media (max-width: 900px) {
      .main-content.active {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr auto;
      }
      .sidebar {
        height: auto;
        max-height: 300px;
      }
    }
  </style>
</head>
<body>
  <header class="header">
    <h1>🎥 Lenso2</h1>
    <div class="room-info">
      <span class="peer-count" id="peerCount">0 participants</span>
      <div class="lenso-toggle" id="lensoToggle" style="display: none;">
        <div class="indicator"></div>
        <span>Lenso</span>
      </div>
    </div>
  </header>

  <section class="join-section" id="joinSection">
    <div class="join-card">
      <h2>Join Video Chat</h2>
      <p>Connect with others via Cloudflare Calls</p>
      <div class="input-group">
        <label for="nameInput">Your Name</label>
        <input type="text" id="nameInput" placeholder="Enter your name..." maxlength="30" />
      </div>
      <div class="input-group">
        <label for="roomInput">Room ID (optional)</label>
        <input type="text" id="roomInput" placeholder="Leave empty for default room" maxlength="50" />
      </div>
      <button class="btn" id="joinBtn" disabled>Join Room</button>
      <p class="status-message" id="statusMessage"></p>
    </div>
  </section>

  <div class="main-content" id="mainContent">
    <div class="video-section">
      <div class="video-grid" id="videoGrid"></div>
    </div>
    <div class="sidebar">
      <div class="transcript-panel">
        <div class="transcript-header">
          <h3>📝 Live Transcript</h3>
        </div>
        <div class="transcript-list" id="transcriptList">
          <div class="lenso-inactive-msg" id="transcriptPlaceholder">
            Enable Lenso to start transcription
          </div>
        </div>
      </div>
      <div class="lenso-panel">
        <h3><span class="bot-icon">🤖</span> Ask Lenso</h3>
        <div class="lenso-input-group">
          <input type="text" class="lenso-input" id="lensoInput" 
                 placeholder="e.g., What did John say about colors?" disabled />
          <button class="lenso-btn" id="lensoAskBtn" disabled>Ask</button>
        </div>
        <div class="lenso-response" id="lensoResponse">
          <div class="response-label">Lenso:</div>
          <div class="response-content" id="lensoResponseContent"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="controls" id="controls">
    <button class="control-btn active" id="toggleVideo" title="Toggle Video">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    </button>
    <button class="control-btn active" id="toggleAudio" title="Toggle Audio">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
      </svg>
    </button>
    <button class="control-btn leave" id="leaveBtn" title="Leave">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
      </svg>
    </button>
  </div>

  <script>
    const joinSection = document.getElementById('joinSection');
    const mainContent = document.getElementById('mainContent');
    const videoGrid = document.getElementById('videoGrid');
    const controls = document.getElementById('controls');
    const joinBtn = document.getElementById('joinBtn');
    const leaveBtn = document.getElementById('leaveBtn');
    const toggleVideo = document.getElementById('toggleVideo');
    const toggleAudio = document.getElementById('toggleAudio');
    const peerCount = document.getElementById('peerCount');
    const statusMessage = document.getElementById('statusMessage');
    const nameInput = document.getElementById('nameInput');
    const roomInput = document.getElementById('roomInput');
    const lensoToggle = document.getElementById('lensoToggle');
    const lensoInput = document.getElementById('lensoInput');
    const lensoAskBtn = document.getElementById('lensoAskBtn');
    const lensoResponse = document.getElementById('lensoResponse');
    const lensoResponseContent = document.getElementById('lensoResponseContent');
    const transcriptList = document.getElementById('transcriptList');
    const transcriptPlaceholder = document.getElementById('transcriptPlaceholder');

    let localStream = null;
    let ws = null;
    let myId = null;
    let myName = '';
    let roomId = 'default';
    let sessionId = null;
    let peerConnection = null;
    let remotePeers = new Map();
    let videoEnabled = true;
    let audioEnabled = true;
    let localTrackNames = { video: null, audio: null };
    let midToPeerId = new Map();
    let lensoActive = false;
    let mediaRecorder = null;
    let audioChunks = [];

    // Enable join button when name is entered
    nameInput.addEventListener('input', () => {
      joinBtn.disabled = nameInput.value.trim().length === 0;
    });

    // Allow Enter key to join
    nameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !joinBtn.disabled) {
        joinRoom();
      }
    });

    roomInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !joinBtn.disabled) {
        joinRoom();
      }
    });

    function updatePeerCount() {
      const count = remotePeers.size + 1;
      peerCount.textContent = count + ' participant' + (count !== 1 ? 's' : '');
    }

    function createVideoElement(id, label, isLocal = false) {
      const existing = document.getElementById('container-' + id);
      if (existing) return document.getElementById('video-' + id);

      const container = document.createElement('div');
      container.className = 'video-container' + (isLocal ? ' local' : '');
      container.id = 'container-' + id;
      
      const video = document.createElement('video');
      video.id = 'video-' + id;
      video.autoplay = true;
      video.playsInline = true;
      if (isLocal) video.muted = true;
      
      const labelEl = document.createElement('div');
      labelEl.className = 'video-label';
      labelEl.textContent = label;
      labelEl.id = 'label-' + id;
      
      container.appendChild(video);
      container.appendChild(labelEl);
      videoGrid.appendChild(container);
      
      return video;
    }

    function removeVideoElement(id) {
      const container = document.getElementById('container-' + id);
      if (container) container.remove();
    }

    function addTranscriptEntry(speakerName, content, timestamp) {
      transcriptPlaceholder.style.display = 'none';
      
      const entry = document.createElement('div');
      entry.className = 'transcript-entry';
      
      const time = new Date(timestamp).toLocaleTimeString();
      entry.innerHTML = \`
        <div class="speaker">\${speakerName}<span class="time">\${time}</span></div>
        <div class="content">\${content}</div>
      \`;
      
      transcriptList.appendChild(entry);
      transcriptList.scrollTop = transcriptList.scrollHeight;
    }

    function updateLensoUI() {
      lensoToggle.classList.toggle('active', lensoActive);
      lensoInput.disabled = !lensoActive;
      lensoAskBtn.disabled = !lensoActive;
      
      if (lensoActive) {
        transcriptPlaceholder.textContent = 'Listening for speech...';
        startAudioCapture();
      } else {
        transcriptPlaceholder.textContent = 'Enable Lenso to start transcription';
        stopAudioCapture();
      }
    }

    async function toggleLenso() {
      try {
        const res = await fetch('/api/lenso/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, active: !lensoActive }),
        });
        const data = await res.json();
        if (data.success) {
          lensoActive = data.active;
          updateLensoUI();
        }
      } catch (e) {
        console.error('Failed to toggle Lenso:', e);
      }
    }

    async function askLenso() {
      const query = lensoInput.value.trim();
      if (!query || !lensoActive) return;

      lensoAskBtn.disabled = true;
      lensoInput.disabled = true;
      lensoResponseContent.textContent = 'Thinking...';
      lensoResponse.classList.add('visible');

      try {
        const res = await fetch('/api/lenso/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId, query }),
        });
        const data = await res.json();
        
        if (data.error) {
          lensoResponseContent.textContent = 'Error: ' + data.error;
        } else {
          lensoResponseContent.textContent = data.response;
        }
      } catch (e) {
        lensoResponseContent.textContent = 'Failed to get response. Please try again.';
      } finally {
        lensoAskBtn.disabled = false;
        lensoInput.disabled = false;
        lensoInput.value = '';
      }
    }

    // Audio capture for transcription
    function startAudioCapture() {
      if (!localStream || mediaRecorder) return;

      const audioTrack = localStream.getAudioTracks()[0];
      if (!audioTrack) return;

      const audioStream = new MediaStream([audioTrack]);
      
      try {
        mediaRecorder = new MediaRecorder(audioStream, {
          mimeType: 'audio/webm;codecs=opus'
        });
      } catch (e) {
        console.warn('audio/webm not supported, trying audio/mp4');
        try {
          mediaRecorder = new MediaRecorder(audioStream, {
            mimeType: 'audio/mp4'
          });
        } catch (e2) {
          console.error('No supported audio format for MediaRecorder');
          return;
        }
      }

      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (audioChunks.length === 0 || !lensoActive) return;

        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        audioChunks = [];

        // Convert to base64
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = reader.result.split(',')[1];
          
          try {
            const res = await fetch('/api/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audioBase64: base64,
                mimeType: mediaRecorder.mimeType,
                roomId: roomId,
                speakerName: myName,
              }),
            });
            // Transcript will come via WebSocket
          } catch (e) {
            console.error('Transcription error:', e);
          }
        };
        reader.readAsDataURL(blob);

        // Start next recording if still active
        if (lensoActive && mediaRecorder) {
          mediaRecorder.start();
          setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
          }, 5000); // 5 second chunks
        }
      };

      // Start recording
      mediaRecorder.start();
      setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 5000);
    }

    function stopAudioCapture() {
      if (mediaRecorder) {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
        mediaRecorder = null;
      }
      audioChunks = [];
    }

    lensoToggle.addEventListener('click', toggleLenso);
    lensoAskBtn.addEventListener('click', askLenso);
    lensoInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') askLenso();
    });

    async function createSession() {
      const res = await fetch('/api/session/new', { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.sessionId;
    }

    async function pushLocalTracks() {
      console.log('[CLIENT] pushLocalTracks: Creating RTCPeerConnection');
      peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
      });

      peerConnection.ontrack = (event) => {
        const mid = event.transceiver.mid;
        const peerId = midToPeerId.get(mid);
        console.log('[CLIENT] ontrack fired:', {
          trackKind: event.track.kind,
          mid: mid,
          peerId: peerId,
        });
        
        if (!peerId) {
          console.warn('[CLIENT] Unknown mid:', mid);
          return;
        }

        let peerVideo = document.getElementById('video-' + peerId);
        if (!peerVideo) {
          const peerInfo = remotePeers.get(peerId);
          const peerName = peerInfo?.name || 'Peer ' + peerId.slice(0, 6);
          peerVideo = createVideoElement(peerId, peerName);
        }
        
        if (!peerVideo.srcObject) {
          peerVideo.srcObject = new MediaStream();
        }
        
        const stream = peerVideo.srcObject;
        const existingTrack = stream.getTracks().find(t => t.id === event.track.id);
        if (!existingTrack) {
          stream.addTrack(event.track);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('[CLIENT] ICE state:', peerConnection.iceConnectionState);
      };

      const videoTrack = localStream.getVideoTracks()[0];
      const audioTrack = localStream.getAudioTracks()[0];
      
      let videoTransceiver = null;
      let audioTransceiver = null;
      
      if (videoTrack) {
        videoTransceiver = peerConnection.addTransceiver(videoTrack, { direction: 'sendonly' });
        localTrackNames.video = myId + '-video';
      }
      if (audioTrack) {
        audioTransceiver = peerConnection.addTransceiver(audioTrack, { direction: 'sendonly' });
        localTrackNames.audio = myId + '-audio';
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const tracks = [];
      if (videoTransceiver && localTrackNames.video) {
        tracks.push({ location: 'local', trackName: localTrackNames.video, mid: videoTransceiver.mid });
      }
      if (audioTransceiver && localTrackNames.audio) {
        tracks.push({ location: 'local', trackName: localTrackNames.audio, mid: audioTransceiver.mid });
      }

      const res = await fetch('/api/session/' + sessionId + '/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: { sdp: offer.sdp }, tracks }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      await peerConnection.setRemoteDescription({ type: 'answer', sdp: data.sessionDescription.sdp });
    }

    async function pullRemoteTracks(peerId, trackNames) {
      const remotePeer = remotePeers.get(peerId);
      if (!remotePeer) return;

      const peerName = remotePeer.name || 'Peer ' + peerId.slice(0, 6);
      const video = createVideoElement(peerId, peerName);
      const mediaStream = new MediaStream();
      video.srcObject = mediaStream;

      for (const trackName of trackNames) {
        const res = await fetch('/api/session/' + sessionId + '/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            remoteSessionId: remotePeer.sessionId,
            trackName: trackName
          }),
        });
        const data = await res.json();
        
        if (data.error || data.errorCode) {
          console.error('[CLIENT] Pull track error:', data.error || data.errorDescription);
          continue;
        }

        if (data.requiresImmediateRenegotiation && data.sessionDescription) {
          let foundMids = [];
          data.sessionDescription.sdp.split(/\\r?\\n/).forEach(line => {
            if (line.startsWith('a=mid:')) {
              const mid = line.split(':')[1].trim();
              foundMids.push(mid);
              midToPeerId.set(mid, peerId);
            }
          });
          
          await peerConnection.setRemoteDescription({ 
            type: 'offer', 
            sdp: data.sessionDescription.sdp 
          });
          
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          
          await fetch('/api/session/' + sessionId + '/renegotiate', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: answer.sdp }),
          });
        }
      }
    }

    async function joinRoom() {
      myName = nameInput.value.trim();
      roomId = roomInput.value.trim() || 'default';
      
      if (!myName) {
        statusMessage.textContent = 'Please enter your name';
        return;
      }

      joinBtn.disabled = true;
      statusMessage.textContent = 'Requesting camera and microphone access...';

      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        statusMessage.textContent = 'Connecting...';

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + location.host + '/ws');

        ws.onopen = async () => {
          console.log('WebSocket connected');
        };

        ws.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          console.log('[CLIENT] WS message:', message.type);

          switch (message.type) {
            case 'welcome':
              myId = message.id;
              localTrackNames.video = myId + '-video';
              localTrackNames.audio = myId + '-audio';
              
              statusMessage.textContent = 'Creating session...';
              sessionId = await createSession();
              
              joinSection.style.display = 'none';
              mainContent.classList.add('active');
              controls.classList.add('active');
              lensoToggle.style.display = 'flex';

              const localVideo = createVideoElement('local', myName + ' (You)', true);
              localVideo.srcObject = localStream;

              await pushLocalTracks();

              // Check Lenso status
              try {
                const statusRes = await fetch('/api/lenso/status/' + roomId);
                const statusData = await statusRes.json();
                lensoActive = statusData.active;
                updateLensoUI();
              } catch (e) {
                console.error('Failed to get Lenso status');
              }

              // Load existing transcripts
              try {
                const transcriptsRes = await fetch('/api/transcripts/' + roomId);
                const transcriptsData = await transcriptsRes.json();
                if (transcriptsData.transcripts) {
                  transcriptsData.transcripts.reverse().forEach(t => {
                    addTranscriptEntry(t.speaker_name, t.content, t.timestamp);
                  });
                }
              } catch (e) {
                console.error('Failed to load transcripts');
              }

              const joinMsg = {
                type: 'join',
                sessionId,
                roomId,
                name: myName,
                tracks: [localTrackNames.video, localTrackNames.audio].filter(Boolean),
              };
              ws.send(JSON.stringify(joinMsg));

              updatePeerCount();
              break;

            case 'peer-joined':
              remotePeers.set(message.id, {
                sessionId: message.sessionId,
                trackNames: message.tracks,
                name: message.name,
              });
              updatePeerCount();
              if (message.tracks && message.tracks.length > 0) {
                await pullRemoteTracks(message.id, message.tracks);
              }
              break;

            case 'peer-left':
              remotePeers.delete(message.id);
              removeVideoElement(message.id);
              updatePeerCount();
              break;

            case 'existing-peers':
              for (const peer of message.peers) {
                remotePeers.set(peer.id, {
                  sessionId: peer.sessionId,
                  trackNames: peer.tracks,
                  name: peer.name,
                });
                if (peer.tracks && peer.tracks.length > 0) {
                  await pullRemoteTracks(peer.id, peer.tracks);
                }
              }
              updatePeerCount();
              break;

            case 'lenso-status':
              lensoActive = message.active;
              updateLensoUI();
              break;

            case 'transcript':
              addTranscriptEntry(message.entry.speakerName, message.entry.content, message.entry.timestamp);
              break;
          }
        };

        ws.onclose = () => {
          console.log('WebSocket disconnected');
          leaveRoom();
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          statusMessage.textContent = 'Connection error. Please try again.';
          joinBtn.disabled = false;
        };

      } catch (error) {
        console.error('Error:', error);
        statusMessage.textContent = 'Error: ' + error.message;
        joinBtn.disabled = false;
      }
    }

    function leaveRoom() {
      stopAudioCapture();
      remotePeers.clear();
      midToPeerId.clear();
      if (peerConnection) { peerConnection.close(); peerConnection = null; }
      if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
      if (ws) { ws.close(); ws = null; }
      
      videoGrid.innerHTML = '';
      transcriptList.innerHTML = '<div class="lenso-inactive-msg" id="transcriptPlaceholder">Enable Lenso to start transcription</div>';
      
      joinSection.style.display = 'flex';
      mainContent.classList.remove('active');
      controls.classList.remove('active');
      lensoToggle.style.display = 'none';
      lensoResponse.classList.remove('visible');
      
      joinBtn.disabled = nameInput.value.trim().length === 0;
      statusMessage.textContent = '';
      sessionId = null;
      myId = null;
      lensoActive = false;
      updatePeerCount();
    }

    toggleVideo.addEventListener('click', () => {
      videoEnabled = !videoEnabled;
      localStream.getVideoTracks().forEach(track => { track.enabled = videoEnabled; });
      toggleVideo.className = 'control-btn ' + (videoEnabled ? 'active' : 'inactive');
    });

    toggleAudio.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      localStream.getAudioTracks().forEach(track => { track.enabled = audioEnabled; });
      toggleAudio.className = 'control-btn ' + (audioEnabled ? 'active' : 'inactive');
    });

    joinBtn.addEventListener('click', joinRoom);
    leaveBtn.addEventListener('click', leaveRoom);
  </script>
</body>
</html>
  `);
});

// WebSocket signaling endpoint
app.get(
	"/ws",
	upgradeWebSocket((_c) => {
		const peerId = crypto.randomUUID();

		return {
			onOpen(_event, ws) {
				ws.send(JSON.stringify({ type: "welcome", id: peerId }));
				console.log(`[SERVER WS] Peer ${peerId} connected.`);
			},

			onMessage(event, ws) {
				console.log(`[SERVER WS] onMessage from peer ${peerId}`);

				const data = JSON.parse(event.data.toString());

				if (data.type === "join") {
					const peerRoomId = data.roomId || "default";

					const peer: Peer = {
						id: peerId,
						ws,
						sessionId: data.sessionId,
						trackNames: data.tracks || [],
						name: data.name || "Anonymous",
						roomId: peerRoomId,
					};

					// Create or get meeting for the room
					getOrCreateMeeting(peerRoomId);

					// Add to room
					if (!rooms.has(peerRoomId)) {
						rooms.set(peerRoomId, new Set());
					}
					rooms.get(peerRoomId)!.add(peerId);

					// Send existing peers in the same room to new peer
					const existingPeers = Array.from(peers.values())
						.filter((p) => p.roomId === peerRoomId)
						.map((p) => ({
							id: p.id,
							sessionId: p.sessionId,
							tracks: p.trackNames,
							name: p.name,
						}));

					if (existingPeers.length > 0) {
						ws.send(JSON.stringify({ type: "existing-peers", peers: existingPeers }));
					}

					// Notify existing peers in the same room about new peer
					const roomPeerIds = rooms.get(peerRoomId);
					if (roomPeerIds) {
						roomPeerIds.forEach((existingPeerId) => {
							const existingPeer = peers.get(existingPeerId);
							if (existingPeer && existingPeerId !== peerId) {
								existingPeer.ws.send(
									JSON.stringify({
										type: "peer-joined",
										id: peerId,
										sessionId: data.sessionId,
										tracks: data.tracks,
										name: data.name,
									}),
								);
							}
						});
					}

					peers.set(peerId, peer);
					console.log(
						`[SERVER WS] Peer ${peerId} (${data.name}) joined room ${peerRoomId}. Total peers: ${peers.size}`,
					);
				}
			},

			onClose(_event, _ws) {
				console.log(`[SERVER WS] Peer ${peerId} disconnected.`);
				const peer = peers.get(peerId);

				if (peer) {
					// Remove from room
					const roomPeerIds = rooms.get(peer.roomId);
					if (roomPeerIds) {
						roomPeerIds.delete(peerId);
						if (roomPeerIds.size === 0) {
							rooms.delete(peer.roomId);
						}
					}

					// Notify others in the same room
					peers.forEach((p) => {
						if (p.roomId === peer.roomId && p.id !== peerId) {
							p.ws.send(JSON.stringify({ type: "peer-left", id: peerId }));
						}
					});
				}

				peers.delete(peerId);
				console.log(`[SERVER WS] Total peers remaining: ${peers.size}`);
			},
		};
	}),
);

export default {
	fetch: app.fetch,
	websocket,
};
