import type { AuthedUser } from "./auth.js";

// The self-hosted server always reports a permanent "active" subscription.
// The client's ONLY gate check is `new Date(subscription.expiresAt) > new Date()`
// (see src/renderer/src/hooks/use-user-details.ts). Return a far-future expiresAt
// and every paywalled feature unlocks — animated avatars, banners, cloud saves,
// achievement points, emulation cloud saves, custom artwork — with no client
// changes required. `status: "active"` is only inspected for cosmetic copy in
// the account settings page.
export function subscriptionPayload(_user: AuthedUser) {
  return {
    id: "selfhost-permanent",
    status: "active" as const,
    plan: {
      id: "self-hosted",
      name: "Self-Hosted",
    },
    expiresAt: "9999-12-31T23:59:59.000Z",
    paymentMethod: "pix" as const,
  };
}

// Quirks are per-user server-side flags. Setting backupsPerGameLimit to 0
// disables the "max artifacts per game" check in the client
// (cloud-sync-panel.tsx treats > 0 as the limit).
export function userQuirks() {
  return { backupsPerGameLimit: 0 };
}
