// Runs the whole demo and prints what a judge would see: on the offline mock by
// default, on the sandbox when .env.local sets AWX_MODE=sandbox.
import { resetSession } from "@/lib/engine/session";

const s = resetSession();
const show = (title: string) => {
  const v = s.view();
  console.log(`\n=== ${title} ===`);
  for (const p of v.pockets.latest) console.log(`  ${p.currency}: bank ${p.bank} books ${p.books} variance ${p.variance} residual ${p.residual}`);
  for (const d of v.decisions) console.log(`  [${d.status}] ${d.id} r${d.revision} conf ${d.confidence.toFixed(2)} ${d.chosen.kind}/${d.chosen.rail}: ${d.chosen.label}${d.approvalReason ? ` | ${d.approvalReason}` : ""}${d.result ? ` | ${d.result}` : ""}`);
};

await s.seed();
await s.audit();
console.log("\n--- opening pockets");
for (const p of s.view().pockets.opening) console.log(`  ${p.currency}: bank ${p.bank} books ${p.books} variance ${p.variance} explained ${p.explained} residual ${p.residual}`);
show("after audit 1");
await s.inject("deposit");
show("after E1 deposit");
await s.inject("return");
show("after E2 return");
await s.inject("email");
show("after E3 email");
for (const d of s.view().diffs) {
  console.log(`\nDIFF ${d.evidenceLabel}`);
  for (const c of d.changes) console.log(`  ${c.breakId}: ${c.before.action} (${c.before.approval ? "approval" : "auto"}) -> ${c.after.action} (${c.after.approval ? "approval" : "auto"})`);
  console.log(`  rechecked ${d.rechecked.join(", ") || "-"}; untouched ${d.untouched.length}`);
}
const pending = s.view().decisions.filter((d) => d.status === "awaiting_approval");
for (const d of pending) {
  const r = await s.approve(d.id, d.binding);
  console.log(`approve ${d.id}:`, r);
}
show("after approvals");
console.log("\nrules:", s.rules.map((r) => r.id).join(", "));
console.log("drafts:", s.drafts.map((d) => d.subject).join(" | "));
console.log("metal:", s.metalPayouts.map((m) => `${m.outcome} ${m.amount} ${m.paymentId}`).join(" | "));
console.log("\nTRACE");
for (const t of s.trace) console.log(`  ${t.stage.padEnd(8)} ${t.text}`);
