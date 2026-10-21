import type { Metadata } from "next";
import { SettingsView } from "../_components/SettingsView";

export const metadata: Metadata = { title: "Settings · book-to-audio" };

export default function SettingsPage() {
  return <SettingsView />;
}
