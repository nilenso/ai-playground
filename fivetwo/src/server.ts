import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Database } from "bun:sqlite";
import { createJwtMiddleware, getUserIdFromContext } from "./auth";

export interface AppDependencies {
  db: Database;
  jwtSecret: string;
}

interface Card {
  id: number;
  project_id: number;
  card_number: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  type: string;
  created_by: number;
  created_at: string;
  updated_at: string;
  version: number;
}

const validCardTypes = ["story", "bug", "task", "epic", "spike", "chore"];

interface Comment {
  id: number;
  card_id: number;
  message: string;
  created_by: number;
  created_at: string;
  status: string;
}

interface Project {
  id: number;
  name: string;
  repository_url: string;
  created_at: string;
}

export function createApp({ db, jwtSecret }: AppDependencies): Hono {
  const app = new Hono();

  // Apply JWT middleware to all /api/* routes
  app.use("/api/*", createJwtMiddleware(jwtSecret));

  // API v1
  const v1 = new Hono();

  v1.get("/status", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  v1.get("/user", (c) => {
    const userId = getUserIdFromContext(c);

    const user = db
      .query<
        {
          id: number;
          username: string;
          type: string;
          email: string | null;
          created_at: string;
        },
        [number]
      >("SELECT id, username, type, email, created_at FROM users WHERE id = ?")
      .get(userId);

    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }

    return c.json(user);
  });

  // GET /projects - List projects with optional filters
  v1.get("/projects", (c) => {
    const id = c.req.query("id");
    const name = c.req.query("name");

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (id) {
      conditions.push("id = ?");
      params.push(parseInt(id, 10));
    }
    if (name) {
      conditions.push("name LIKE ?");
      params.push(`%${name}%`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const projects = db
      .query<Project, (string | number)[]>(
        `SELECT * FROM projects ${whereClause} ORDER BY created_at DESC`
      )
      .all(...params);

    return c.json(projects);
  });

  // POST /projects - Create a new project
  v1.post("/projects", async (c) => {
    const body = await c.req.json<{
      repository_url: string;
      name?: string;
    }>();

    if (!body.repository_url) {
      return c.json({ error: "repository_url is required" }, 400);
    }

    // Auto-generate name from last 2 parts of URL path
    let name = body.name;
    if (!name) {
      const parts = body.repository_url.replace(/\.git$/, "").split("/").filter(Boolean);
      if (parts.length >= 2) {
        name = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
      } else {
        name = parts[parts.length - 1] || body.repository_url;
      }
    }

    try {
      const result = db
        .query<{ id: number }, [string, string]>(
          `INSERT INTO projects (name, repository_url)
           VALUES (?, ?)
           RETURNING id`
        )
        .get(name, body.repository_url);

      const project = db
        .query<Project, [number]>("SELECT * FROM projects WHERE id = ?")
        .get(result!.id);

      return c.json(project, 201);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Project already exists" }, 400);
      }
      throw e;
    }
  });

  interface CardReference {
    id: number;
    source_card_id: number;
    target_card_id: number;
    reference_type: string;
    created_at: string;
  }

  interface CardWithRefs extends Card {
    references: {
      outgoing: (CardReference & { target_title: string })[];
      incoming: (CardReference & { source_title: string })[];
    };
  }

  // GET /cards - List cards with optional filters and FTS search
  v1.get("/cards", (c) => {
    const id = c.req.query("id");
    const status = c.req.query("status");
    const priority = c.req.query("priority");
    const search = c.req.query("search");
    const projectId = c.req.query("project_id");
    const type = c.req.query("type");

    let cards: Card[];

    if (search) {
      // FTS search - prioritize title matches over description
      cards = db
        .query<Card, [string]>(
          `SELECT c.* FROM cards c
           JOIN cards_fts fts ON c.id = fts.rowid
           WHERE cards_fts MATCH ?
           ORDER BY bm25(cards_fts, 10.0, 1.0)`
        )
        .all(search);
    } else {
      // Build dynamic query for filters
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (id) {
        conditions.push("id = ?");
        params.push(parseInt(id, 10));
      }
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      }
      if (priority) {
        conditions.push("priority = ?");
        params.push(parseInt(priority, 10));
      }
      if (projectId) {
        conditions.push("project_id = ?");
        params.push(parseInt(projectId, 10));
      }
      if (type) {
        conditions.push("type = ?");
        params.push(type);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      cards = db
        .query<Card, (string | number)[]>(
          `SELECT * FROM cards ${whereClause} ORDER BY priority DESC, created_at DESC`
        )
        .all(...params);
    }

    if (cards.length === 0) {
      return c.json([]);
    }

    // Fetch all references for these cards in two queries (no N+1)
    const cardIds = cards.map((c) => c.id);
    const placeholders = cardIds.map(() => "?").join(",");

    const outgoingRefs = db
      .query<CardReference & { target_title: string }, number[]>(
        `SELECT cr.*, c.title as target_title 
         FROM card_references cr 
         JOIN cards c ON cr.target_card_id = c.id 
         WHERE cr.source_card_id IN (${placeholders})`
      )
      .all(...cardIds);

    const incomingRefs = db
      .query<CardReference & { source_title: string }, number[]>(
        `SELECT cr.*, c.title as source_title 
         FROM card_references cr 
         JOIN cards c ON cr.source_card_id = c.id 
         WHERE cr.target_card_id IN (${placeholders})`
      )
      .all(...cardIds);

    // Group references by card ID
    const outgoingByCard = new Map<number, (CardReference & { target_title: string })[]>();
    const incomingByCard = new Map<number, (CardReference & { source_title: string })[]>();

    for (const ref of outgoingRefs) {
      const list = outgoingByCard.get(ref.source_card_id) || [];
      list.push(ref);
      outgoingByCard.set(ref.source_card_id, list);
    }

    for (const ref of incomingRefs) {
      const list = incomingByCard.get(ref.target_card_id) || [];
      list.push(ref);
      incomingByCard.set(ref.target_card_id, list);
    }

    // Attach references to cards
    const cardsWithRefs: CardWithRefs[] = cards.map((card) => ({
      ...card,
      references: {
        outgoing: outgoingByCard.get(card.id) || [],
        incoming: incomingByCard.get(card.id) || [],
      },
    }));

    return c.json(cardsWithRefs);
  });

  // POST /cards - Create a new card
  v1.post("/cards", async (c) => {
    const userId = getUserIdFromContext(c);
    const body = await c.req.json<{
      project_id: number;
      title: string;
      description?: string;
      status?: string;
      priority?: number;
      type?: string;
    }>();

    if (!body.project_id || !body.title) {
      return c.json({ error: "project_id and title are required" }, 400);
    }

    // Validate project exists
    const project = db
      .query<{ id: number }, [number]>("SELECT id FROM projects WHERE id = ?")
      .get(body.project_id);

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    // Validate status if provided
    const validStatuses = [
      "backlog",
      "in_progress",
      "review",
      "blocked",
      "done",
      "wont_do",
      "invalid",
    ];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, 400);
    }

    // Validate priority if provided
    if (body.priority !== undefined && (body.priority < 0 || body.priority > 100)) {
      return c.json({ error: "Priority must be between 0 and 100" }, 400);
    }

    // Validate type if provided
    if (body.type && !validCardTypes.includes(body.type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validCardTypes.join(", ")}` }, 400);
    }

    // Calculate next card_number for this project
    const maxCardNumber = db
      .query<{ max_num: number | null }, [number]>(
        "SELECT MAX(card_number) as max_num FROM cards WHERE project_id = ?"
      )
      .get(body.project_id);
    const nextCardNumber = (maxCardNumber?.max_num ?? 0) + 1;

    const result = db
      .query<{ id: number }, [number, number, string, string | null, string, number, string, number]>(
        `INSERT INTO cards (project_id, card_number, title, description, status, priority, type, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        body.project_id,
        nextCardNumber,
        body.title,
        body.description ?? null,
        body.status ?? "backlog",
        body.priority ?? 50,
        body.type ?? "task",
        userId
      );

    const card = db
      .query<Card, [number]>("SELECT * FROM cards WHERE id = ?")
      .get(result!.id);

    return c.json(card, 201);
  });

  // PATCH /cards/:id - Update a card
  v1.patch("/cards/:id", async (c) => {
    const userId = getUserIdFromContext(c);
    const cardId = parseInt(c.req.param("id"), 10);

    const existingCard = db
      .query<Card, [number]>("SELECT * FROM cards WHERE id = ?")
      .get(cardId);

    if (!existingCard) {
      return c.json({ error: "Card not found" }, 404);
    }

    const body = await c.req.json<{
      title?: string;
      description?: string;
      status?: string;
      priority?: number;
      type?: string;
      version?: number;
    }>();

    // Optimistic locking: check version if provided
    if (body.version !== undefined && body.version !== existingCard.version) {
      return c.json({ 
        error: "Version conflict", 
        current_version: existingCard.version 
      }, 409);
    }

    // Validate status if provided
    const validStatuses = [
      "backlog",
      "in_progress",
      "review",
      "blocked",
      "done",
      "wont_do",
      "invalid",
    ];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` }, 400);
    }

    // Validate priority if provided
    if (body.priority !== undefined && (body.priority < 0 || body.priority > 100)) {
      return c.json({ error: "Priority must be between 0 and 100" }, 400);
    }

    // Validate type if provided
    if (body.type && !validCardTypes.includes(body.type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validCardTypes.join(", ")}` }, 400);
    }

    // Build update query dynamically
    const updates: string[] = [];
    const params: (string | number)[] = [];

    if (body.title !== undefined) {
      updates.push("title = ?");
      params.push(body.title);
    }
    if (body.description !== undefined) {
      updates.push("description = ?");
      params.push(body.description);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      params.push(body.status);
    }
    if (body.priority !== undefined) {
      updates.push("priority = ?");
      params.push(body.priority);
    }
    if (body.type !== undefined) {
      updates.push("type = ?");
      params.push(body.type);
    }

    if (updates.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(cardId);

    db.run(
      `UPDATE cards SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    // Create audit record
    db.run(
      `INSERT INTO cards_audit (card_id, old_status, new_status, old_title, new_title, old_description, new_description, old_priority, new_priority, changed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cardId,
        existingCard.status,
        body.status ?? existingCard.status,
        existingCard.title,
        body.title ?? existingCard.title,
        existingCard.description,
        body.description ?? existingCard.description,
        existingCard.priority,
        body.priority ?? existingCard.priority,
        userId,
      ]
    );

    const updatedCard = db
      .query<Card, [number]>("SELECT * FROM cards WHERE id = ?")
      .get(cardId);

    return c.json(updatedCard);
  });

  // GET /cards/:id/comments - List comments for a card
  v1.get("/cards/:id/comments", (c) => {
    const cardId = parseInt(c.req.param("id"), 10);

    const card = db
      .query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?")
      .get(cardId);

    if (!card) {
      return c.json({ error: "Card not found" }, 404);
    }

    const comments = db
      .query<Comment, [number]>(
        "SELECT * FROM comments WHERE card_id = ? AND status != 'deleted' ORDER BY created_at ASC"
      )
      .all(cardId);

    return c.json(comments);
  });

  // POST /cards/:id/comments - Add a comment to a card
  v1.post("/cards/:id/comments", async (c) => {
    const userId = getUserIdFromContext(c);
    const cardId = parseInt(c.req.param("id"), 10);

    const card = db
      .query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?")
      .get(cardId);

    if (!card) {
      return c.json({ error: "Card not found" }, 404);
    }

    const body = await c.req.json<{ message: string }>();

    if (!body.message) {
      return c.json({ error: "message is required" }, 400);
    }

    const result = db
      .query<{ id: number }, [number, string, number]>(
        `INSERT INTO comments (card_id, message, created_by)
         VALUES (?, ?, ?)
         RETURNING id`
      )
      .get(cardId, body.message, userId);

    const comment = db
      .query<Comment, [number]>("SELECT * FROM comments WHERE id = ?")
      .get(result!.id);

    return c.json(comment, 201);
  });

  // DELETE /comments/:id - Soft delete a comment
  v1.delete("/comments/:id", (c) => {
    const commentId = parseInt(c.req.param("id"), 10);

    const comment = db
      .query<Comment, [number]>("SELECT * FROM comments WHERE id = ?")
      .get(commentId);

    if (!comment) {
      return c.json({ error: "Comment not found" }, 404);
    }

    if (comment.status === "deleted") {
      return c.json({ error: "Comment already deleted" }, 400);
    }

    db.run("UPDATE comments SET status = 'deleted' WHERE id = ?", [commentId]);

    return c.json({ success: true });
  });

  // Reference types
  const validReferenceTypes = [
    "blocks",
    "blocked_by",
    "relates_to",
    "duplicates",
    "duplicated_by",
    "parent_of",
    "child_of",
    "follows",
    "precedes",
    "clones",
    "cloned_by",
  ];

  // GET /cards/:id/references - Get all references for a card
  v1.get("/cards/:id/references", (c) => {
    const cardId = parseInt(c.req.param("id"), 10);

    const card = db
      .query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?")
      .get(cardId);

    if (!card) {
      return c.json({ error: "Card not found" }, 404);
    }

    const outgoing = db
      .query<CardReference & { target_title: string }, [number]>(
        `SELECT cr.*, c.title as target_title 
         FROM card_references cr 
         JOIN cards c ON c.id = cr.target_card_id 
         WHERE cr.source_card_id = ?`
      )
      .all(cardId);

    const incoming = db
      .query<CardReference & { source_title: string }, [number]>(
        `SELECT cr.*, c.title as source_title 
         FROM card_references cr 
         JOIN cards c ON c.id = cr.source_card_id 
         WHERE cr.target_card_id = ?`
      )
      .all(cardId);

    return c.json({ outgoing, incoming });
  });

  // POST /cards/:id/references - Add a reference
  v1.post("/cards/:id/references", async (c) => {
    const sourceCardId = parseInt(c.req.param("id"), 10);

    const sourceCard = db
      .query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?")
      .get(sourceCardId);

    if (!sourceCard) {
      return c.json({ error: "Source card not found" }, 404);
    }

    const body = await c.req.json<{
      target_card_id: number;
      reference_type: string;
    }>();

    if (!body.target_card_id || !body.reference_type) {
      return c.json({ error: "target_card_id and reference_type are required" }, 400);
    }

    if (!validReferenceTypes.includes(body.reference_type)) {
      return c.json({ error: `Invalid reference_type. Must be one of: ${validReferenceTypes.join(", ")}` }, 400);
    }

    const targetCard = db
      .query<{ id: number }, [number]>("SELECT id FROM cards WHERE id = ?")
      .get(body.target_card_id);

    if (!targetCard) {
      return c.json({ error: "Target card not found" }, 404);
    }

    if (sourceCardId === body.target_card_id) {
      return c.json({ error: "Cannot reference self" }, 400);
    }

    try {
      const result = db
        .query<{ id: number }, [number, number, string]>(
          `INSERT INTO card_references (source_card_id, target_card_id, reference_type)
           VALUES (?, ?, ?)
           RETURNING id`
        )
        .get(sourceCardId, body.target_card_id, body.reference_type);

      const reference = db
        .query<CardReference, [number]>("SELECT * FROM card_references WHERE id = ?")
        .get(result!.id);

      return c.json(reference, 201);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
        return c.json({ error: "Reference already exists" }, 400);
      }
      throw e;
    }
  });

  // DELETE /cards/:id/references/:refId - Remove a reference
  v1.delete("/cards/:id/references/:refId", (c) => {
    const cardId = parseInt(c.req.param("id"), 10);
    const refId = parseInt(c.req.param("refId"), 10);

    const reference = db
      .query<CardReference, [number]>("SELECT * FROM card_references WHERE id = ?")
      .get(refId);

    if (!reference) {
      return c.json({ error: "Reference not found" }, 404);
    }

    if (reference.source_card_id !== cardId) {
      return c.json({ error: "Reference does not belong to this card" }, 400);
    }

    db.run("DELETE FROM card_references WHERE id = ?", [refId]);

    return c.json({ success: true });
  });

  app.route("/api/v1", v1);

  // Serve built static files from dist/
  app.use("/*", serveStatic({ root: "./dist" }));

  return app;
}
