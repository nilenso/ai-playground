import { useEffect, useState } from "react";
import Markdown from "react-markdown";

interface Project {
  id: number;
  name: string;
  repository_url: string;
  created_at: string;
}

interface CardReference {
  id: number;
  source_card_id: number;
  target_card_id: number;
  reference_type: string;
  created_at: string;
  target_title?: string;
  source_title?: string;
}

interface Card {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  type: string;
  created_at: string;
  version: number;
  references: {
    outgoing: CardReference[];
    incoming: CardReference[];
  };
}

const CARD_TYPE_ICONS: Record<string, string> = {
  bug: "🐛",
  story: "📖",
  task: "✅",
  epic: "🏔️",
  spike: "🔬",
  chore: "🔧",
};

interface Comment {
  id: number;
  card_id: number;
  message: string;
  created_by: number;
  created_at: string;
}

function getToken(): string | null {
  const match = document.cookie.match(/(?:^|; )token=([^;]*)/);
  return match?.[1] ?? null;
}

function PriorityDisplay({ priority }: { priority: number }) {
  switch (priority) {
    case 20:
      return <span title="Low priority">▰▱▱</span>;
    case 50:
      return <span title="Medium priority">▰▰▱</span>;
    case 80:
      return <span title="High priority">▰▰▰</span>;
    default:
      return <span>{priority}</span>;
  }
}

const TERMINAL_STATUSES = ["done", "wont_do", "invalid"] as const;

function setToken(token: string) {
  document.cookie = `token=${token}; path=/; max-age=31536000`;
}

function clearToken() {
  document.cookie = "token=; path=/; max-age=0";
}

function NewProjectForm({
  token,
  onSuccess,
  onCancel,
}: {
  token: string;
  onSuccess: (project: Project) => void;
  onCancel: () => void;
}) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUrlChange = (url: string) => {
    setRepositoryUrl(url);
    const parts = url.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      setName(`${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repository_url: repositoryUrl, name }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create project");
      }

      const project = await res.json();
      onSuccess(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog open>
      <article>
        <header>
          <button
            aria-label="Close"
            rel="prev"
            onClick={onCancel}
            disabled={submitting}
          />
          <h2>Add Project</h2>
        </header>
        <form onSubmit={handleSubmit}>
          <label>
            Repository URL
            <input
              type="url"
              value={repositoryUrl}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="https://github.com/owner/repository"
              required
              autoFocus
              disabled={submitting}
            />
          </label>
          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="owner/repository"
              required
              disabled={submitting}
            />
          </label>
          {error && <p style={{ color: "var(--pico-del-color)" }}>{error}</p>}
          <button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? "Creating..." : "Create Project"}
          </button>
        </form>
      </article>
    </dialog>
  );
}

function CardTile({ card, onClick }: { card: Card; onClick: () => void }) {
  const typeIcon = CARD_TYPE_ICONS[card.type] || "✅";
  return (
    <div className="card-tile" onClick={onClick}>
      <div className="card-tile-header">
        <span className="card-tile-type" title={card.type}>{typeIcon}</span>
        <h3 className="card-tile-title">{card.title}</h3>
        <span className="card-tile-id">#{card.id}</span>
      </div>
      {card.description && (
        <p className="card-tile-description">{card.description}</p>
      )}
      <div className="card-tile-meta">
        <span className="card-tile-status" data-status={card.status}>
          {card.status.replace("_", " ")}
        </span>
        <PriorityDisplay priority={card.priority} />
      </div>
    </div>
  );
}

interface CardReference {
  id: number;
  source_card_id: number;
  target_card_id: number;
  reference_type: string;
  created_at: string;
  target_title?: string;
  source_title?: string;
}

const REFERENCE_TYPE_LABELS: Record<string, string> = {
  blocks: "Blocks",
  blocked_by: "Blocked by",
  relates_to: "Relates to",
  duplicates: "Duplicates",
  duplicated_by: "Duplicated by",
  parent_of: "Parent of",
  child_of: "Child of",
  follows: "Follows",
  precedes: "Precedes",
  clones: "Clones",
  cloned_by: "Cloned by",
};

const INVERSE_REFERENCE_TYPE: Record<string, string> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  relates_to: "relates_to",
  duplicates: "duplicated_by",
  duplicated_by: "duplicates",
  parent_of: "child_of",
  child_of: "parent_of",
  follows: "precedes",
  precedes: "follows",
  clones: "cloned_by",
  cloned_by: "clones",
};

function SidePanel({
  card,
  token,
  onClose,
}: {
  card: Card | null;
  token: string;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [references, setReferences] = useState<{
    outgoing: CardReference[];
    incoming: CardReference[];
  }>({ outgoing: [], incoming: [] });
  const [loadingRefs, setLoadingRefs] = useState(false);

  useEffect(() => {
    if (!card) return;

    setLoadingComments(true);
    setLoadingRefs(true);

    fetch(`/api/v1/cards/${card.id}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : []))
      .then(setComments)
      .finally(() => setLoadingComments(false));

    fetch(`/api/v1/cards/${card.id}/references`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : { outgoing: [], incoming: [] }))
      .then(setReferences)
      .finally(() => setLoadingRefs(false));
  }, [card, token]);

  return (
    <>
      <div
        className={`side-panel-backdrop ${card ? "open" : ""}`}
        onClick={onClose}
      />
      <div className={`side-panel ${card ? "open" : ""}`}>
        {card && (
          <>
            <div className="side-panel-header">
              <h2 className="side-panel-title">{card.title}</h2>
              <button className="side-panel-close" onClick={onClose}>
                ×
              </button>
            </div>
            <table className="side-panel-meta-table">
              <tbody>
                <tr>
                  <th>ID</th>
                  <td>#{card.id}</td>
                </tr>
                <tr>
                  <th>Version</th>
                  <td>{card.version}</td>
                </tr>
                <tr>
                  <th>Type</th>
                  <td>{CARD_TYPE_ICONS[card.type] || "✅"} {card.type}</td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>
                    <span className="card-tile-status" data-status={card.status}>
                      {card.status.replace("_", " ")}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th>Priority</th>
                  <td><PriorityDisplay priority={card.priority} /></td>
                </tr>
                <tr>
                  <th>Created</th>
                  <td>{new Date(card.created_at).toLocaleDateString()}</td>
                </tr>
              </tbody>
            </table>
            {(references.outgoing.length > 0 || references.incoming.length > 0 || loadingRefs) && (
              <div className="side-panel-section">
                <h4>References</h4>
                {loadingRefs ? (
                  <p aria-busy="true">Loading references...</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Relationship</th>
                        <th>Card</th>
                      </tr>
                    </thead>
                    <tbody>
                      {references.outgoing.map((ref) => (
                        <tr key={ref.id}>
                          <td>{REFERENCE_TYPE_LABELS[ref.reference_type] || ref.reference_type}</td>
                          <td>#{ref.target_card_id} {ref.target_title}</td>
                        </tr>
                      ))}
                      {references.incoming.map((ref) => {
                        const inverseType = INVERSE_REFERENCE_TYPE[ref.reference_type] || ref.reference_type;
                        return (
                          <tr key={ref.id}>
                            <td>{REFERENCE_TYPE_LABELS[inverseType] || inverseType}</td>
                            <td>#{ref.source_card_id} {ref.source_title}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {card.description && (
              <div className="side-panel-section">
                <h4>Description</h4>
                <Markdown>{card.description}</Markdown>
              </div>
            )}
            <div className="side-panel-section">
              <h4>Comments</h4>
              {loadingComments ? (
                <p aria-busy="true">Loading comments...</p>
              ) : comments.length === 0 ? (
                <p><em>No comments</em></p>
              ) : (
                comments.map((c) => (
                  <div key={c.id} style={{ marginBottom: "1rem" }}>
                    <small style={{ color: "var(--muted-color)" }}>
                      {new Date(c.created_at).toLocaleString()}
                    </small>
                    <Markdown>{c.message}</Markdown>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

type ViewMode = "card" | "table";

function CardTableRow({ card, onClick }: { card: Card; onClick: () => void }) {
  const typeIcon = CARD_TYPE_ICONS[card.type] || "✅";
  return (
    <tr className="card-table-row" onClick={onClick}>
      <td className="card-table-id">#{card.id}</td>
      <td className="card-table-type" title={card.type}>{typeIcon}</td>
      <td className="card-table-title">{card.title}</td>
      <td className="card-table-priority"><PriorityDisplay priority={card.priority} /></td>
      <td className="card-table-status">
        <span className="card-tile-status" data-status={card.status}>
          {card.status.replace("_", " ")}
        </span>
      </td>
    </tr>
  );
}

function CardTable({ cards, onCardClick }: { cards: Card[]; onCardClick: (card: Card) => void }) {
  return (
    <table className="card-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Type</th>
          <th>Title</th>
          <th>Priority</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <CardTableRow key={card.id} card={card} onClick={() => onCardClick(card)} />
        ))}
      </tbody>
    </table>
  );
}

function ViewToggle({ viewMode, onChange }: { viewMode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className="view-toggle" role="group">
      <button
        className={viewMode === "card" ? "active" : ""}
        onClick={() => onChange("card")}
        title="Card view"
        aria-pressed={viewMode === "card"}
      >
        ▦
      </button>
      <button
        className={viewMode === "table" ? "active" : ""}
        onClick={() => onChange("table")}
        title="Table view"
        aria-pressed={viewMode === "table"}
      >
        ☰
      </button>
    </div>
  );
}

export function App() {
  const [token, setTokenState] = useState<string | null>(getToken);
  const [tokenInput, setTokenInput] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(() => {
    const saved = localStorage.getItem("selectedProjectId");
    return saved ? parseInt(saved, 10) : null;
  });
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = sessionStorage.getItem("viewMode");
    return (saved === "card" || saved === "table") ? saved : "card";
  });

  const fetchData = async (authToken: string) => {
    setLoading(true);
    setError(null);
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const [projectsRes, cardsRes] = await Promise.all([
        fetch("/api/v1/projects", { headers }),
        fetch("/api/v1/cards", { headers }),
      ]);

      if (!projectsRes.ok || !cardsRes.ok) {
        if (projectsRes.status === 401 || cardsRes.status === 401) {
          clearToken();
          setTokenState(null);
          throw new Error("Invalid token");
        }
        throw new Error("Failed to fetch data");
      }

      const [projectsData, cardsData] = await Promise.all([
        projectsRes.json(),
        cardsRes.json(),
      ]);

      setProjects(projectsData);
      setCards(cardsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchData(token);
    }
  }, [token]);

  // Auto-select first project if none selected, or validate saved selection
  useEffect(() => {
    if (projects.length > 0) {
      const savedExists = selectedProjectId !== null && projects.some(p => p.id === selectedProjectId);
      if (!savedExists) {
        setSelectedProjectId(projects[0]!.id);
      }
    }
  }, [projects]);

  // Persist selected project to localStorage
  useEffect(() => {
    if (selectedProjectId !== null) {
      localStorage.setItem("selectedProjectId", String(selectedProjectId));
    }
  }, [selectedProjectId]);

  // Persist view mode to sessionStorage
  useEffect(() => {
    sessionStorage.setItem("viewMode", viewMode);
  }, [viewMode]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tokenInput.trim()) {
      setToken(tokenInput.trim());
      setTokenState(tokenInput.trim());
      setTokenInput("");
    }
  };

  const handleLogout = () => {
    clearToken();
    setTokenState(null);
    setProjects([]);
    setCards([]);
  };

  if (!token) {
    return (
      <main className="container">
        <h1>FiveTwo</h1>
        <dialog open>
          <article>
            <h2>Enter JWT Token</h2>
            <form onSubmit={handleSubmit}>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste your JWT token"
                autoFocus
              />
              <button type="submit">Save</button>
            </form>
          </article>
        </dialog>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="container">
        <p aria-busy="true">Loading...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="container">
        <h1>FiveTwo</h1>
        <p>Error: {error}</p>
        <button onClick={handleLogout}>Try Again</button>
      </main>
    );
  }

  const handleProjectCreated = (project: Project) => {
    setProjects((prev) => [project, ...prev]);
    setShowNewProjectForm(false);
    setSelectedProjectId(project.id);
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectCards = selectedProjectId ? cards.filter((c) => c.project_id === selectedProjectId) : [];
  const activeCards = projectCards.filter(
    (c) => !TERMINAL_STATUSES.includes(c.status as typeof TERMINAL_STATUSES[number])
  );
  const terminatedCards = projectCards.filter(
    (c) => TERMINAL_STATUSES.includes(c.status as typeof TERMINAL_STATUSES[number])
  );

  return (
    <main className="container">
      <header>
        <h1>FiveTwo</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
            style={{ minWidth: "200px" }}
          >
            <option value="" disabled>Select a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {selectedProject && (
            <a
              href={selectedProject.repository_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open repository"
              style={{ textDecoration: "none" }}
            >
              ↗
            </a>
          )}
          <button onClick={() => setShowNewProjectForm(true)}>
            Add Project
          </button>
          <button onClick={handleLogout} className="outline">Logout</button>
        </div>
      </header>

      {showNewProjectForm && (
        <NewProjectForm
          token={token}
          onSuccess={handleProjectCreated}
          onCancel={() => setShowNewProjectForm(false)}
        />
      )}

      {projects.length === 0 ? (
        <p>No projects yet.</p>
      ) : !selectedProject ? (
        <p>Select a project to view cards.</p>
      ) : (
        <section>
          <div className="section-header">
            <ViewToggle viewMode={viewMode} onChange={setViewMode} />
          </div>
          {activeCards.length === 0 ? (
            <p>No active cards in this project.</p>
          ) : viewMode === "card" ? (
            <div className="card-grid">
              {activeCards.map((c) => (
                <CardTile key={c.id} card={c} onClick={() => setSelectedCard(c)} />
              ))}
            </div>
          ) : (
            <CardTable cards={activeCards} onCardClick={setSelectedCard} />
          )}
          {terminatedCards.length > 0 && (
            <details>
              <summary>
                Completed ({terminatedCards.length} card{terminatedCards.length !== 1 ? "s" : ""})
              </summary>
              {viewMode === "card" ? (
                <div className="card-grid">
                  {terminatedCards.map((c) => (
                    <CardTile key={c.id} card={c} onClick={() => setSelectedCard(c)} />
                  ))}
                </div>
              ) : (
                <CardTable cards={terminatedCards} onCardClick={setSelectedCard} />
              )}
            </details>
          )}
        </section>
      )}

      <SidePanel
        card={selectedCard}
        token={token}
        onClose={() => setSelectedCard(null)}
      />
    </main>
  );
}

export default App;
