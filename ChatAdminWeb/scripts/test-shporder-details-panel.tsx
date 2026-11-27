import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";

type OrderDetailsPanelProps = Parameters<typeof import("../src/components/chat/InfoTab").OrderDetailsPanel>[0];

register(new URL("./test-shporder-details-panel-hooks.mjs", import.meta.url));

const failures: string[] = [];
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function test(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
  }
}

async function main() {
  const mocks = await import("./test-shporder-details-panel-mocks.mjs");
  const route = await import("../src/app/api/admin/conversations/[conversationId]/orders/route");
  const { OrderDetailsPanel } = await import("../src/components/chat/InfoTab");

  mocks.reset([{
    order_sn: "26112592FHWBD0",
    buyer_user_id: 12204060,
    checkout_shipping_carrier: "Express Delivery - ส่งด่วน",
    tracking_no: "TH262256426917E",
    tracking_info: [
      { update_time: 1795072691, description: "พัสดุถูกจัดส่งสำเร็จแล้ว", logistics_status: "DELIVERED" },
      { update_time: 1795061646, description: "พัสดุอยู่ระหว่างการนำส่ง", logistics_status: "PICKED_UP" },
    ],
    order_status: "SHIPPED",
    create_time: 1795564800,
    item_list: [{
      item_name: "สินค้า A",
      model_name: "รุ่นดำ",
      model_quantity_purchased: 2,
      model_discounted_price: 890,
      image_info: { image_url: "https://img.test/item-a.jpg" },
    }],
    package_list: [
      { logistics_status: "PICKED_UP", tracking_no: "SPX000000001" },
      { logistics_status: "DELIVERING", waybill_id: "FLASH0000002" },
    ],
  }]);

  let order: OrderDetailsPanelProps["order"] | undefined;
  await test("order API returns checkout carrier and each package's tracking status", async () => {
    const response = await route.GET(new NextRequest("http://test.local/api/orders"), {
      params: Promise.resolve({ conversationId: "conv-test" }),
    }) as unknown as { status: number; body: { orders: OrderDetailsPanelProps["order"][] } };
    assert(response.status === 200, "order API should succeed");
    order = response.body.orders[0];
    assert(order, "order should be returned");
    assert(order.checkout_shipping_carrier === "Express Delivery - ส่งด่วน", "checkout carrier should be returned");
    assert(mocks.state.orderFindCalls[0]?.options.projection.tracking_no === 1, "Mongo projection should include document tracking number");
    assert(mocks.state.orderFindCalls[0]?.options.projection.tracking_info === 1, "Mongo projection should include tracking info");
    assert(order.tracking_no === "TH262256426917E", "document tracking number should be returned");
    assert((order.tracking_numbers as string[])?.includes("TH262256426917E"), "document tracking number should be included in the full tracking list");
    assert(JSON.stringify(order.tracking_info) === JSON.stringify([
      { update_time: 1795072691, description: "พัสดุถูกจัดส่งสำเร็จแล้ว", logistics_status: "DELIVERED" },
      { update_time: 1795061646, description: "พัสดุอยู่ระหว่างการนำส่ง", logistics_status: "PICKED_UP" },
    ]), "tracking info should be passed through unchanged");
    assert(mocks.state.orderFindCalls[0]?.options.projection.checkout_shipping_carrier === 1, "Mongo projection should include checkout carrier");
    const items = order.items;
    assert(items[0]?.image_url === "https://img.test/item-a.jpg", "order API should pass the product image to the preview");
    assert(items[0]?.model_name === "รุ่นดำ" && items[0]?.quantity === 2 && items[0]?.price === 890, "order API should pass product option, quantity, and price");
    assert(Array.isArray(order.packages), "package details should be returned");
    const packages = order.packages;
    assert(packages[0]?.logistics_status === "PICKED_UP", "first package status should stay attached to its tracking number");
    assert((packages[0]?.tracking_numbers as string[])?.includes("SPX000000001"), "first package tracking should be returned");
    assert(packages[1]?.logistics_status === "DELIVERING", "second package status should stay attached to its tracking number");
    assert((packages[1]?.tracking_numbers as string[])?.includes("FLASH0000002"), "second package tracking should be returned");
  });

  await test("order detail panel renders ShpOrders shipping and tracking data without an iframe", async () => {
    assert(typeof OrderDetailsPanel === "function", "order detail panel component should be available");
    assert(order, "render input should come from the order API");
    const markup = renderToStaticMarkup(createElement(OrderDetailsPanel, { order, onClose: () => {} }));
    assert(markup.includes("Express Delivery - ส่งด่วน"), "panel should show checkout shipping method");
    assert(markup.includes("TH262256426917E"), "panel should show document-level tracking number");
    const productsIndex = markup.indexOf("สินค้าในออเดอร์");
    const trackingIndex = markup.indexOf("สถานะพัสดุและ Tracking");
    assert(productsIndex >= 0 && productsIndex < trackingIndex, "order products should appear before tracking info");
    assert(markup.includes('aria-label="สินค้า A"') && markup.includes('alt="สินค้า A"'), "product card should be clearly labeled and show its image");
    assert(markup.includes("https://img.test/item-a.jpg") && markup.includes("รุ่นดำ") && markup.includes("×2") && markup.includes("฿890"), "product card should show image, model, quantity, and price");
    assert(markup.includes('aria-label="ประวัติการติดตาม"'), "panel should present tracking info as an accessible timeline");
    assert(markup.includes("อัปเดตเมื่อ"), "timeline should use a readable Thai time label");
    assert(markup.includes("DELIVERED") && markup.includes("พัสดุถูกจัดส่งสำเร็จแล้ว"), "timeline should show the first tracking event");
    assert(markup.includes("PICKED_UP") && markup.includes("พัสดุอยู่ระหว่างการนำส่ง"), "timeline should show the next tracking event");
    assert(markup.includes("19 พ.ย. 2569 14:18") && markup.includes("19 พ.ย. 2569 11:14"), "timeline should format Unix timestamps in Thai time");
    assert(markup.indexOf("19 พ.ย. 2569 14:18") < markup.indexOf("19 พ.ย. 2569 11:14"), "timeline should preserve the newest-first source order");
    assert(!markup.includes("1795072691") && !markup.includes("UPDATE TIME"), "timeline should not expose raw timestamps or field names");
    assert((markup.match(/<li\b/g) || []).length === 2, "timeline should render each shipment event as its own item");
    assert(markup.includes("bottom-[-12px] left-[6px] top-3 w-px bg-border"), "timeline should connect event dots with a straight vertical line");
    assert(!markup.includes('[{"update_time":1795072691'), "panel should not render tracking data as raw JSON");
    assert(!markup.includes("ข้อมูลติดตามพัสดุ"), "missing package tracking info should not render as null");
    assert(markup.includes("PICKED_UP") && markup.includes("SPX000000001"), "panel should show first package status and tracking");
    assert(markup.includes("DELIVERING") && markup.includes("FLASH0000002"), "panel should show second package status and tracking");
    assert(!markup.includes("<iframe"), "panel should render ShpOrders data directly");
  });

  if (failures.length) throw new Error(`${passed} passed, ${failures.length} failed\n${failures.join("\n")}`);
  console.log(`PASS ${passed} ShpOrders panel behavior cases`);
}

void main();
