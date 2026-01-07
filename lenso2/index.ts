import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { Database } from "bun:sqlite";
import { 
	setDatabase,
	setGeminiApiKey,
	rooms,
	startTranscription, 
	stopTranscription, 
	handleRoomEmpty,
	transcribeAudioWithGemini,
	saveTranscription
} from "./transcription";

const { upgradeWebSocket, websocket } = createBunWebSocket();

// Cloudflare Calls credentials from environment
const CF_APP_ID = process.env.CF_APP_ID || "";
const CF_APP_TOKEN = process.env.CF_APP_TOKEN || "";
const CF_API_BASE = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`;

// Google Gemini API credentials
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

if (!CF_APP_ID || !CF_APP_TOKEN) {
	console.warn("Warning: CF_APP_ID and CF_APP_TOKEN not set. Cloudflare Calls will not work.");
}

if (!GOOGLE_API_KEY) {
	console.warn("Warning: GOOGLE_API_KEY not set. AI note-taking will not work.");
}

// Initialize SQLite database
const db = new Database("lenso.db");

// Create tables
db.run(`
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    participant_count INTEGER DEFAULT 0,
    duration_seconds INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    transcription_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS meeting_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL UNIQUE,
    summary_text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  )
`);

// Drop old meeting_notes table if it exists
db.run(`DROP TABLE IF EXISTS meeting_notes`);

console.log("[DB] Database initialized");

// Set database reference in transcription module
setDatabase(db);
setGeminiApiKey(GOOGLE_API_KEY);

const app = new Hono();

// Store connected peers - keyed by peerId, not ws internals
interface Peer {
	id: string;
	ws: WSContext;
	sessionId?: string;
	trackNames: string[];
	roomId?: string;
}

const peers = new Map<string, Peer>();
const wsToId = new WeakMap<WSContext, string>(); // Map WSContext to peerId

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
			offerSdpLength: offer?.sdp?.length
		});
		
		const result = await pushTracks(sessionId, offer, tracks);
		
		console.log("[SERVER] Push response:", {
			hasSessionDescription: !!result.sessionDescription,
			tracks: result.tracks,
			errorCode: result.errorCode
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
			trackName
		});
		
		// Build the tracks array for Cloudflare API
		const tracks = [{
			location: "remote",
			sessionId: remoteSessionId,
			trackName: trackName
		}];
		
		console.log("[SERVER] Sending to CF API:", JSON.stringify({ tracks }, null, 2));
		
		const result = await pullTracks(sessionId, tracks);
		
		console.log("[SERVER] CF API response:", {
			requiresImmediateRenegotiation: result.requiresImmediateRenegotiation,
			hasSessionDescription: !!result.sessionDescription,
			tracks: result.tracks,
			errorCode: result.errorCode,
			errorDescription: result.errorDescription
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
			sdpLength: sdp?.length
		});
		
		const result = await renegotiate(sessionId, sdp);
		
		console.log("[SERVER] Renegotiate response:", {
			hasSessionDescription: !!result.sessionDescription,
			errorCode: result.errorCode
		});
		
		return c.json(result);
	} catch (e) {
		console.error("[SERVER] Renegotiate error:", e);
		return c.json({ error: "Failed to renegotiate" }, 500);
	}
});

app.get("/", (c) => {
	return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lenso3 - Video Chat</title>
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
    .recording-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(102, 126, 234, 0.2);
      color: #8ab4f8;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 500;
      border: 1px solid rgba(102, 126, 234, 0.3);
    }
    .recording-dot {
      width: 8px;
      height: 8px;
      background: #8ab4f8;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
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
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .main-container {
      display: none;
      height: calc(100vh - 70px);
      position: relative;
    }
    .main-container.active { 
      display: flex; 
      flex-direction: row;
    }
    
    .video-pane {
      flex: 1;
      overflow: hidden;
      background: #1a1a2e;
    }
    
    .video-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 15px;
      padding: 20px;
      height: 100%;
      overflow-y: auto;
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
    .control-btn.inactive { background: #fff; color: #dc3545; border: 2px solid #dc3545; }
    .control-btn.leave { background: #dc3545; color: white; }

    .status-message { color: #888; margin-top: 20px; font-size: 0.9rem; }
    

    
    /* Captions Pane */
    .captions-pane {
      width: 400px;
      background: #202124;
      border-left: 1px solid #3c4043;
      display: flex;
      flex-direction: column;
    }
    .captions-pane.hidden {
      display: none;
    }
    
    .captions-header {
      padding: 20px;
      border-bottom: 1px solid #3c4043;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .captions-header h3 {
      color: #e8eaed;
      font-size: 1.1rem;
      margin: 0;
      font-weight: 400;
    }
    
    .captions-close {
      background: none;
      border: none;
      color: #9aa0a6;
      font-size: 1.5rem;
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    
    .captions-close:hover {
      background: rgba(232, 234, 237, 0.1);
    }
    
    .captions-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .caption-item {
      background: #28292c;
      padding: 12px 16px;
      border-radius: 8px;
      color: #e8eaed;
      font-size: 0.95rem;
      line-height: 1.5;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    }
    
    .caption-item:last-child {
      background: #3c4043;
    }
    
    .captions-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #9aa0a6;
      text-align: center;
      padding: 40px 20px;
    }
    
    .captions-empty-icon {
      font-size: 4rem;
      margin-bottom: 20px;
      opacity: 0.5;
    }
    
    .captions-empty-text {
      font-size: 0.95rem;
    }
    
    .captions-input-container {
      padding: 16px;
      border-top: 1px solid #3c4043;
      background: #28292c;
    }
    
    .captions-input {
      width: 100%;
      background: #3c4043;
      border: 1px solid #5f6368;
      border-radius: 24px;
      padding: 12px 20px;
      color: #e8eaed;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s, background 0.2s;
    }
    
    .captions-input::placeholder {
      color: #9aa0a6;
    }
    
    .captions-input:focus {
      background: #3c4043;
      border-color: #8ab4f8;
    }
  </style>
</head>
<body>
  <header class="header">
    <div style="display: flex; align-items: center; gap: 15px;">
      <h1>🎥 Lenso3</h1>
      <span class="recording-badge" id="recordingBadge" style="display: none;">
        <span class="recording-dot"></span>
        Transcribing
      </span>
    </div>
    <div class="room-info">
      <span class="peer-count" id="peerCount">0 participants</span>
    </div>
  </header>

  <section class="join-section" id="joinSection">
    <div class="join-card">
      <h2>Join Video Chat</h2>
      <p>Connect with others via Cloudflare Calls</p>
      <button class="btn" id="joinBtn">Join Room</button>
      <p class="status-message" id="statusMessage"></p>
    </div>
  </section>

  <div class="main-container" id="mainContainer">
    <div class="video-pane">
      <div class="video-grid" id="videoGrid"></div>
    </div>
    <div class="captions-pane" id="captionsPane">
      <div class="captions-header">
        <h3>Live Captions</h3>
        <button class="captions-close" id="captionsClose">&times;</button>
      </div>
      <div class="captions-content" id="captionsContent">
        <div class="captions-empty">
          <div class="captions-empty-icon">💬</div>
          <div class="captions-empty-text">No captions yet<br>Captions will appear here as you speak</div>
        </div>
      </div>
      <div class="captions-input-container">
        <input type="text" class="captions-input" placeholder="Ask Lenso3" id="captionsInput">
      </div>
    </div>
  </div>

  <div class="controls" id="controls">
    <button class="control-btn active" id="toggleVideo" title="Toggle Video">
      <!-- Active icon - video on -->
      <svg id="videoIconActive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
      <!-- Inactive icon - video off with slash -->
      <svg id="videoIconInactive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display: none;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>
    <button class="control-btn active" id="toggleAudio" title="Toggle Audio">
      <!-- Active icon - audio on -->
      <svg id="audioIconActive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
      </svg>
      <!-- Inactive icon - audio off with slash -->
      <svg id="audioIconInactive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display: none;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>
    <button class="control-btn active" id="toggleNotes" title="Closed Captions">
      <!-- Active icon - CC on -->
      <svg id="notesIconActive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      </svg>
      <!-- Inactive icon - CC off with slash -->
      <svg id="notesIconInactive" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="display: none;">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
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
    const mainContainer = document.getElementById('mainContainer');
    const videoGrid = document.getElementById('videoGrid');
    const controls = document.getElementById('controls');
    const joinBtn = document.getElementById('joinBtn');
    const leaveBtn = document.getElementById('leaveBtn');
    const toggleVideo = document.getElementById('toggleVideo');
    const toggleAudio = document.getElementById('toggleAudio');
    const toggleNotes = document.getElementById('toggleNotes');
    const captionsPane = document.getElementById('captionsPane');
    const captionsContent = document.getElementById('captionsContent');
    const captionsClose = document.getElementById('captionsClose');
    const recordingBadge = document.getElementById('recordingBadge');
    const peerCount = document.getElementById('peerCount');
    const statusMessage = document.getElementById('statusMessage');

    let localStream = null;
    let ws = null;
    let geminiWs = null;
    let audioContext = null;
    let audioProcessor = null;
    let myId = null;
    let sessionId = null;
    let peerConnection = null;
    let remotePeers = new Map();
    let videoEnabled = true;
    let audioEnabled = true;
    let transcriptionActive = false;
    let captionsVisible = true;
    let roomId = 'default';
    let localTrackNames = { video: null, audio: null };
    // Map transceiver mid to peerId for incoming tracks
    let midToPeerId = new Map();

    function updatePeerCount() {
      const count = remotePeers.size + 1;
      peerCount.textContent = count + ' participant' + (count !== 1 ? 's' : '');
    }

    // Removed addTranscriptionToUI - now using captions pane only

    async function startAudioCapture() {
      console.log('[CLIENT] Starting audio capture');
      
      try {
        // Connect to Gemini WebSocket
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        geminiWs = new WebSocket(protocol + '//' + location.host + '/gemini?peerId=' + myId + '&roomId=' + roomId);
        
        geminiWs.onopen = () => {
          console.log('[CLIENT] Gemini WebSocket connected');
        };
        
        geminiWs.onerror = (error) => {
          console.error('[CLIENT] Gemini WebSocket error:', error);
        };
        
        geminiWs.onclose = () => {
          console.log('[CLIENT] Gemini WebSocket closed');
        };
        
        // Set up Web Audio API for audio capture
        // Use 16kHz sample rate (required by Gemini)
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(localStream);
        
        // Use ScriptProcessorNode for audio capture (4096 buffer size, 1 input channel, 1 output channel)
        audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        
        audioProcessor.onaudioprocess = (e) => {
          if (!transcriptionActive || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
          
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Convert Float32Array to Int16Array (PCM format)
          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            // Clamp values to [-1, 1] and convert to 16-bit integer
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          // Send PCM data to server
          geminiWs.send(pcmData.buffer);
        };
        
        // Connect nodes: source -> processor -> destination
        source.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);
        
        console.log('[CLIENT] Audio capture pipeline created');
      } catch (error) {
        console.error('[CLIENT] Error setting up audio capture:', error);
      }
    }

    function stopAudioCapture() {
      console.log('[CLIENT] Stopping audio capture');
      
      // Disconnect and clean up audio nodes
      if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
      }
      
      if (audioContext) {
        audioContext.close();
        audioContext = null;
      }
      
      // Close Gemini WebSocket
      if (geminiWs) {
        geminiWs.close();
        geminiWs = null;
      }
    }

    function createVideoElement(id, isLocal = false) {
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
      
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = isLocal ? 'You' : 'Peer ' + id.slice(0, 6);
      
      container.appendChild(video);
      container.appendChild(label);
      videoGrid.appendChild(container);
      
      return video;
    }

    function removeVideoElement(id) {
      const container = document.getElementById('container-' + id);
      if (container) container.remove();
    }

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

      // Set up ontrack handler once - this will receive all incoming tracks
      peerConnection.ontrack = (event) => {
        const mid = event.transceiver.mid;
        const peerId = midToPeerId.get(mid);
        console.log('[CLIENT] ontrack fired:', {
          trackKind: event.track.kind,
          trackId: event.track.id,
          mid: mid,
          peerId: peerId,
          allMidMappings: Object.fromEntries(midToPeerId)
        });
        
        if (!peerId) {
          console.warn('[CLIENT] Unknown mid:', mid, 'known mids:', [...midToPeerId.keys()]);
          return;
        }

        let peerVideo = document.getElementById('video-' + peerId);
        if (!peerVideo) {
          console.log('[CLIENT] Creating video element for peer:', peerId);
          peerVideo = createVideoElement(peerId);
        }
        
        if (!peerVideo.srcObject) {
          peerVideo.srcObject = new MediaStream();
        }
        
        const stream = peerVideo.srcObject;
        const existingTrack = stream.getTracks().find(t => t.id === event.track.id);
        if (!existingTrack) {
          stream.addTrack(event.track);
          console.log('[CLIENT] Added track to peer', peerId, ':', event.track.kind, 'stream now has', stream.getTracks().length, 'tracks');
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log('[CLIENT] ICE state:', peerConnection.iceConnectionState);
      };
      
      peerConnection.onconnectionstatechange = () => {
        console.log('[CLIENT] Connection state:', peerConnection.connectionState);
      };
      
      peerConnection.onsignalingstatechange = () => {
        console.log('[CLIENT] Signaling state:', peerConnection.signalingState);
      };

      const videoTrack = localStream.getVideoTracks()[0];
      const audioTrack = localStream.getAudioTracks()[0];
      
      console.log('[CLIENT] Local tracks:', {
        video: videoTrack ? videoTrack.id : null,
        audio: audioTrack ? audioTrack.id : null
      });
      
      let videoTransceiver = null;
      let audioTransceiver = null;
      
      if (videoTrack) {
        videoTransceiver = peerConnection.addTransceiver(videoTrack, { direction: 'sendonly' });
        localTrackNames.video = myId + '-video';
        console.log('[CLIENT] Added video transceiver, trackName:', localTrackNames.video);
      }
      if (audioTrack) {
        audioTransceiver = peerConnection.addTransceiver(audioTrack, { direction: 'sendonly' });
        localTrackNames.audio = myId + '-audio';
        console.log('[CLIENT] Added audio transceiver, trackName:', localTrackNames.audio);
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      console.log('[CLIENT] Created and set local offer, SDP length:', offer.sdp.length);

      // Build tracks array with mid from transceivers (available after setLocalDescription)
      const tracks = [];
      if (videoTransceiver && localTrackNames.video) {
        tracks.push({ location: 'local', trackName: localTrackNames.video, mid: videoTransceiver.mid });
      }
      if (audioTransceiver && localTrackNames.audio) {
        tracks.push({ location: 'local', trackName: localTrackNames.audio, mid: audioTransceiver.mid });
      }

      console.log('[CLIENT] Pushing tracks to CF:', tracks);
      
      const res = await fetch('/api/session/' + sessionId + '/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: { sdp: offer.sdp }, tracks }),
      });
      const data = await res.json();
      console.log('[CLIENT] Push response:', {
        error: data.error,
        hasSessionDescription: !!data.sessionDescription,
        tracks: data.tracks
      });
      if (data.error) throw new Error(data.error);

      await peerConnection.setRemoteDescription({ type: 'answer', sdp: data.sessionDescription.sdp });
      console.log('[CLIENT] Set remote description (answer), push complete');
    }

    async function pullRemoteTracks(peerId, trackNames) {
      console.log('[CLIENT] pullRemoteTracks called:', { peerId, trackNames });
      
      const remotePeer = remotePeers.get(peerId);
      if (!remotePeer) {
        console.log('[CLIENT] Remote peer not found:', peerId);
        return;
      }
      
      console.log('[CLIENT] Remote peer info:', {
        peerId,
        remoteSessionId: remotePeer.sessionId,
        trackNames: remotePeer.trackNames
      });

      // Create video element for this peer ahead of time
      const video = createVideoElement(peerId);
      const mediaStream = new MediaStream();
      video.srcObject = mediaStream;

      // Pull each track one at a time (the CF API + renegotiation flow works per-track)
      for (const trackName of trackNames) {
        console.log('[CLIENT] Pulling track:', trackName, 'from session:', remotePeer.sessionId);
        console.log('[CLIENT] Current signaling state before pull:', peerConnection.signalingState);
        
        // Just request to pull the track - no local offer needed
        // Cloudflare will return an offer that we need to answer
        const res = await fetch('/api/session/' + sessionId + '/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            remoteSessionId: remotePeer.sessionId,
            trackName: trackName
          }),
        });
        const data = await res.json();
        
        console.log('[CLIENT] Pull response:', {
          error: data.error,
          errorCode: data.errorCode,
          errorDescription: data.errorDescription,
          requiresImmediateRenegotiation: data.requiresImmediateRenegotiation,
          hasSessionDescription: !!data.sessionDescription,
          tracks: data.tracks
        });
        
        if (data.error || data.errorCode) {
          console.error('[CLIENT] Pull track error:', data.error || data.errorDescription);
          continue;
        }

        if (data.requiresImmediateRenegotiation && data.sessionDescription) {
          console.log('[CLIENT] Renegotiation required, parsing SDP for mids...');
          
          // Parse the SDP to find the new mid(s) for this track
          // SDP uses CRLF line endings
          let foundMids = [];
          data.sessionDescription.sdp.split(/\\r?\\n/).forEach(line => {
            if (line.startsWith('a=mid:')) {
              const mid = line.split(':')[1].trim();
              foundMids.push(mid);
              // Map this mid to the peer so ontrack can route it correctly
              midToPeerId.set(mid, peerId);
            }
          });
          console.log('[CLIENT] Found mids in SDP:', foundMids, 'mapped to peer:', peerId);
          console.log('[CLIENT] All mid mappings now:', Object.fromEntries(midToPeerId));
          
          // Cloudflare sends us an OFFER - we need to set it and create an answer
          console.log('[CLIENT] Setting remote description (offer)...');
          await peerConnection.setRemoteDescription({ 
            type: 'offer', 
            sdp: data.sessionDescription.sdp 
          });
          console.log('[CLIENT] Remote description set, signaling state:', peerConnection.signalingState);
          
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          console.log('[CLIENT] Created and set local answer, signaling state:', peerConnection.signalingState);
          
          // Send our answer back via renegotiate endpoint
          console.log('[CLIENT] Sending renegotiate with answer...');
          const renego = await fetch('/api/session/' + sessionId + '/renegotiate', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: answer.sdp }),
          });
          const renegoData = await renego.json();
          console.log('[CLIENT] Renegotiate response:', renegoData);
        } else {
          console.log('[CLIENT] No renegotiation required for this track');
        }
      }
      
      console.log('[CLIENT] Finished pulling all tracks for peer:', peerId);
      console.log('[CLIENT] Final mid mappings:', Object.fromEntries(midToPeerId));
    }

    async function joinRoom() {
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
          console.log('[CLIENT] WS message received:', message.type, message);

          switch (message.type) {
            case 'welcome':
              myId = message.id;
              localTrackNames.video = myId + '-video';
              localTrackNames.audio = myId + '-audio';
              console.log('[CLIENT] Got welcome, myId:', myId);
              
              // Now create session and push tracks
              statusMessage.textContent = 'Creating session...';
              sessionId = await createSession();
              console.log('[CLIENT] Created CF session:', sessionId);
              
              joinSection.style.display = 'none';
              mainContainer.classList.add('active');
              controls.classList.add('active');

              const localVideo = createVideoElement('local', true);
              localVideo.srcObject = localStream;

              await pushLocalTracks();

              const joinMsg = {
                type: 'join',
                sessionId,
                tracks: [localTrackNames.video, localTrackNames.audio].filter(Boolean),
                roomId: roomId,
              };
              console.log('[CLIENT] Sending join message:', joinMsg);
              ws.send(JSON.stringify(joinMsg));

              updatePeerCount();
              
              // Auto-start transcription when joining room
              console.log('[CLIENT] Auto-starting transcription');
              ws.send(JSON.stringify({ type: 'start-transcription', roomId }));
              break;

            case 'peer-joined':
              console.log('[CLIENT] Peer joined:', message.id, 'sessionId:', message.sessionId, 'tracks:', message.tracks);
              remotePeers.set(message.id, {
                sessionId: message.sessionId,
                trackNames: message.tracks,
              });
              console.log('[CLIENT] remotePeers now:', Object.fromEntries(remotePeers));
              updatePeerCount();
              if (message.tracks && message.tracks.length > 0) {
                console.log('[CLIENT] Will pull tracks for new peer:', message.id);
                await pullRemoteTracks(message.id, message.tracks);
              }
              break;

            case 'peer-left':
              console.log('[CLIENT] Peer left:', message.id);
              remotePeers.delete(message.id);
              removeVideoElement(message.id);
              updatePeerCount();
              break;

            case 'existing-peers':
              console.log('[CLIENT] Existing peers:', message.peers);
              for (const peer of message.peers) {
                console.log('[CLIENT] Processing existing peer:', peer.id, 'sessionId:', peer.sessionId);
                remotePeers.set(peer.id, {
                  sessionId: peer.sessionId,
                  trackNames: peer.tracks,
                });
                if (peer.tracks && peer.tracks.length > 0) {
                  console.log('[CLIENT] Will pull tracks for existing peer:', peer.id);
                  await pullRemoteTracks(peer.id, peer.tracks);
                }
              }
              updatePeerCount();
              break;

            case 'transcription-started':
              console.log('[CLIENT] Transcription started');
              transcriptionActive = true;
              
              // Show recording badge
              recordingBadge.style.display = 'flex';
              
              // Start audio capture
              await startAudioCapture();
              break;

            case 'transcription-stopped':
              console.log('[CLIENT] Transcription stopped');
              transcriptionActive = false;
              
              // Hide recording badge
              recordingBadge.style.display = 'none';
              
              // Stop audio capture
              stopAudioCapture();
              break;

            case 'transcription':
              console.log('[CLIENT] Received transcription:', message.text);
              
              // Remove empty state if exists
              const emptyState = captionsContent.querySelector('.captions-empty');
              if (emptyState) emptyState.remove();
              
              // Add caption to captions pane
              const captionItem = document.createElement('div');
              captionItem.className = 'caption-item';
              captionItem.textContent = message.text;
              captionsContent.appendChild(captionItem);
              
              // Auto-scroll to latest caption
              captionsContent.scrollTop = captionsContent.scrollHeight;
              
              // Keep only last 20 captions
              while (captionsContent.children.length > 20) {
                captionsContent.removeChild(captionsContent.firstChild);
              }
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
      // Stop audio capture if active
      if (transcriptionActive) {
        stopAudioCapture();
      }
      
      remotePeers.clear();
      midToPeerId.clear();
      if (peerConnection) { peerConnection.close(); peerConnection = null; }
      if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
      if (ws) { ws.close(); ws = null; }
      removeVideoElement('local');
      remotePeers.forEach((_, id) => removeVideoElement(id));
      joinSection.style.display = 'flex';
      mainContainer.classList.remove('active');
      controls.classList.remove('active');
      joinBtn.disabled = false;
      statusMessage.textContent = '';
      sessionId = null;
      myId = null;
      transcriptionActive = false;
      
      // Clear captions and hide recording badge
      captionsContent.innerHTML = '<div class="captions-empty"><div class="captions-empty-icon">💬</div><div class="captions-empty-text">No captions yet<br>Captions will appear here as you speak</div></div>';
      captionsPane.classList.add('hidden');
      captionsVisible = false;
      toggleNotes.className = 'control-btn inactive';
      document.getElementById('notesIconActive').style.display = 'none';
      document.getElementById('notesIconInactive').style.display = 'block';
      recordingBadge.style.display = 'none';
      
      updatePeerCount();
    }

    toggleVideo.addEventListener('click', () => {
      videoEnabled = !videoEnabled;
      localStream.getVideoTracks().forEach(track => { track.enabled = videoEnabled; });
      toggleVideo.className = 'control-btn ' + (videoEnabled ? 'active' : 'inactive');
      
      // Toggle video icon
      if (videoEnabled) {
        document.getElementById('videoIconActive').style.display = 'block';
        document.getElementById('videoIconInactive').style.display = 'none';
      } else {
        document.getElementById('videoIconActive').style.display = 'none';
        document.getElementById('videoIconInactive').style.display = 'block';
      }
    });

    toggleAudio.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      localStream.getAudioTracks().forEach(track => { track.enabled = audioEnabled; });
      toggleAudio.className = 'control-btn ' + (audioEnabled ? 'active' : 'inactive');
      
      // Toggle audio icon
      if (audioEnabled) {
        document.getElementById('audioIconActive').style.display = 'block';
        document.getElementById('audioIconInactive').style.display = 'none';
      } else {
        document.getElementById('audioIconActive').style.display = 'none';
        document.getElementById('audioIconInactive').style.display = 'block';
      }
    });

    toggleNotes.addEventListener('click', () => {
      // Toggle captions pane visibility (transcription stays on)
      captionsVisible = !captionsVisible;
      
      if (captionsVisible) {
        captionsPane.classList.remove('hidden');
        toggleNotes.className = 'control-btn active';
        document.getElementById('notesIconActive').style.display = 'block';
        document.getElementById('notesIconInactive').style.display = 'none';
      } else {
        captionsPane.classList.add('hidden');
        toggleNotes.className = 'control-btn inactive';
        document.getElementById('notesIconActive').style.display = 'none';
        document.getElementById('notesIconInactive').style.display = 'block';
      }
      
      console.log('[CLIENT] Captions pane visibility:', captionsVisible);
    });
    
    captionsClose.addEventListener('click', () => {
      captionsVisible = false;
      captionsPane.classList.add('hidden');
      toggleNotes.className = 'control-btn inactive';
      document.getElementById('notesIconActive').style.display = 'none';
      document.getElementById('notesIconInactive').style.display = 'block';
    });

    joinBtn.addEventListener('click', joinRoom);
    leaveBtn.addEventListener('click', leaveRoom);
  </script>
</body>
</html>
  `);
});

// Helper function to detect if audio contains speech (based on volume)
function detectSpeech(audioData: Uint8Array): boolean {
	// Convert Uint8Array to Int16Array (PCM format)
	const samples = new Int16Array(audioData.buffer);
	
	// Calculate RMS (Root Mean Square) energy
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const normalized = samples[i] / 32768.0; // Normalize to [-1, 1]
		sum += normalized * normalized;
	}
	const rms = Math.sqrt(sum / samples.length);
	
	// Convert to dB
	const db = 20 * Math.log10(rms);
	
	// Threshold: -40 dB (adjust this value based on testing)
	// Lower values = more sensitive (picks up quieter sounds)
	// Higher values = less sensitive (only loud sounds)
	const SPEECH_THRESHOLD_DB = -40;
	
	const hasSpeech = db > SPEECH_THRESHOLD_DB;
	console.log(`[AUDIO] RMS: ${rms.toFixed(4)}, dB: ${db.toFixed(2)}, Speech detected: ${hasSpeech}`);
	
	return hasSpeech;
}

// WebSocket endpoint for Gemini audio streaming
app.get(
	"/gemini",
	upgradeWebSocket((c) => {
		const peerId = c.req.query("peerId") || crypto.randomUUID();
		const roomId = c.req.query("roomId") || "default";
		
		return {
			onOpen(_event, ws) {
				console.log(`[GEMINI WS] Peer ${peerId} connected for room ${roomId}`);
			},

			async onMessage(event, ws) {
				const room = rooms.get(roomId);
				if (!room || !room.transcriptionActive) {
					console.log(`[GEMINI WS] Room ${roomId} not active for transcription`);
					return;
				}

				try {
					// Receive audio chunk from client (binary data)
					let audioChunk: Uint8Array;
					if (event.data instanceof ArrayBuffer) {
						audioChunk = new Uint8Array(event.data);
					} else if (event.data instanceof Uint8Array) {
						audioChunk = event.data;
					} else {
						console.warn('[GEMINI WS] Unexpected data type:', typeof event.data);
						return;
					}
					
					// Check if this chunk has speech
					const chunkHasSpeech = detectSpeech(audioChunk);
					const now = Date.now();
					
					if (chunkHasSpeech) {
						// Speech detected - add to buffer and update speech time
						room.audioBuffer.push(audioChunk);
						room.lastSpeechTime = now;
						room.hasSpeech = true;
						console.log(`[GEMINI WS] Speech detected - buffer size: ${room.audioBuffer.length}`);
					} else if (room.hasSpeech && room.audioBuffer.length > 0) {
						// Silence detected after speech - check if pause is long enough
						const timeSinceLastSpeech = now - room.lastSpeechTime;
						const PAUSE_THRESHOLD_MS = 500; // 500ms of silence triggers transcription
						const MIN_BUFFER_SIZE = 3; // Minimum audio chunks to avoid sending very short clips
						
						console.log(`[GEMINI WS] Silence after speech - time since last speech: ${timeSinceLastSpeech}ms, buffer size: ${room.audioBuffer.length}`);
						
						if (timeSinceLastSpeech > PAUSE_THRESHOLD_MS && room.audioBuffer.length >= MIN_BUFFER_SIZE) {
							console.log(`[GEMINI WS] Pause detected after speech (${timeSinceLastSpeech}ms) - processing ${room.audioBuffer.length} audio chunks`);
							
							// Combine audio chunks
							const totalLength = room.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
							const combinedAudio = new Uint8Array(totalLength);
							let offset = 0;
							for (const chunk of room.audioBuffer) {
								combinedAudio.set(chunk, offset);
								offset += chunk.length;
							}
							
							// Clear buffer and reset state
							room.audioBuffer = [];
							room.hasSpeech = false;
							room.lastProcessedTime = now;
							
							// Send to Gemini for transcription
							const transcription = await transcribeAudioWithGemini(combinedAudio);
							
							if (transcription && transcription.trim().length > 0 && room.meetingId) {
								console.log(`[GEMINI WS] Transcription: ${transcription.substring(0, 100)}...`);
								
								// Save to database
								saveTranscription(room.meetingId, transcription);
								
								// Broadcast to all peers in the room via signaling WebSocket
								const transcriptionMessage = JSON.stringify({
									type: 'transcription',
									text: transcription,
									timestamp: Date.now()
								});
								
								peers.forEach((peer) => {
									if (peer.roomId === roomId) {
										peer.ws.send(transcriptionMessage);
									}
								});
							}
						}
					}
				} catch (error) {
					console.error('[GEMINI WS] Error processing audio:', error);
				}
			},

			onClose(_event, _ws) {
				console.log(`[GEMINI WS] Peer ${peerId} disconnected`);
			}
		};
	})
);

// WebSocket signaling endpoint
app.get(
	"/ws",
	upgradeWebSocket((_c) => {
		// Generate ID here - captured by closure for all handlers
		const peerId = crypto.randomUUID();

		return {
			onOpen(_event, ws) {
				// peerId is captured from closure, no need for WeakMap
				ws.send(JSON.stringify({ type: "welcome", id: peerId }));
				console.log(`[SERVER WS] Peer ${peerId} connected.`);
			},

			async onMessage(event, ws) {
				// peerId is captured from closure
				console.log(`[SERVER WS] onMessage from peer ${peerId}:`, event.data.toString().substring(0, 200));

				const data = JSON.parse(event.data.toString());
				console.log("[SERVER WS] Parsed message type:", data.type);

				if (data.type === "start-transcription") {
					const roomId = data.roomId || "default";
					console.log(`[SERVER WS] Starting transcription for room ${roomId}`);
					
					const result = startTranscription(roomId);
					console.log(`[SERVER WS] startTranscription result:`, result);
					console.log(`[SERVER WS] Total peers:`, peers.size);
					console.log(`[SERVER WS] Peers in room ${roomId}:`, Array.from(peers.values()).filter(p => p.roomId === roomId).length);
					
					if (result) {
						// Broadcast to all peers in room
						let broadcastCount = 0;
						peers.forEach((peer) => {
							console.log(`[SERVER WS] Checking peer ${peer.id}, roomId: ${peer.roomId}, matches: ${peer.roomId === roomId}`);
							if (peer.roomId === roomId) {
								broadcastCount++;
								peer.ws.send(JSON.stringify({ 
									type: "transcription-started", 
									meetingId: result.meetingId 
								}));
							}
						});
						console.log(`[SERVER WS] Broadcasted transcription-started to ${broadcastCount} peers`);
					} else {
						console.log(`[SERVER WS] startTranscription returned null - transcription already active or failed`);
					}
				} else if (data.type === "stop-transcription") {
					const roomId = data.roomId || "default";
					console.log(`[SERVER WS] Stopping transcription for room ${roomId}`);
					
					// Count participants in this room
					const participantCount = Array.from(peers.values()).filter(p => p.roomId === roomId).length;
					const result = await stopTranscription(roomId, participantCount);
					
					if (result.stopped) {
						// Broadcast to all peers in room
						peers.forEach((peer) => {
							if (peer.roomId === roomId) {
								peer.ws.send(JSON.stringify({ 
									type: "transcription-stopped",
									summary: result.summary 
								}));
							}
						});
					}
				} else if (data.type === "join") {
					const roomId = data.roomId || "default";
					console.log("[SERVER WS] Processing join:", {
						peerId,
						sessionId: data.sessionId,
						tracks: data.tracks,
						roomId
					});
					
					const peer: Peer = {
						id: peerId,
						ws,
						sessionId: data.sessionId,
						trackNames: data.tracks || [],
						roomId: roomId,
					};

					// Send existing peers to new peer
					const existingPeers = Array.from(peers.values()).map((p) => ({
						id: p.id,
						sessionId: p.sessionId,
						tracks: p.trackNames,
					}));

					console.log("[SERVER WS] Existing peers to send:", existingPeers);
					
					if (existingPeers.length > 0) {
						const msg = JSON.stringify({ type: "existing-peers", peers: existingPeers });
						console.log("[SERVER WS] Sending existing-peers to new peer:", msg.substring(0, 300));
						ws.send(msg);
					}

					// Notify existing peers about new peer
					console.log("[SERVER WS] Notifying", peers.size, "existing peers about new peer");
					peers.forEach((p) => {
						const msg = JSON.stringify({
							type: "peer-joined",
							id: peerId,
							sessionId: data.sessionId,
							tracks: data.tracks,
						});
						console.log("[SERVER WS] Sending peer-joined to", p.id, ":", msg.substring(0, 200));
						p.ws.send(msg);
					});

					peers.set(peerId, peer);
					console.log(`[SERVER WS] Peer ${peerId} joined with session ${data.sessionId}. Total peers: ${peers.size}`);
				}
			},

			async onClose(_event, _ws) {
				// peerId is captured from closure
				console.log(`[SERVER WS] Peer ${peerId} disconnected.`);
				
				const peer = peers.get(peerId);
				const roomId = peer?.roomId || "default";
				
				peers.delete(peerId);

				peers.forEach((p) => {
					p.ws.send(JSON.stringify({ type: "peer-left", id: peerId }));
				});

				console.log(`[SERVER WS] Total peers remaining: ${peers.size}`);
				
				// Check if room is now empty and end meeting if transcription was active
				const remainingInRoom = Array.from(peers.values()).filter(p => p.roomId === roomId).length;
				if (remainingInRoom === 0) {
					await handleRoomEmpty(roomId);
				}
			},
		};
	}),
);

export default {
	fetch: app.fetch,
	websocket,
};
