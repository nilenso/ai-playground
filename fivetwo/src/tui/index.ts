import {
  createCliRenderer,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type KeyEvent,
  type CliRenderer,
} from "@opentui/core";

// Types
interface Project {
  id: number;
  name: string;
  repository_url: string;
  created_at: string;
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

// API Client
class FivetwoCli {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async getProjects(): Promise<Project[]> {
    return this.fetch<Project[]>("/api/v1/projects");
  }

  async getCards(projectId?: number): Promise<Card[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId.toString());
    const query = params.toString();
    return this.fetch<Card[]>(`/api/v1/cards${query ? `?${query}` : ""}`);
  }
}

// Type icons
const typeIcons: Record<string, string> = {
  story: "📖",
  bug: "🐛",
  task: "✅",
  epic: "🏔️",
  spike: "🔬",
  chore: "🧹",
};

// Main TUI App
class FivetwoTUI {
  private renderer!: CliRenderer;
  private api: FivetwoCli;
  private projects: Project[] = [];
  private cards: Card[] = [];
  private currentProjectIndex = 0;

  // UI Elements
  private headerText!: TextRenderable;
  private cardsList!: SelectRenderable;
  private statusBar!: TextRenderable;

  constructor(baseUrl: string, token: string) {
    this.api = new FivetwoCli(baseUrl, token);
  }

  async init() {
    try {
      this.renderer = await createCliRenderer({
        targetFps: 30,
      });

      // Load initial data
      await this.loadProjects();
      if (this.projects.length > 0) {
        await this.loadCards();
      }

      this.setupUI();
      this.setupKeyBindings();
      this.renderer.start();
    } catch (e) {
      console.error("Init error:", e);
      process.exit(1);
    }
  }

  private async loadProjects() {
    try {
      this.projects = await this.api.getProjects();
    } catch (e) {
      console.error("Failed to load projects:", e);
      this.projects = [];
    }
  }

  private async loadCards() {
    if (this.projects.length === 0) return;

    const project = this.projects[this.currentProjectIndex];
    try {
      const cards = await this.api.getCards(project?.id);
      this.cards = this.sortCards(cards);
    } catch (e) {
      console.error("Failed to load cards:", e);
      this.cards = [];
    }
  }

  private sortCards(cards: Card[]): Card[] {
    const statusOrder: Record<string, number> = {
      in_progress: 0,
      backlog: 1,
      review: 2,
      blocked: 3,
      done: 4,
      wont_do: 5,
      invalid: 6,
    };

    return cards.sort((a, b) => {
      // First by status
      const statusDiff = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
      if (statusDiff !== 0) return statusDiff;

      // Then by priority (highest first)
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;

      // Then by id (highest first)
      return b.id - a.id;
    });
  }

  private setupUI() {
    // Get terminal size from renderer
    const termHeight = process.stdout.rows || 24;

    // Header
    const projectName = this.projects[this.currentProjectIndex]?.name || "No project";
    this.headerText = new TextRenderable(this.renderer, {
      id: "header",
      content: `📋 fivetwo - ${projectName} | ←/→: Switch project | ↑/↓: Navigate | q: Quit`,
      fg: "#00FFFF",
      width: "100%",
    });

    // Cards list
    const cardOptions = this.getCardOptions();
    this.cardsList = new SelectRenderable(this.renderer, {
      id: "cards-list",
      width: "100%",
      height: termHeight - 4,
      options: cardOptions.length > 0 ? cardOptions : [{ name: "No cards found", description: "" }],
      selectedTextColor: "#00FFFF",
      top: 2,
    });

    // Status bar
    this.statusBar = new TextRenderable(this.renderer, {
      id: "status-bar",
      content: ` Cards: ${this.cards.length} | Project ${this.currentProjectIndex + 1}/${this.projects.length}`,
      fg: "#888888",
      width: "100%",
      position: "absolute",
      bottom: 0,
    });

    // Add to root
    this.renderer.root.add(this.headerText);
    this.renderer.root.add(this.cardsList);
    this.renderer.root.add(this.statusBar);

    // Focus cards list
    this.cardsList.focus();
  }

  private getCardOptions() {
    return this.cards.map((card) => {
      const icon = typeIcons[card.type] || "📄";
      const status = card.status.padEnd(11);
      const priority = `P${card.priority}`.padStart(4);
      const title = card.title.length > 50 ? card.title.slice(0, 47) + "..." : card.title;
      return {
        name: `${icon} #${card.card_number.toString().padStart(3)} | ${status} | ${priority} | ${title}`,
        description: card.description?.slice(0, 80) || "",
      };
    });
  }

  private updateCardsList() {
    const options = this.getCardOptions();
    if (options.length === 0) {
      this.cardsList.options = [{ name: "No cards found", description: "" }];
    } else {
      this.cardsList.options = options;
    }
  }

  private updateHeader() {
    const projectName = this.projects[this.currentProjectIndex]?.name || "No project";
    this.headerText.content = `📋 fivetwo - ${projectName} | ←/→: Switch project | ↑/↓: Navigate | q: Quit`;
  }

  private updateStatusBar() {
    this.statusBar.content = ` Cards: ${this.cards.length} | Project ${this.currentProjectIndex + 1}/${this.projects.length}`;
  }

  private cleanup() {
    this.renderer.destroy();
  }

  private setupKeyBindings() {
    this.renderer.keyInput.on("keypress", async (key: KeyEvent) => {
      switch (key.name) {
        case "q":
          this.cleanup();
          process.exit(0);
          break;

        case "left":
          await this.prevProject();
          break;

        case "right":
          await this.nextProject();
          break;
      }
    });

    // Handle Ctrl+C
    process.on("SIGINT", () => {
      this.cleanup();
      process.exit(0);
    });
  }

  private async prevProject() {
    if (this.projects.length === 0) return;
    this.currentProjectIndex = (this.currentProjectIndex - 1 + this.projects.length) % this.projects.length;
    await this.loadCards();
    this.updateCardsList();
    this.updateHeader();
    this.updateStatusBar();
  }

  private async nextProject() {
    if (this.projects.length === 0) return;
    this.currentProjectIndex = (this.currentProjectIndex + 1) % this.projects.length;
    await this.loadCards();
    this.updateCardsList();
    this.updateHeader();
    this.updateStatusBar();
  }
}

// Main
async function main() {
  const baseUrl = process.env.FIVETWO_URL || "http://localhost:3000";
  const token = process.env.FIVETWO_TOKEN;

  if (!token) {
    console.error("Error: FIVETWO_TOKEN environment variable is required");
    console.error("Generate one with: bun run auth <username>");
    process.exit(1);
  }

  const tui = new FivetwoTUI(baseUrl, token);
  await tui.init();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
