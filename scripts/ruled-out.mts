// Prints, for every break the demo produces, the theories the engine ruled out and why.
import { Session } from "@/lib/engine/session";

const s = new Session({ offline: true });
await s.seed();
await s.audit();
for (const k of ["deposit", "return", "email"] as const) await s.inject(k);
for (const d of s.view().diagnoses) {
  console.log(`\n${d.breakId}: ${d.causeLabel}`);
  for (const r of d.ruledOut) console.log(`  not "${r.theory}": ${r.why}`);
}
