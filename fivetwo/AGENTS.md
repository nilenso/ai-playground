Default to using Bun instead of Node.js.

> **Note**: When changing startup behavior (CLI arguments, environment variables) or install steps, update README.md accordingly.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Web Framework

Use **Hono** as the web framework. Don't use `express` or raw `Bun.serve()`.

> **Note**: If you encounter Hono-specific issues, need details on middleware options, or the task requires more advanced Hono features not covered below, use a subagent (Task tool) to fetch and analyze the Hono documentation. Use `https://hono.dev/llms-small.txt` for quick lookups or `https://hono.dev/llms-full.txt` for comprehensive reference. This keeps the large documentation out of the main conversation context. Batch multiple questions into a single subagent call to minimize round trips.

```ts
import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.text('Hello Hono!'))
app.get('/json', (c) => c.json({ message: 'Hello!' }))
app.post('/posts', (c) => c.json({ message: 'Created!' }, 201))

export default app
```

### Routing

```ts
// Path parameters
app.get('/user/:id', (c) => {
  const id = c.req.param('id')
  return c.json({ id })
})

// Query parameters
app.get('/search', (c) => {
  const query = c.req.query('q')
  return c.json({ query })
})

// Multiple methods
app.on(['GET', 'POST'], '/api', (c) => c.text('Hello'))

// Grouping routes
const api = new Hono().basePath('/api')
api.get('/users', (c) => c.json([]))
app.route('/', api)
```

### Middleware

```ts
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { basicAuth } from 'hono/basic-auth'
import { jwt } from 'hono/jwt'
import { etag } from 'hono/etag'
import { secureHeaders } from 'hono/secure-headers'

app.use(logger())
app.use('/api/*', cors())
app.use('/admin/*', basicAuth({ username: 'admin', password: 'secret' }))
```

### Request/Response

```ts
// Get request body
app.post('/posts', async (c) => {
  const body = await c.req.json()  // JSON body
  // or: await c.req.parseBody()   // form data
  // or: await c.req.text()        // text
  return c.json(body, 201)
})

// Set headers
app.get('/', (c) => {
  c.header('X-Custom', 'value')
  c.status(200)
  return c.json({ ok: true })
})

// Redirect
app.get('/old', (c) => c.redirect('/new'))
```

### Validation with Zod

```ts
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const schema = z.object({
  title: z.string(),
  body: z.string(),
})

app.post('/posts', zValidator('json', schema), (c) => {
  const data = c.req.valid('json')
  return c.json(data, 201)
})
```

### RPC Client (Type-safe API)

```ts
// server.ts
const route = app.get('/api/user/:id', (c) => {
  return c.json({ id: c.req.param('id'), name: 'John' })
})
export type AppType = typeof route

// client.ts
import { hc } from 'hono/client'
import type { AppType } from './server'

const client = hc<AppType>('http://localhost:3000')
const res = await client.api.user[':id'].$get({ param: { id: '123' } })
const data = await res.json() // typed!
```

### JSX Support

```tsx
import { Hono } from 'hono'
import { html } from 'hono/html'

const app = new Hono()

app.get('/', (c) => {
  return c.html(
    <html>
      <body>
        <h1>Hello Hono!</h1>
      </body>
    </html>
  )
})
```

### Streaming

```ts
import { streamText, streamSSE } from 'hono/streaming'

app.get('/stream', (c) => {
  return streamText(c, async (stream) => {
    await stream.writeln('Hello')
    await stream.sleep(1000)
    await stream.writeln('World')
  })
})
```

### WebSocket (via Bun adapter)

```ts
import { upgradeWebSocket, websocket } from 'hono/bun'

app.get('/ws', upgradeWebSocket((c) => ({
  onMessage(event, ws) {
    ws.send(`Echo: ${event.data}`)
  },
})))

export default {
  fetch: app.fetch,
  websocket,
}
```

### Static Files (Bun)

```ts
import { serveStatic } from 'hono/bun'

app.use('/static/*', serveStatic({ root: './' }))
app.use('/favicon.ico', serveStatic({ path: './favicon.ico' }))
```

### Error Handling

```ts
import { HTTPException } from 'hono/http-exception'

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  return c.json({ error: 'Internal Server Error' }, 500)
})

app.notFound((c) => c.json({ error: 'Not Found' }, 404))

// Throwing errors
app.get('/error', (c) => {
  throw new HTTPException(401, { message: 'Unauthorized' })
})
```

## APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.
