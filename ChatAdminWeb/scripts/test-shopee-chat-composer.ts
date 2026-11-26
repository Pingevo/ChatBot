import assert from "node:assert/strict";
import { removeAttachmentById, sendAttachmentsSequentially } from "../src/components/chat/ShopeeChatComposer";

type Attachment = { id: string; name: string };

async function main() {
  const images: Attachment[] = [
    { id: "image-a", name: "a.jpg" },
    { id: "image-b", name: "b.jpg" },
    { id: "image-c", name: "c.jpg" },
  ];
  assert.deepEqual(removeAttachmentById(images, "image-b"), [images[0], images[2]], "removing one image must preserve its neighbors");

  const pending = [...images];
  const sent: string[] = [];
  await assert.rejects(
    sendAttachmentsSequentially(images, async (image) => {
      sent.push(image.id);
      if (image.id === "image-b") throw new Error("send failed");
    }, (image) => {
      const index = pending.findIndex((item) => item.id === image.id);
      if (index >= 0) pending.splice(index, 1);
    }),
    /send failed/,
  );
  assert.deepEqual(sent, ["image-a", "image-b"], "images must send sequentially and stop on failure");
  assert.deepEqual(pending, [images[1], images[2]], "failed and unsent images must remain selected");
}

void main().then(() => console.log("ShopeeChatComposer behavioral checks passed"));
