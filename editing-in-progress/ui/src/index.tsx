import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import * as Automerge from "@automerge/automerge";
import {
  createEditorDocument,
  type EditorDocument,
  loadEditorDocument,
  receiveSync,
  replaceMarkdown,
  sendSync,
  type SyncReplica,
} from "./automerge_doc.ts";
import { basename, type ConnectionStatus } from "./state.ts";
import * as bridge from "./bridge.ts";
import "./style.css";

function relativeLastSeen(timestamp: number): string {
  if (!timestamp) return "now";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function App() {
  const editor = useRef<MDXEditorMethods>(null);
  const initialMarkdown = useRef("");
  const programmaticMarkdown = useRef<string | null>(null);
  const syncReplica = useRef<SyncReplica>(createEditorDocument("Untitled", ""));
  const syncTimer = useRef<number | undefined>(undefined);
  const syncing = useRef(false);
  const syncQueued = useRef(false);
  const viewingPeerRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("You");
  const [filename, setFilename] = useState("Untitled");
  const [path, setPath] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [savedMarkdown, setSavedMarkdown] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<bridge.BootstrapState["peers"]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [viewingPeer, setViewingPeer] = useState<string | null>(null);
  const dirty = !viewingPeer && markdown !== savedMarkdown;

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    thematicBreakPlugin(),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarContents: () => (
        <>
          <UndoRedo />
          <BlockTypeSelect />
          <BoldItalicUnderlineToggles />
          <ListsToggle />
          <CreateLink />
        </>
      ),
    }),
  ], []);

  const showMarkdown = useCallback((nextMarkdown: string) => {
    setMarkdown(nextMarkdown);
    const methods = editor.current;
    if (methods && methods.getMarkdown() !== nextMarkdown) {
      programmaticMarkdown.current = nextMarkdown;
      methods.setMarkdown(nextMarkdown);
    }
  }, []);

  const applyState = useCallback((state: bridge.BootstrapState) => {
    const synchronizedFilename = basename(state.filename);
    setName(state.name);
    setFilename(synchronizedFilename);
    setPath(state.path);
    setSavedMarkdown(state.markdown);
    setStatus(state.status);
    setPeers(state.peers);
    setRecentFiles(state.recentFiles);
    initialMarkdown.current = state.markdown;
    syncReplica.current = state.snapshotBase64
      ? loadEditorDocument(bridge.decodeBase64(state.snapshotBase64))
      : createEditorDocument(synchronizedFilename, state.markdown);
    viewingPeerRef.current = null;
    setViewingPeer(null);
    showMarkdown(state.markdown);
  }, [showMarkdown]);

  const applyReplicaToOwnView = useCallback(() => {
    if (viewingPeerRef.current) return;
    const own = Automerge.toJS<EditorDocument>(syncReplica.current.doc);
    setFilename(basename(own.filename));
    showMarkdown(own.markdown);
  }, [showMarkdown]);

  const flushSync = useCallback(async () => {
    if (syncing.current) {
      syncQueued.current = true;
      return;
    }
    syncing.current = true;
    try {
      do {
        syncQueued.current = false;
        for (let index = 0; index < 16; index += 1) {
          const outbound = sendSync(syncReplica.current);
          syncReplica.current = outbound.state;
          if (!outbound.message) break;
          const own = Automerge.toJS<EditorDocument>(syncReplica.current.doc);
          const response = await bridge.pushSync(
            basename(own.filename),
            outbound.message,
          );
          if (response) {
            syncReplica.current = receiveSync(syncReplica.current, response);
          }
        }
        applyReplicaToOwnView();
      } while (syncQueued.current);
    } catch (error) {
      setStatus("disconnected");
      console.error(error);
    } finally {
      syncing.current = false;
    }
  }, [applyReplicaToOwnView]);

  const onChange = useCallback((nextMarkdown: string) => {
    const expectedProgrammaticValue = programmaticMarkdown.current;
    programmaticMarkdown.current = null;
    if (expectedProgrammaticValue === nextMarkdown || viewingPeerRef.current) {
      return;
    }
    setMarkdown(nextMarkdown);
    syncReplica.current = {
      ...syncReplica.current,
      doc: replaceMarkdown(syncReplica.current.doc, nextMarkdown),
    };
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => void flushSync(), 120);
  }, [flushSync]);

  const handleSave = useCallback(async () => {
    // Always save from the local replica. A selected peer snapshot never enters it.
    if (viewingPeerRef.current) return;
    try {
      const own = Automerge.toJS<EditorDocument>(syncReplica.current.doc);
      applyState(await bridge.save(path, own.markdown));
    } catch (error) {
      setStatus("disconnected");
      console.error(error);
    }
  }, [applyState, path]);

  useEffect(() => {
    void bridge.bootstrap().then((state) => {
      applyState(state);
      setReady(true);
    });
  }, [applyState]);

  useEffect(() => {
    bridge.setEventHandler((event) => {
      switch (event.type) {
        case "state":
          applyState(event.state);
          break;
        case "connection":
          setStatus(event.status);
          break;
        case "presence":
          setPeers(event.peers);
          break;
        case "view-expired":
          if (viewingPeerRef.current === event.ownerId) {
            viewingPeerRef.current = null;
            setViewingPeer(null);
            applyReplicaToOwnView();
          }
          break;
        case "remote-state":
          if (viewingPeerRef.current === event.ownerId) {
            setFilename(basename(event.filename));
            showMarkdown(event.markdown);
          }
          break;
        case "sync": {
          const own = Automerge.toJS<EditorDocument>(syncReplica.current.doc);
          if (basename(own.filename) !== basename(event.filename)) return;
          syncReplica.current = receiveSync(
            syncReplica.current,
            bridge.toUint8Array(event.message),
          );
          applyReplicaToOwnView();
          break;
        }
      }
    });
    return () => bridge.setEventHandler(null);
  }, [applyReplicaToOwnView, applyState, showMarkdown]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) && event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setPaletteIndex(0);
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        void handleSave();
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    // Capture shortcuts before MDXEditor or the external browser handles them.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [handleSave]);

  useEffect(() => () => window.clearTimeout(syncTimer.current), []);

  async function handleOpen(candidate: string) {
    if (!candidate.trim()) return;
    try {
      applyState(await bridge.openPath(candidate.trim()));
      setPaletteOpen(false);
      setPaletteQuery("");
      setPaletteIndex(0);
    } catch (error) {
      console.error(error);
    }
  }

  async function handlePeer(peerId: string) {
    const peer = peers.find((candidate) => candidate.id === peerId);
    if (!peer?.selectable) return;
    try {
      const state = await bridge.selectPeer(peerId);
      viewingPeerRef.current = peerId;
      setViewingPeer(peerId);
      setFilename(basename(state.filename));
      showMarkdown(state.markdown);
    } catch (error) {
      console.error(error);
    }
  }

  function returnToOwnDocument() {
    viewingPeerRef.current = null;
    setViewingPeer(null);
    applyReplicaToOwnView();
  }

  const filteredRecent = useMemo(
    () =>
      recentFiles.filter((candidate) =>
        candidate.toLowerCase().includes(paletteQuery.toLowerCase())
      ),
    [paletteQuery, recentFiles],
  );

  if (!ready) return <main className="loading">Opening editor…</main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="identity">
          <input
            aria-label="Your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void bridge.rename(name)}
          />
          <button
            className={!viewingPeer ? "person active" : "person"}
            onClick={returnToOwnDocument}
          >
            <span className="presence online" />
            <span>
              <strong>You</strong>
              <small>{basename(path ?? filename)}</small>
            </span>
          </button>
        </div>
        <div className="people-label">In this room</div>
        <div className="people">
          {peers.length === 0
            ? <p className="empty">No one else is online.</p>
            : peers.map((peer) => (
              <button
                key={peer.id}
                className={viewingPeer === peer.id ? "person active" : "person"}
                disabled={!peer.selectable}
                onClick={() => void handlePeer(peer.id)}
              >
                <span
                  className={peer.online
                    ? "presence online"
                    : "presence offline"}
                />
                <span>
                  <strong>{peer.name}</strong>
                  <small>{basename(peer.filename)}</small>
                  <em>
                    {peer.online ? "online" : relativeLastSeen(peer.lastSeen)}
                  </em>
                </span>
              </button>
            ))}
        </div>
        <div className="connection">
          <span className={`status-dot ${status}`} />
          <span>{status[0].toUpperCase() + status.slice(1)}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button
            className="file-switcher"
            onClick={() => {
              setPaletteIndex(0);
              setPaletteOpen(true);
            }}
          >
            {basename(filename)}
            {dirty ? " •" : ""}
          </button>
          <div className="top-actions">
            <span className="shortcut">
              {navigator.platform.includes("Mac") ? "⌘⇧K" : "Ctrl Shift K"}
            </span>
            <button
              onClick={() => void handleSave()}
              disabled={Boolean(viewingPeer)}
            >
              Save
            </button>
          </div>
        </header>
        <section className={viewingPeer ? "editor read-only" : "editor"}>
          {viewingPeer && (
            <div className="read-only-banner">
              Read-only · {basename(filename)}
            </div>
          )}
          <MDXEditor
            ref={editor}
            markdown={initialMarkdown.current}
            readOnly={Boolean(viewingPeer)}
            onChange={onChange}
            contentEditableClassName="prose"
            plugins={plugins}
          />
        </section>
      </main>

      {paletteOpen && (
        <div
          className="palette-backdrop"
          onMouseDown={() => setPaletteOpen(false)}
        >
          <div
            className="palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input
              autoFocus
              placeholder="Open a Markdown file…"
              value={paletteQuery}
              onChange={(event) => {
                setPaletteQuery(event.target.value);
                setPaletteIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPaletteIndex((index) =>
                    Math.min(index + 1, Math.max(0, filteredRecent.length - 1))
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPaletteIndex((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter") {
                  const candidate = paletteQuery.trim() ||
                    filteredRecent[paletteIndex];
                  if (candidate) void handleOpen(candidate);
                }
              }}
            />
            <div className="palette-list">
              {filteredRecent.map((candidate, index) => (
                <button
                  className={index === paletteIndex ? "selected" : ""}
                  key={candidate}
                  onClick={() => void handleOpen(candidate)}
                >
                  <strong>{basename(candidate)}</strong>
                  <small>{candidate}</small>
                </button>
              ))}
              {filteredRecent.length === 0 && (
                <p>Type a full path and press Enter.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
