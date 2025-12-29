import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'

const { upgradeWebSocket, websocket } = createBunWebSocket()

// Cloudflare Calls credentials from environment
const CF_APP_ID = process.env.CF_APP_ID || ''
const CF_APP_TOKEN = process.env.CF_APP_TOKEN || ''
const CF_API_BASE = `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`

if (!CF_APP_ID || !CF_APP_TOKEN) {
  console.warn('Warning: CF_APP_ID and CF_APP_TOKEN not set. Cloudflare Calls will not work.')
}

const app = new Hono()

// Store connected peers - keyed by peerId, not ws internals
interface Peer {
  id: string
  ws: WSContext
  sessionId?: string
  trackNames: string[]
}

const peers = new Map<string, Peer>()
const wsToId = new WeakMap<WSContext, string>() // Map WSContext to peerId

// Cloudflare Calls API helpers
async function cfFetch(endpoint: string, method: string, body?: unknown) {
  const res = await fetch(`${CF_API_BASE}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${CF_APP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) {
    console.error('Cloudflare API error:', data)
    throw new Error(`CF API error: ${res.status}`)
  }
  return data
}

async function createSession(): Promise<string> {
  const data = await cfFetch('/sessions/new', 'POST')
  return data.sessionId
}

async function pushTracks(sessionId: string, offer: RTCSessionDescriptionInit, tracks: { location: string, trackName: string }[]) {
  const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, 'POST', {
    sessionDescription: { type: 'offer', sdp: offer.sdp },
    tracks,
  })
  return data
}

async function pullTracks(sessionId: string, tracks: { location: string, trackName: string, sessionId: string }[]) {
  const data = await cfFetch(`/sessions/${sessionId}/tracks/new`, 'POST', {
    tracks,
  })
  return data
}

async function renegotiate(sessionId: string, sdp: string) {
  const data = await cfFetch(`/sessions/${sessionId}/renegotiate`, 'PUT', {
    sessionDescription: { type: 'answer', sdp },
  })
  return data
}

// API endpoints for Cloudflare Calls
app.post('/api/session/new', async (c) => {
  try {
    const sessionId = await createSession()
    return c.json({ sessionId })
  } catch (e) {
    return c.json({ error: 'Failed to create session' }, 500)
  }
})

app.post('/api/session/:sessionId/push', async (c) => {
  try {
    const { sessionId } = c.req.param()
    const { offer, tracks } = await c.req.json()
    const result = await pushTracks(sessionId, offer, tracks)
    return c.json(result)
  } catch (e) {
    console.error('Push tracks error:', e)
    return c.json({ error: 'Failed to push tracks' }, 500)
  }
})

app.post('/api/session/:sessionId/pull', async (c) => {
  try {
    const { sessionId } = c.req.param()
    const { tracks } = await c.req.json()
    const result = await pullTracks(sessionId, tracks)
    return c.json(result)
  } catch (e) {
    console.error('Pull tracks error:', e)
    return c.json({ error: 'Failed to pull tracks' }, 500)
  }
})

app.put('/api/session/:sessionId/renegotiate', async (c) => {
  try {
    const { sessionId } = c.req.param()
    const { sdp } = await c.req.json()
    const result = await renegotiate(sessionId, sdp)
    return c.json(result)
  } catch (e) {
    console.error('Renegotiate error:', e)
    return c.json({ error: 'Failed to renegotiate' }, 500)
  }
})

app.get('/', (c) => {
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
      peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
      });

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

      // Build tracks array with mid from transceivers (available after setLocalDescription)
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
      console.log('Pushed local tracks:', data.tracks);
      
      peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE state:', peerConnection.iceConnectionState);
      };
    }

    async function pullRemoteTracks(peerId, trackNames) {
      console.log('Pulling tracks for peer', peerId, ':', trackNames);
      
      // Add transceivers and track them
      const transceivers = [];
      for (const trackName of trackNames) {
        const kind = trackName.endsWith('-video') ? 'video' : 'audio';
        const transceiver = peerConnection.addTransceiver(kind, { direction: 'recvonly' });
        transceivers.push({ trackName, transceiver });
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const remotePeer = remotePeers.get(peerId);
      if (!remotePeer) return;

      // Build tracks with mid from transceivers
      const tracks = transceivers.map(({ trackName, transceiver }) => ({
        location: 'remote',
        trackName,
        sessionId: remotePeer.sessionId,
        mid: transceiver.mid,
      }));

      const res = await fetch('/api/session/' + sessionId + '/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      await peerConnection.setRemoteDescription({ type: 'answer', sdp: data.sessionDescription.sdp });

      peerConnection.ontrack = (event) => {
        console.log('Received track:', event.track.kind);
        
        for (const [pid, peer] of remotePeers) {
          if (peer.trackNames.some(t => t.includes(pid))) {
            let video = document.getElementById('video-' + pid);
            if (!video) {
              video = createVideoElement(pid);
            }
            
            if (!video.srcObject) {
              video.srcObject = new MediaStream();
            }
            video.srcObject.addTrack(event.track);
            break;
          }
        }
      };
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
          console.log('Received message:', message.type, message);

          switch (message.type) {
            case 'welcome':
              myId = message.id;
              localTrackNames.video = myId + '-video';
              localTrackNames.audio = myId + '-audio';
              
              // Now create session and push tracks
              statusMessage.textContent = 'Creating session...';
              sessionId = await createSession();
              console.log('Created session:', sessionId);
              
              joinSection.style.display = 'none';
              videoGrid.classList.add('active');
              controls.classList.add('active');

              const localVideo = createVideoElement('local', true);
              localVideo.srcObject = localStream;

              await pushLocalTracks();

              ws.send(JSON.stringify({
                type: 'join',
                sessionId,
                tracks: [localTrackNames.video, localTrackNames.audio].filter(Boolean),
              }));

              updatePeerCount();
              break;

            case 'peer-joined':
              remotePeers.set(message.id, {
                sessionId: message.sessionId,
                trackNames: message.tracks,
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
                });
                if (peer.tracks && peer.tracks.length > 0) {
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
  `)
})

// WebSocket signaling endpoint  
app.get('/ws', upgradeWebSocket((c) => {
  const id = crypto.randomUUID()
  
  return {
    onOpen(event, ws) {
      // Store mapping from ws to id using WeakMap (no mutation of ws.raw.data)
      wsToId.set(ws, id)
      
      ws.send(JSON.stringify({ type: 'welcome', id }))
      console.log(`Peer ${id} connected.`)
    },
    
    onMessage(event, ws) {
      const peerId = wsToId.get(ws)
      if (!peerId) return
      
      const data = JSON.parse(event.data.toString())
      
      if (data.type === 'join') {
        const peer: Peer = {
          id: peerId,
          ws,
          sessionId: data.sessionId,
          trackNames: data.tracks || [],
        }
        
        // Send existing peers to new peer
        const existingPeers = Array.from(peers.values()).map(p => ({
          id: p.id,
          sessionId: p.sessionId,
          tracks: p.trackNames,
        }))
        
        if (existingPeers.length > 0) {
          ws.send(JSON.stringify({ type: 'existing-peers', peers: existingPeers }))
        }
        
        // Notify existing peers about new peer
        peers.forEach((p) => {
          p.ws.send(JSON.stringify({
            type: 'peer-joined',
            id: peerId,
            sessionId: data.sessionId,
            tracks: data.tracks,
          }))
        })
        
        peers.set(peerId, peer)
        console.log(`Peer ${peerId} joined with session ${data.sessionId}. Total peers: ${peers.size}`)
      }
    },
    
    onClose(event, ws) {
      const peerId = wsToId.get(ws)
      if (peerId) {
        peers.delete(peerId)
        
        peers.forEach((p) => {
          p.ws.send(JSON.stringify({ type: 'peer-left', id: peerId }))
        })
        
        console.log(`Peer ${peerId} disconnected. Total peers: ${peers.size}`)
      }
    }
  }
}))

export default {
  fetch: app.fetch,
  websocket
}
