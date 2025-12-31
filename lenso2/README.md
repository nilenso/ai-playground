# lenso2

A voice/video meeting assistant powered by AI. Lenso2 enables multiple participants to join video calls while "Lenso" - an AI bot - listens to the conversation in real-time. Lenso can answer questions, provide summaries, and assist with discussions based on the context of the meeting.

This is a reproduction of the original Lenso project built at nilenso. Read more about it in the blog post: [I built an AI prototype that can participate in our internal meetings, in a week](https://blog.nilenso.com/blog/2025/01/13/i-built-an-ai-prototype-that-can-participate-in-our-internal-meetings-in-a-week/).

## Features

- **Group Video Calls** - Multiple participants can join a single voice/video session
- **AI-Powered Assistant** - Lenso listens to the conversation and maintains context
- **Real-time Transcription** - When Lenso is active, it transcribes the meeting in real-time
- **Live Transcript Display** - See who said what with timestamps
- **Natural Language Queries** - Ask Lenso questions like:
  - "What did [Name] say about [topic]?"
  - "What happened in the last 15 minutes?"
  - "Can you summarize the whole meeting?"
  - "What are our action items?"
- **Named Participants** - Enter your name before joining so Lenso knows who's speaking
- **Toggle On/Off** - Lenso can be activated/deactivated during the meeting
- **Persistent Transcripts** - Meeting transcripts are stored in SQLite for later reference

## Documentation

- [Gemini Live API - Mic Stream](https://ai.google.dev/gemini-api/docs/live?example=mic-stream)

## Setup

Get a shell with `bun`, `cloudflared`, and `litem8` using Nix:

```bash
nix develop
```

Then install dependencies:

```bash
bun install
```

### Run Database Migrations

```bash
litem8 up --db ./lenso.db --migrations ./migrations
```

### Environment Variables

Create a `.env` file with your credentials:

```bash
CF_APP_ID=your_cloudflare_app_id
CF_APP_TOKEN=your_cloudflare_app_token
GEMINI_KEY=your_gemini_api_key
```

Get Cloudflare credentials from your [Cloudflare Dashboard](https://dash.cloudflare.com/) → Calls → Your App → Settings.

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

## Scripts

| Command | Description |
|---------|-------------|
| `bun run start` | Start the production server |
| `bun run dev` | Start development server with watch mode |
| `bun run tunnel` | Expose local server via Cloudflare Tunnel (HTTPS) |
| `bun run lint` | Run Biome CI checks (formatting + linting) |

> **Note**: `cloudflared` (for tunnel) and `litem8` (for migrations) are included in the Nix shell.

## Usage

1. Start the server: `bun run start`
2. Open http://localhost:3000 in your browser
3. Enter your name and optionally a room ID
4. Click "Join Room"
5. Click the "Lenso" toggle in the header to activate the AI assistant
6. When Lenso is active:
   - Your speech is transcribed in real-time
   - You can ask questions in the "Ask Lenso" panel
   - Everyone in the room sees the live transcript

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Language**: TypeScript
- **Web Framework**: [Hono](https://hono.dev/)
- **Video/Audio**: Cloudflare Calls (WebRTC)
- **AI**: Google Gemini API
- **Database**: SQLite (via `bun:sqlite`)
- **Migrations**: [litem8](https://github.com/neenaoffline/litem8)

## Project Structure

```
lenso2/
├── index.ts          # Main server with API endpoints and HTML
├── db.ts             # Database operations (transcripts, meetings)
├── gemini.ts         # Gemini API integration for queries and transcription
├── migrations/       # SQLite migrations
│   └── 001_create_transcripts.sql
├── lenso.db          # SQLite database (created after first migration)
├── flake.nix         # Nix development environment
└── package.json
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/new` | POST | Create a new Cloudflare Calls session |
| `/api/session/:id/push` | POST | Push local tracks to session |
| `/api/session/:id/pull` | POST | Pull remote tracks from session |
| `/api/session/:id/renegotiate` | PUT | Renegotiate WebRTC connection |
| `/api/lenso/toggle` | POST | Toggle Lenso on/off for a room |
| `/api/lenso/status/:roomId` | GET | Get Lenso status for a room |
| `/api/lenso/query` | POST | Ask Lenso a question |
| `/api/transcript` | POST | Add a transcript entry |
| `/api/transcripts/:roomId` | GET | Get transcripts for a room |
| `/api/transcribe` | POST | Transcribe audio using Gemini |
| `/ws` | WebSocket | Real-time signaling and updates |
