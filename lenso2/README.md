# lenso2

A voice meeting assistant powered by AI. Lenso2 enables multiple participants to join a single voice call while "Lenso" - an AI bot - listens to the conversation in real-time. Lenso can answer questions, provide summaries, and assist with discussions based on the context of the meeting.

This is a reproduction of the original Lenso project built at nilenso. Read more about it in the blog post: [I built an AI prototype that can participate in our internal meetings, in a week](https://blog.nilenso.com/blog/2025/01/13/i-built-an-ai-prototype-that-can-participate-in-our-internal-meetings-in-a-week/).

## Features

- **Group Voice Calls** - Multiple participants can join a single voice session
- **AI-Powered Assistant** - Lenso listens to the conversation and maintains context
- **Real-time Interaction** - Ask Lenso questions and get responses based on the discussion
- **Meeting Awareness** - Lenso remembers what's been said and can reference earlier parts of the conversation

## Documentation

- [Gemini Live API - Mic Stream](https://ai.google.dev/gemini-api/docs/live?example=mic-stream)

## Setup

```bash
bun install
```

### Environment Variables

Create a `.env` file with your Cloudflare Calls credentials:

```bash
CF_APP_ID=your_app_id
CF_APP_TOKEN=your_app_token
```

Get these from your [Cloudflare Dashboard](https://dash.cloudflare.com/) → Calls → Your App → Settings.

## Run

```bash
bun run start
```

## Development

```bash
bun run dev
```

## Cloudflare Tunnel

To expose your local server publicly (useful for testing on other devices or sharing):

```bash
bun run tunnel
```

This requires `cloudflared` to be installed. Install it via:
- **macOS**: `brew install cloudflared`
- **Linux**: See [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

## Tech Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Language**: TypeScript
- **AI**: Gemini Live API
