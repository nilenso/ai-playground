import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";

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
    .video-grid {
      display: none;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 15px;
      padding: 20px;
      max-width: 1800px;
      margin: 0 auto;
    }
    .video-grid.active { display: grid; }
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
    .control-btn.inactive { background: #dc3545; color: white; }
    .control-btn.leave { background: #dc3545; color: white; }
    .status-message { color: #888; margin-top: 20px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header class="header">
    <h1>🎥 Lenso2</h1>
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

  <div class="video-grid" id="videoGrid"></div>

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
    const videoGrid = document.getElementById('videoGrid');
    const controls = document.getElementById('controls');
    const joinBtn = document.getElementById('joinBtn');
    const leaveBtn = document.getElementById('leaveBtn');
    const toggleVideo = document.getElementById('toggleVideo');
    const toggleAudio = document.getElementById('toggleAudio');
    const peerCount = document.getElementById('peerCount');
    const statusMessage = document.getElementById('statusMessage');

    let localStream = null;
    let ws = null;
    let myId = null;
    let sessionId = null;
    let peerConnection = null;
    let remotePeers = new Map();
    let videoEnabled = true;
    let audioEnabled = true;
    let localTrackNames = { video: null, audio: null };
    // Map transceiver mid to peerId for incoming tracks
    let midToPeerId = new Map();

    function updatePeerCount() {
      const count = remotePeers.size + 1;
      peerCount.textContent = count + ' participant' + (count !== 1 ? 's' : '');
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
              videoGrid.classList.add('active');
              controls.classList.add('active');

              const localVideo = createVideoElement('local', true);
              localVideo.srcObject = localStream;

              await pushLocalTracks();

              const joinMsg = {
                type: 'join',
                sessionId,
                tracks: [localTrackNames.video, localTrackNames.audio].filter(Boolean),
              };
              console.log('[CLIENT] Sending join message:', joinMsg);
              ws.send(JSON.stringify(joinMsg));

              updatePeerCount();
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
      remotePeers.clear();
      midToPeerId.clear();
      if (peerConnection) { peerConnection.close(); peerConnection = null; }
      if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; }
      if (ws) { ws.close(); ws = null; }
      removeVideoElement('local');
      remotePeers.forEach((_, id) => removeVideoElement(id));
      joinSection.style.display = 'flex';
      videoGrid.classList.remove('active');
      controls.classList.remove('active');
      joinBtn.disabled = false;
      statusMessage.textContent = '';
      sessionId = null;
      myId = null;
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
		// Generate ID here - captured by closure for all handlers
		const peerId = crypto.randomUUID();

		return {
			onOpen(_event, ws) {
				// peerId is captured from closure, no need for WeakMap
				ws.send(JSON.stringify({ type: "welcome", id: peerId }));
				console.log(`[SERVER WS] Peer ${peerId} connected.`);
			},

			onMessage(event, ws) {
				// peerId is captured from closure
				console.log(`[SERVER WS] onMessage from peer ${peerId}:`, event.data.toString().substring(0, 200));

				const data = JSON.parse(event.data.toString());
				console.log("[SERVER WS] Parsed message type:", data.type);

				if (data.type === "join") {
					console.log("[SERVER WS] Processing join:", {
						peerId,
						sessionId: data.sessionId,
						tracks: data.tracks
					});
					
					const peer: Peer = {
						id: peerId,
						ws,
						sessionId: data.sessionId,
						trackNames: data.tracks || [],
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

			onClose(_event, _ws) {
				// peerId is captured from closure
				console.log(`[SERVER WS] Peer ${peerId} disconnected.`);
				peers.delete(peerId);

				peers.forEach((p) => {
					p.ws.send(JSON.stringify({ type: "peer-left", id: peerId }));
				});

				console.log(`[SERVER WS] Total peers remaining: ${peers.size}`);
			},
		};
	}),
);

export default {
	fetch: app.fetch,
	websocket,
};
