import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "./server";
import { generateJwt } from "./auth";

const JWT_SECRET = "test-secret-that-is-at-least-32-chars";

function createTestDb(): Database {
  const db = new Database(":memory:", { strict: true });
  db.run("PRAGMA foreign_keys = ON;");

  // Create tables
  db.run(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_url)
    )
  `);

  db.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('human', 'ai')),
      email TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      card_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'in_progress', 'review', 'blocked', 'done', 'wont_do', 'invalid')),
      priority INTEGER NOT NULL DEFAULT 50 CHECK(priority >= 0 AND priority <= 100),
      type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('story', 'bug', 'task', 'epic', 'spike', 'chore')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(project_id, card_number)
    )
  `);

  db.run(`
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id),
      message TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'deleted'))
    )
  `);

  db.run(`
    CREATE TABLE cards_audit (
      id INTEGER PRIMARY KEY,
      card_id INTEGER NOT NULL REFERENCES cards(id),
      old_status TEXT,
      new_status TEXT,
      old_title TEXT,
      new_title TEXT,
      old_description TEXT,
      new_description TEXT,
      old_priority INTEGER,
      new_priority INTEGER,
      changed_by INTEGER NOT NULL REFERENCES users(id),
      changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // FTS table for cards search
  db.run(`
    CREATE VIRTUAL TABLE cards_fts USING fts5(
      title,
      description,
      content='cards',
      content_rowid='id'
    )
  `);

  db.run(`
    CREATE TRIGGER cards_fts_insert AFTER INSERT ON cards BEGIN
      INSERT INTO cards_fts(rowid, title, description)
      VALUES (NEW.id, NEW.title, NEW.description);
    END
  `);

  db.run(`
    CREATE TRIGGER cards_fts_update AFTER UPDATE ON cards BEGIN
      INSERT INTO cards_fts(cards_fts, rowid, title, description)
      VALUES ('delete', OLD.id, OLD.title, OLD.description);
      INSERT INTO cards_fts(rowid, title, description)
      VALUES (NEW.id, NEW.title, NEW.description);
    END
  `);

  // Card references table
  db.run(`
    CREATE TABLE card_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_card_id INTEGER NOT NULL REFERENCES cards(id),
      target_card_id INTEGER NOT NULL REFERENCES cards(id),
      reference_type TEXT NOT NULL CHECK(reference_type IN (
        'blocks', 'blocked_by',
        'relates_to',
        'duplicates', 'duplicated_by',
        'parent_of', 'child_of',
        'follows', 'precedes',
        'clones', 'cloned_by'
      )),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_card_id, target_card_id, reference_type),
      CHECK(source_card_id != target_card_id)
    )
  `);

  // Version triggers
  db.run(`
    CREATE TRIGGER increment_card_version_on_update
    AFTER UPDATE ON cards
    WHEN OLD.title != NEW.title 
      OR OLD.description IS NOT NEW.description 
      OR OLD.status != NEW.status 
      OR OLD.priority != NEW.priority
    BEGIN
      UPDATE cards SET version = version + 1 WHERE id = NEW.id;
    END
  `);

  db.run(`
    CREATE TRIGGER increment_card_version_on_comment_add
    AFTER INSERT ON comments
    BEGIN
      UPDATE cards SET version = version + 1 WHERE id = NEW.card_id;
    END
  `);

  db.run(`
    CREATE TRIGGER increment_card_version_on_comment_delete
    AFTER UPDATE ON comments
    WHEN OLD.status != 'deleted' AND NEW.status = 'deleted'
    BEGIN
      UPDATE cards SET version = version + 1 WHERE id = NEW.card_id;
    END
  `);

  db.run(`
    CREATE TRIGGER increment_card_version_on_reference_add
    AFTER INSERT ON card_references
    BEGIN
      UPDATE cards SET version = version + 1 WHERE id = NEW.source_card_id;
    END
  `);

  db.run(`
    CREATE TRIGGER increment_card_version_on_reference_delete
    AFTER DELETE ON card_references
    BEGIN
      UPDATE cards SET version = version + 1 WHERE id = OLD.source_card_id;
    END
  `);

  return db;
}

describe("/api/v1/user", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });
  });

  afterAll(() => {
    db.close();
  });

  test("returns 401 without auth token", async () => {
    const res = await app.request("/api/v1/user");
    expect(res.status).toBe(401);
  });

  test("returns 401 with invalid token", async () => {
    const res = await app.request("/api/v1/user", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 when user not found in database", async () => {
    const token = await generateJwt(JWT_SECRET, 999);

    const res = await app.request("/api/v1/user", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "User not found" });
  });

  test("returns user info with valid token", async () => {
    db.run(
      "INSERT INTO users (id, username, type, email) VALUES (?, ?, ?, ?)",
      [1, "alice", "human", "alice@example.com"]
    );

    const token = await generateJwt(JWT_SECRET, 1);

    const res = await app.request("/api/v1/user", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);

    const user = await res.json();
    expect(user.id).toBe(1);
    expect(user.username).toBe("alice");
    expect(user.type).toBe("human");
    expect(user.email).toBe("alice@example.com");
    expect(user.created_at).toBeDefined();
  });

  test("returns user without email when email is null", async () => {
    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [
      2,
      "bob",
      "ai",
    ]);

    const token = await generateJwt(JWT_SECRET, 2);

    const res = await app.request("/api/v1/user", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);

    const user = await res.json();
    expect(user.id).toBe(2);
    expect(user.username).toBe("bob");
    expect(user.type).toBe("ai");
    expect(user.email).toBeNull();
  });
});

describe("/api/v1/status", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });
  });

  afterAll(() => {
    db.close();
  });

  test("returns 401 without auth token", async () => {
    const res = await app.request("/api/v1/status");
    expect(res.status).toBe(401);
  });

  test("returns status with valid token", async () => {
    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [
      1,
      "testuser",
      "human",
    ]);

    const token = await generateJwt(JWT_SECRET, 1);

    const res = await app.request("/api/v1/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeDefined();
  });
});

describe("POST /api/v1/projects", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });
    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [1, "testuser", "human"]);
    token = await generateJwt(JWT_SECRET, 1);
  });

  afterAll(() => {
    db.close();
  });

  test("creates a project with valid fields", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repository_url: "https://github.com/testowner/testrepo",
      }),
    });

    expect(res.status).toBe(201);
    const project = await res.json();
    expect(project.id).toBeDefined();
    expect(project.name).toBe("testowner/testrepo");
    expect(project.repository_url).toBe("https://github.com/testowner/testrepo");
    expect(project.created_at).toBeDefined();
  });

  test("returns 400 for missing required fields", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("required");
  });

  test("returns 400 for duplicate project", async () => {
    // First create succeeds
    await app.request("/api/v1/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repository_url: "https://github.com/duplicate/repo",
      }),
    });

    // Second create fails
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repository_url: "https://github.com/duplicate/repo",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("already exists");
  });
});

describe("/api/v1/cards", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let token: string;

  beforeAll(async () => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });

    // Create test user and project
    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [1, "testuser", "human"]);
    db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
      1, "test/repo", "https://github.com/test/repo"
    ]);

    token = await generateJwt(JWT_SECRET, 1);
  });

  afterAll(() => {
    db.close();
  });

  describe("POST /cards", () => {
    test("creates a card with required fields", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: 1,
          title: "Test Card",
        }),
      });

      expect(res.status).toBe(201);
      const card = await res.json();
      expect(card.id).toBeDefined();
      expect(card.title).toBe("Test Card");
      expect(card.status).toBe("backlog");
      expect(card.priority).toBe(50);
      expect(card.created_by).toBe(1);
    });

    test("creates a card with all fields", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: 1,
          title: "Full Card",
          description: "A description",
          status: "in_progress",
          priority: 80,
        }),
      });

      expect(res.status).toBe(201);
      const card = await res.json();
      expect(card.title).toBe("Full Card");
      expect(card.description).toBe("A description");
      expect(card.status).toBe("in_progress");
      expect(card.priority).toBe(80);
    });

    test("returns 400 for missing required fields", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "No project" }),
      });

      expect(res.status).toBe(400);
    });

    test("returns 404 for non-existent project", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 999, title: "Test" }),
      });

      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid status", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 1, title: "Test", status: "invalid_status" }),
      });

      expect(res.status).toBe(400);
    });

    test("returns 400 for invalid priority", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 1, title: "Test", priority: 150 }),
      });

      expect(res.status).toBe(400);
    });

    test("assigns sequential card_number per project", async () => {
      // Create a second project (use id 3 to avoid conflicts with other tests)
      db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
        3, "seq/project", "https://github.com/seq/project"
      ]);

      // Create cards in the new project
      const res1 = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 3, title: "Project 3 Card A" }),
      });
      const card1 = await res1.json();

      const res2 = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 3, title: "Project 3 Card B" }),
      });
      const card2 = await res2.json();

      const res3 = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 3, title: "Project 3 Card C" }),
      });
      const card3 = await res3.json();

      // Cards should have sequential numbers starting from 1
      expect(card1.card_number).toBe(1);
      expect(card2.card_number).toBe(2);
      expect(card3.card_number).toBe(3);

      // Create another project to verify independent numbering
      db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
        4, "other/project", "https://github.com/other/project"
      ]);

      const res4 = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 4, title: "Project 4 Card A" }),
      });
      const card4 = await res4.json();

      // New project starts fresh at 1
      expect(card4.card_number).toBe(1);
    });

    test("includes card_number in response", async () => {
      const res = await app.request("/api/v1/cards", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project_id: 1, title: "Card with number" }),
      });

      expect(res.status).toBe(201);
      const card = await res.json();
      expect(card.card_number).toBeDefined();
      expect(typeof card.card_number).toBe("number");
    });
  });

  describe("GET /cards", () => {
    beforeAll(() => {
      // Insert test cards
      db.run(
        "INSERT INTO cards (id, project_id, card_number, title, description, status, priority, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [10, 1, 10, "High Priority Bug", "Fix this bug", "in_progress", 90, 1]
      );
      db.run(
        "INSERT INTO cards (id, project_id, card_number, title, description, status, priority, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [11, 1, 11, "Low Priority Feature", "Add feature", "backlog", 20, 1]
      );
      db.run(
        "INSERT INTO cards (id, project_id, card_number, title, description, status, priority, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [12, 1, 12, "Search Test Card", "Description for search", "done", 50, 1]
      );
    });

    test("returns all cards", async () => {
      const res = await app.request("/api/v1/cards", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards.length).toBeGreaterThanOrEqual(3);
    });

    test("filters by status", async () => {
      const res = await app.request("/api/v1/cards?status=in_progress", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards.every((c: { status: string }) => c.status === "in_progress")).toBe(true);
    });

    test("filters by priority", async () => {
      const res = await app.request("/api/v1/cards?priority=90", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards.every((c: { priority: number }) => c.priority === 90)).toBe(true);
    });

    test("filters by id", async () => {
      const res = await app.request("/api/v1/cards?id=10", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards.length).toBe(1);
      expect(cards[0].id).toBe(10);
    });

    test("searches by FTS", async () => {
      const res = await app.request("/api/v1/cards?search=bug", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const cards = await res.json();
      expect(cards.length).toBeGreaterThanOrEqual(1);
      expect(cards.some((c: { title: string }) => c.title.toLowerCase().includes("bug"))).toBe(true);
    });
  });

  describe("PATCH /cards/:id", () => {
    let cardId: number;

    beforeAll(() => {
      const result = db
        .query<{ id: number }, []>(
          "INSERT INTO cards (project_id, card_number, title, status, priority, created_by) VALUES (1, 100, 'Update Test', 'backlog', 50, 1) RETURNING id"
        )
        .get();
      cardId = result!.id;
    });

    test("updates card title", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Updated Title" }),
      });

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.title).toBe("Updated Title");
    });

    test("updates card status", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
      });

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.status).toBe("in_progress");
    });

    test("updates card priority", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ priority: 75 }),
      });

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.priority).toBe(75);
    });

    test("creates audit record on update", async () => {
      const auditsBefore = db
        .query<{ id: number }, [number]>("SELECT * FROM cards_audit WHERE card_id = ?")
        .all(cardId);

      await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "review" }),
      });

      const auditsAfter = db
        .query<{ id: number }, [number]>("SELECT * FROM cards_audit WHERE card_id = ?")
        .all(cardId);

      expect(auditsAfter.length).toBe(auditsBefore.length + 1);
    });

    test("returns 404 for non-existent card", async () => {
      const res = await app.request("/api/v1/cards/9999", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Test" }),
      });

      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid status", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "not_a_status" }),
      });

      expect(res.status).toBe(400);
    });

    test("returns 400 for empty update", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    test("returns version in card response", async () => {
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Version Test" }),
      });

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.version).toBeDefined();
      expect(typeof card.version).toBe("number");
    });

    test("returns 409 for version conflict", async () => {
      // Get current card to know its version
      const getRes = await app.request(`/api/v1/cards?id=${cardId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const cards = await getRes.json();
      const currentVersion = cards[0]?.version || 1;

      // Try to update with wrong version
      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Conflict Test", version: currentVersion - 100 }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("Version conflict");
      expect(data.current_version).toBeDefined();
    });

    test("accepts update with correct version", async () => {
      // Get current card version
      const getRes = await app.request(`/api/v1/cards?id=${cardId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const cards = await getRes.json();
      const currentVersion = cards[0]?.version;

      const res = await app.request(`/api/v1/cards/${cardId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Correct Version Update", version: currentVersion }),
      });

      expect(res.status).toBe(200);
      const card = await res.json();
      expect(card.title).toBe("Correct Version Update");
    });
  });
});

describe("/api/v1/cards/:id/comments", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let cardId: number;

  beforeAll(async () => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });

    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [1, "testuser", "human"]);
    db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
      1, "test/repo", "https://github.com/test/repo"
    ]);

    const result = db
      .query<{ id: number }, []>(
        "INSERT INTO cards (project_id, card_number, title, created_by) VALUES (1, 200, 'Comment Test Card', 1) RETURNING id"
      )
      .get();
    cardId = result!.id;

    token = await generateJwt(JWT_SECRET, 1);
  });

  afterAll(() => {
    db.close();
  });

  test("adds a comment to a card", async () => {
    const res = await app.request(`/api/v1/cards/${cardId}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "This is a comment" }),
    });

    expect(res.status).toBe(201);
    const comment = await res.json();
    expect(comment.id).toBeDefined();
    expect(comment.message).toBe("This is a comment");
    expect(comment.card_id).toBe(cardId);
    expect(comment.created_by).toBe(1);
    expect(comment.status).toBe("created");
  });

  test("returns 400 for missing message", async () => {
    const res = await app.request(`/api/v1/cards/${cardId}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("returns 404 for non-existent card", async () => {
    const res = await app.request("/api/v1/cards/9999/comments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "Test" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("/api/v1/comments/:id", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let commentId: number;

  beforeAll(async () => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });

    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [1, "testuser", "human"]);
    db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
      1, "test/repo", "https://github.com/test/repo"
    ]);
    db.run("INSERT INTO cards (id, project_id, card_number, title, created_by) VALUES (?, ?, ?, ?, ?)", [
      1, 1, 1, "Card for comments", 1
    ]);

    const result = db
      .query<{ id: number }, []>(
        "INSERT INTO comments (card_id, message, created_by) VALUES (1, 'Test comment', 1) RETURNING id"
      )
      .get();
    commentId = result!.id;

    token = await generateJwt(JWT_SECRET, 1);
  });

  afterAll(() => {
    db.close();
  });

  test("soft deletes a comment", async () => {
    const res = await app.request(`/api/v1/comments/${commentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify it's soft deleted
    const comment = db
      .query<{ status: string }, [number]>("SELECT status FROM comments WHERE id = ?")
      .get(commentId);
    expect(comment?.status).toBe("deleted");
  });

  test("returns 400 when deleting already deleted comment", async () => {
    const res = await app.request(`/api/v1/comments/${commentId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("already deleted");
  });

  test("returns 404 for non-existent comment", async () => {
    const res = await app.request("/api/v1/comments/9999", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });
});

describe("/api/v1/cards/:id/references", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let card1Id: number;
  let card2Id: number;

  beforeAll(async () => {
    db = createTestDb();
    app = createApp({ db, jwtSecret: JWT_SECRET });

    db.run("INSERT INTO users (id, username, type) VALUES (?, ?, ?)", [1, "testuser", "human"]);
    db.run("INSERT INTO projects (id, name, repository_url) VALUES (?, ?, ?)", [
      1, "test/repo", "https://github.com/test/repo"
    ]);

    const result1 = db
      .query<{ id: number }, []>(
        "INSERT INTO cards (project_id, card_number, title, created_by) VALUES (1, 1, 'Card 1', 1) RETURNING id"
      )
      .get();
    card1Id = result1!.id;

    const result2 = db
      .query<{ id: number }, []>(
        "INSERT INTO cards (project_id, card_number, title, created_by) VALUES (1, 2, 'Card 2', 1) RETURNING id"
      )
      .get();
    card2Id = result2!.id;

    token = await generateJwt(JWT_SECRET, 1);
  });

  afterAll(() => {
    db.close();
  });

  test("creates a reference between cards", async () => {
    const res = await app.request(`/api/v1/cards/${card1Id}/references`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_card_id: card2Id,
        reference_type: "blocks",
      }),
    });

    expect(res.status).toBe(201);
    const ref = await res.json();
    expect(ref.id).toBeDefined();
    expect(ref.source_card_id).toBe(card1Id);
    expect(ref.target_card_id).toBe(card2Id);
    expect(ref.reference_type).toBe("blocks");
  });

  test("returns 400 for invalid reference type", async () => {
    const res = await app.request(`/api/v1/cards/${card1Id}/references`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_card_id: card2Id,
        reference_type: "invalid_type",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for self-reference", async () => {
    const res = await app.request(`/api/v1/cards/${card1Id}/references`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_card_id: card1Id,
        reference_type: "relates_to",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("self");
  });

  test("returns 400 for duplicate reference", async () => {
    // First reference already created in earlier test
    const res = await app.request(`/api/v1/cards/${card1Id}/references`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_card_id: card2Id,
        reference_type: "blocks",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("already exists");
  });

  test("lists references for a card", async () => {
    // References are now returned with the card via GET /cards
    const res = await app.request(`/api/v1/cards?id=${card1Id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const cards = await res.json();
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card.references).toBeDefined();
    expect(card.references.outgoing).toBeDefined();
    expect(card.references.incoming).toBeDefined();
    expect(card.references.outgoing.length).toBeGreaterThanOrEqual(1);
    expect(card.references.outgoing[0].target_title).toBe("Card 2");
  });

  test("deletes a reference", async () => {
    // Get reference ID from card
    const listRes = await app.request(`/api/v1/cards?id=${card1Id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const cards = await listRes.json();
    const refId = cards[0].references.outgoing[0].id;

    const res = await app.request(`/api/v1/cards/${card1Id}/references/${refId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("returns 404 for non-existent reference", async () => {
    const res = await app.request(`/api/v1/cards/${card1Id}/references/9999`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });
});
