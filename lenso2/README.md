# lenso2

A voice meeting assistant powered by AI. Lenso2 enables multiple participants to join a single voice call while "Lenso" - an AI bot - listens to the conversation in real-time. Lenso can answer questions, provide summaries, and assist with discussions based on the context of the meeting.

This is a reproduction of the original Lenso project built at nilenso. Read more about it in the blog post: [I built an AI prototype that can participate in our internal meetings, in a week](https://blog.nilenso.com/blog/2025/01/13/i-built-an-ai-prototype-that-can-participate-in-our-internal-meetings-in-a-week/).

## Features

- **Video Chat** - Multiple participants can join with video and audio using Cloudflare Calls
- **Real-time Note Taking** - AI-powered automatic note-taking using Google Gemini Live API
- **Audio Streaming** - Streams room audio to Gemini for live transcription and summarization
- **Meeting Notes** - Displays live meeting notes, key points, and action items
- **WebRTC** - Low-latency peer-to-peer video/audio communication
- **Persistent Storage** - Automatically saves meeting notes to SQLite database when everyone leaves
- **Meeting History** - View past meetings and their notes at `/meetings`

## Documentation

- [Gemini Live API - Mic Stream](https://ai.google.dev/gemini-api/docs/live?example=mic-stream)

## Setup

Get a shell with `bun` and `cloudflared` using Nix:

```bash
nix develop
```

Then install dependencies:

```bash
bun install
```

### Environment Variables

Create a `.env` file with your credentials:

```bash
# Cloudflare Calls (for video chat)
CF_APP_ID=your_app_id
CF_APP_TOKEN=your_app_token

# Google Gemini API (for note-taking)
GOOGLE_API_KEY=your_google_api_key
```

**Getting your credentials:**
- **Cloudflare Calls**: [Cloudflare Dashboard](https://dash.cloudflare.com/) → Calls → Your App → Settings
- **Google Gemini API**: 
  - **Option 1 (nilenso/infra)**: Run `tofu output lenso2_gemini_api_key` in the nilenso/infra repository
  - **Option 2 (Google AI Studio)**: [Google AI Studio](https://aistudio.google.com/) → Get API Key

## Scripts

| Command | Description |
|---------|-------------|
| `bun run start` | Start the production server |
| `bun run dev` | Start development server with watch mode |
| `bun run tunnel` | Expose local server via Cloudflare Tunnel (HTTPS) |
| `bun run lint` | Run Biome CI checks (formatting + linting) |

> **Note**: `cloudflared` (for tunnel) is included in the Nix shell. Alternatively, install it via `brew install cloudflared` (macOS) or see [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Usage

1. Start the server:
   ```bash
   bun run dev
   ```

2. Open http://localhost:3000 in your browser

3. Click "Join Room" to enter the video chat

4. **Any participant** can click the notes icon (📄) to start AI note-taking
   - Note-taking is **automatically enabled for everyone** in the room
   - All participants see the "AI Note-Taking Active" banner
   - All participants can view notes in real-time

5. Notes panel opens automatically for all participants when note-taking starts

6. **Meeting notes are saved to database** in two scenarios:
   - When **anyone clicks the notes button again** to stop note-taking
   - When **all participants leave** the room
   - You'll see a green notification: "Meeting notes saved!"

7. View past meetings at http://localhost:3000/meetings

## How Note-Taking Works

### Starting Note-Taking
1. **Any participant** clicks the notes button (📄)
2. **Client sends** `start-note-taking` message to server
3. **Server broadcasts** to all participants in the room
4. **All clients** automatically enable note-taking UI and show the banner
5. **All participants** start streaming audio to Gemini

### Audio Processing
1. **Each client captures audio** from their microphone using Web Audio API
2. **Audio is converted** to 16kHz PCM format (required by Gemini)
3. **Audio chunks are sent** via WebSocket to server at `/gemini`
4. **Server forwards audio** to Google Gemini Live API WebSocket
5. **Gemini processes audio** and returns transcriptions/notes

### Note Distribution
1. **Gemini generates notes** from the conversation
2. **Notes are saved** to database in real-time
3. **Notes are broadcast** to all participants via WebSocket
4. **All participants see** the same notes simultaneously
5. **Visual indicator** shows note-taking is active for everyone

### Saving Meeting Notes
Meeting notes are automatically saved to the SQLite database when:
- **Anyone stops note-taking** by clicking the notes button (📄) again
- **Last participant leaves** the room
- A green notification appears confirming the save
- Duplicate saves are prevented automatically

## API Endpoints

### Pages
- `GET /` - Main application (HTML + embedded JS)
- `GET /meetings` - View past meetings and their notes

### WebSocket
- `GET /ws` - WebSocket for video chat signaling
- `GET /gemini` - WebSocket for audio streaming to Gemini

### Cloudflare Calls
- `POST /api/session/new` - Create new Cloudflare Calls session
- `POST /api/session/:id/push` - Push local tracks to session
- `POST /api/session/:id/pull` - Pull remote tracks from session
- `PUT /api/session/:id/renegotiate` - Renegotiate WebRTC connection

### Meeting History
- `GET /api/meetings` - Get list of all past meetings
- `GET /api/meetings/:id/notes` - Get notes for a specific meeting

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Language**: TypeScript
- **Web Framework**: [Hono](https://hono.dev/)
- **Database**: SQLite (via `bun:sqlite`)
- **Video/Audio**: [Cloudflare Calls](https://developers.cloudflare.com/calls/)
- **AI**: [Google Gemini Live API](https://ai.google.dev/gemini-api/docs/live)
- **WebRTC**: Native browser APIs
- **Audio Processing**: Web Audio API (AudioContext, ScriptProcessor)

## Database Schema

### meetings table
- `id` - Auto-incrementing primary key
- `room_id` - Room identifier
- `started_at` - Meeting start timestamp
- `ended_at` - Meeting end timestamp
- `participant_count` - Maximum number of participants
- `duration_seconds` - Meeting duration

### meeting_notes table
- `id` - Auto-incrementing primary key
- `meeting_id` - Foreign key to meetings table
- `note_text` - The note content from Gemini
- `created_at` - When the note was created

Notes are saved to the database in real-time as Gemini generates them, and the meeting is marked as ended when the last participant leaves the room.
