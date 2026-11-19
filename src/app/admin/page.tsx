import { Admin } from "@/components/Admin";
import { DialogHost } from "@/components/dialogs";

export const metadata = { title: "Admin · India Multiples" };

export default function AdminPage() {
  return (
    <DialogHost>
      <Admin />
    </DialogHost>
  );
}
