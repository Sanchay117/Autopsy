import { Session, type AuditView } from "./session";

// The landing page quotes a real run of the engine, not copy. It runs offline
// on the mock rails once per server process, through the same steps as the demo.

export interface Preview {
  first: AuditView;
  final: AuditView;
}

let cached: Promise<Preview> | undefined;

export function preview() {
  cached ??= (async () => {
    const s = new Session({ offline: true });
    await s.seed();
    await s.audit();
    const first = s.view();
    await s.inject("deposit");
    await s.inject("return");
    await s.inject("email");
    for (const d of s.view().decisions.filter((x) => x.status === "awaiting_approval")) await s.approve(d.id, d.binding);
    return { first, final: s.view() };
  })();
  return cached;
}
