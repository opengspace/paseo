/**
 * Multi-tag WebSocket index.
 *
 * This replaces the Cloudflare Durable Object hibernation API:
 *   state.acceptWebSocket(ws, tags)   -> index.add(ws, tags)
 *   state.getWebSockets(tag)          -> index.get(tag)
 *
 * One socket can carry several tags (e.g. a v2 client socket is tagged both
 * "client" and "client:<id>"); querying by any tag returns that socket. Removing
 * a socket drops it from every tag it belongs to.
 */

import type { WebSocket } from "ws";

export class TaggedSocketIndex {
  private readonly byTag = new Map<string, Set<WebSocket>>();
  private readonly tagsBySocket = new Map<WebSocket, string[]>();

  add(ws: WebSocket, tags: string[]): void {
    this.tagsBySocket.set(ws, tags);
    for (const tag of tags) {
      let bucket = this.byTag.get(tag);
      if (!bucket) {
        bucket = new Set();
        this.byTag.set(tag, bucket);
      }
      bucket.add(ws);
    }
  }

  get(tag: string): WebSocket[] {
    const bucket = this.byTag.get(tag);
    return bucket ? Array.from(bucket) : [];
  }

  has(tag: string): boolean {
    const bucket = this.byTag.get(tag);
    return bucket !== undefined && bucket.size > 0;
  }

  remove(ws: WebSocket): void {
    const tags = this.tagsBySocket.get(ws);
    if (!tags) return;
    this.tagsBySocket.delete(ws);
    for (const tag of tags) {
      const bucket = this.byTag.get(tag);
      if (!bucket) continue;
      bucket.delete(ws);
      if (bucket.size === 0) {
        this.byTag.delete(tag);
      }
    }
  }

  /** Total number of distinct sockets tracked. */
  get size(): number {
    return this.tagsBySocket.size;
  }
}
