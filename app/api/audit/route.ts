import { NextResponse } from "next/server";
import { resetSession, session, type InjectKind } from "@/lib/engine/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // ?since=N is the dashboard polling a running step: only the new trace lines and what is happening now.
  const since = new URL(req.url).searchParams.get("since");
  if (since !== null) {
    const s = session();
    return NextResponse.json({ trace: s.trace.slice(Number(since) || 0), activity: s.activity });
  }
  return NextResponse.json(session().view());
}

type Body =
  | { action: "seed" | "audit" | "reset" | "demo" }
  | { action: "inject"; kind: InjectKind }
  | { action: "approve"; decisionId: string; binding: string }
  | { action: "resend"; invoice: string };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  try {
    let s = session();
    let result: unknown = { ok: true };
    switch (body.action) {
      case "reset":
        s = resetSession();
        break;
      case "seed":
        await s.seed();
        break;
      case "audit":
        await s.audit();
        break;
      case "demo":
        // Seed and run the first audit in one call, for the landing page.
        await s.seed();
        if (s.audits === 0) await s.audit();
        break;
      case "inject":
        await s.inject(body.kind);
        break;
      case "approve":
        result = await s.approve(body.decisionId, body.binding);
        break;
      case "resend":
        result = await s.tryResend(body.invoice);
        break;
    }
    return NextResponse.json({ result, view: s.view() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message, view: session().view() }, { status: 400 });
  }
}
