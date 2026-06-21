/**
 * Relay protocol version resolution.
 *
 * Kept local (rather than imported from @getpaseo/protocol) on purpose, mirroring
 * packages/relay/src/cloudflare-adapter.ts, so this package is a self-contained
 * leaf whose only runtime dependency is `ws`. The wire contract is owned by
 * packages/protocol/src/daemon-endpoints.ts — keep these in sync if versions change.
 */

export type RelayProtocolVersion = "1" | "2";

export const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
export const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

/**
 * Resolves the relay protocol version from the `v` query parameter. Absent or
 * empty defaults to the legacy v1, matching old daemons/clients.
 */
export function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}
