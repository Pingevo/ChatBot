// /chats is now unified with /tickets — redirect there.
import { redirect } from "next/navigation";

export default function ChatsPage() {
  redirect("/tickets");
}
