import type { Metadata } from "next";
import { Dashboard } from "./Dashboard";
import "./audit.css";

export const metadata: Metadata = {
  title: "Autopsy: live audit",
  description: "Lay the books against Airwallex, see each break's proven cause, and approve fixes on exact terms.",
};

export default function AuditPage() {
  return <Dashboard />;
}
