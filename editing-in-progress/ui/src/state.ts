export type ConnectionStatus = "online" | "connecting" | "disconnected";

export interface PeerPresence {
  id: string;
  name: string;
  filename: string;
  online: boolean;
  lastSeen: number;
  selectable: boolean;
}

export function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const value = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
  return value || "Untitled";
}

export function nextRecent(
  current: readonly string[],
  path: string,
  limit: number,
): string[] {
  if (limit <= 0) return [];
  return [path, ...current.filter((candidate) => candidate !== path)].slice(
    0,
    limit,
  );
}
