// Ticket service — real schema mirrors indexes already provisioned on
// `tickets`: ticket_id_1, status_1, channel_1, assigned_to_1.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "urgent";

export interface TicketDoc extends Document {
  ticket_id: string;
  conversation_id: string;
  channel: Platform; // matches existing `channel_1` index name
  shop_id?: string;
  shop_name: string;
  customer_id?: string;
  customer_name: string;
  topic: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to?: string; // admin_id — matches `assigned_to_1` index
  summary: string;
  created_at: Date;
  updated_at: Date;
}

function genTicketId(seq: number): string {
  return `TK-${String(seq).padStart(4, "0")}`;
}

export async function createTicket(opts: {
  conversationId: string;
  channel: Platform;
  shopId?: string;
  shopName: string;
  customerId?: string;
  customerName: string;
  topic: string;
  priority?: TicketPriority;
  summary: string;
  createdBy?: string;
}): Promise<TicketDoc> {
  const coll = await getCollection<TicketDoc>(COLLECTIONS.tickets);
  const count = await coll.countDocuments({});
  const now = new Date();
  const doc: TicketDoc = {
    ticket_id: genTicketId(count + 1),
    conversation_id: opts.conversationId,
    channel: opts.channel,
    shop_id: opts.shopId,
    shop_name: opts.shopName,
    customer_id: opts.customerId,
    customer_name: opts.customerName,
    topic: opts.topic,
    status: "open",
    priority: opts.priority || "medium",
    summary: opts.summary,
    created_at: now,
    updated_at: now,
  };
  await coll.insertOne(doc);
  return doc;
}

export async function getTicket(ticketId: string): Promise<TicketDoc | null> {
  const coll = await getCollection<TicketDoc>(COLLECTIONS.tickets);
  return coll.findOne({ ticket_id: ticketId });
}

export async function listTickets(opts: {
  status?: TicketStatus;
  channel?: Platform;
  assignedTo?: string;
  limit?: number;
} = {}): Promise<TicketDoc[]> {
  const coll = await getCollection<TicketDoc>(COLLECTIONS.tickets);
  const filter: Record<string, unknown> = {};
  if (opts.status) filter.status = opts.status;
  if (opts.channel) filter.channel = opts.channel;
  if (opts.assignedTo) filter.assigned_to = opts.assignedTo;
  return coll
    .find(filter)
    .sort({ updated_at: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

export async function updateTicket(
  ticketId: string,
  fields: Partial<
    Pick<TicketDoc, "status" | "priority" | "assigned_to" | "summary" | "topic">
  >
): Promise<boolean> {
  const coll = await getCollection<TicketDoc>(COLLECTIONS.tickets);
  const result = await coll.updateOne(
    { ticket_id: ticketId },
    { $set: { ...fields, updated_at: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function deleteTicket(ticketId: string): Promise<boolean> {
  const coll = await getCollection<TicketDoc>(COLLECTIONS.tickets);
  const result = await coll.deleteOne({ ticket_id: ticketId });
  return result.deletedCount > 0;
}

export const ticketService = {
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
};
