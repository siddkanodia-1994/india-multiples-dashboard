import { Suspense } from "react";
import { Dashboard } from "@/components/Dashboard";
import { DialogHost } from "@/components/dialogs";

export default function Home() {
  return (
    <DialogHost>
      <Suspense fallback={<div className="empty">Loading…</div>}>
        <Dashboard />
      </Suspense>
    </DialogHost>
  );
}
