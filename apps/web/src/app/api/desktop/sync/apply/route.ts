import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { auditLogs, cashierShifts, customers, orderCancellations, orderCheckouts, orderItemModifiers, orderItems, orderPayments, orderStatusHistory, orders, paymentMethods, printJobs, products, registerPrintPreferences, restaurantTables, shiftCashMovements, syncCommandInbox, syncConflicts, syncDevices, syncEntityMappings, syncGlobalEntities, syncOutbox, transactions } from "@/lib/db/schema";

export const runtime = "nodejs";
const customerSnapshot = z.object({ name: z.string(), email: z.string().email(), phone: z.string().nullable(), status: z.string().nullable() });
const productSnapshot = z.object({ name: z.string(), description: z.string().nullable(), price: z.number().int().nonnegative(), in_stock: z.number().int().nonnegative(), category: z.string().nullable(), imageKey: z.string().max(200).nullable() });
const shiftSnapshot = z.object({ registerGlobalId: z.string().uuid(), actorGlobalId: z.string().uuid(), openingFloat: z.number().int().nonnegative(), openedAt: z.string().datetime() });
const shiftCloseSnapshot = z.object({ closedByGlobalId: z.string().uuid(), expectedCash: z.number().int(), closingCash: z.number().int().nonnegative(), variance: z.number().int(), closedAt: z.string().datetime() });
const cashMovementSnapshot = z.object({ shiftGlobalId: z.string().uuid(), actorGlobalId: z.string().uuid(), type: z.enum(["cash_in", "cash_out"]), amount: z.number().int().positive(), reason: z.string().min(3).max(500), createdAt: z.string().datetime() });
const orderStatuses = ["pending", "confirmed", "preparing", "ready", "served", "collected", "delivered", "completed", "cancelled"] as const;
const orderSnapshot = z.object({ branchGlobalId: z.string().uuid(), customerGlobalId: z.string().uuid().nullable(), diningTableGlobalId: z.string().uuid().nullable(), actorGlobalId: z.string().uuid(), clientRequestId: z.string().nullable(), orderType: z.enum(["dine_in", "takeaway", "delivery"]), deliveryAddress: z.string().nullable(), status: z.enum(orderStatuses), paymentStatus: z.enum(["unpaid", "paid", "refunded"]), subtotalAmount: z.number().int(), discountType: z.string().nullable(), discountValue: z.number().int(), discountAmount: z.number().int(), discountReason: z.string().nullable(), totalAmount: z.number().int(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), items: z.array(z.object({ productGlobalId: z.string().uuid().nullable(), menuItemGlobalId: z.string().uuid(), variantGlobalId: z.string().uuid().nullable(), quantity: z.number().int().positive(), price: z.number().int().nonnegative(), notes: z.string().nullable(), modifiers: z.array(z.object({ modifierOptionGlobalId: z.string().uuid(), name_en: z.string(), name_ar: z.string(), price_delta: z.number().int() })) })), history: z.array(z.object({ fromStatus: z.enum(orderStatuses).nullable(), toStatus: z.enum(orderStatuses), actorGlobalId: z.string().uuid().nullable(), note: z.string().nullable(), createdAt: z.string().datetime() })) });
const printJobSnapshot = z.object({ orderGlobalId: z.string().uuid(), stationGlobalId: z.string().uuid().nullable(), shiftGlobalId: z.string().uuid().nullable(), requestedByGlobalId: z.string().uuid(), approvedByGlobalId: z.string().uuid().nullable(), documentType: z.enum(["receipt", "order_summary", "kot", "refund", "reversal"]), status: z.enum(["requested", "previewed", "acknowledged", "failed", "cancelled"]), isReprint: z.boolean(), idempotencyKey: z.string(), copyCount: z.number().int().min(1).max(5), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]), reprintReason: z.string().nullable(), errorMessage: z.string().nullable(), requestedAt: z.string().datetime(), previewedAt: z.string().datetime().nullable(), acknowledgedAt: z.string().datetime().nullable() });
const printPreferencesSnapshot = z.object({ registerGlobalId: z.string().uuid(), updatedByGlobalId: z.string().uuid(), paperWidth: z.union([z.literal(58), z.literal(80)]), language: z.enum(["ar", "en", "bilingual"]), receiptCopies: z.number().int().min(1).max(5), kotCopies: z.number().int().min(1).max(5), updatedAt: z.string().datetime() });
const checkoutSnapshot = z.object({ orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid(), actorGlobalId: z.string().uuid(), idempotencyKey: z.string(), subtotalAmount: z.number().int(), discountAmount: z.number().int(), payableAmount: z.number().int(), approvedByGlobalId: z.string().uuid().nullable(), createdAt: z.string().datetime(), payments: z.array(z.object({ paymentGlobalId: z.string().uuid(), transactionGlobalId: z.string().uuid(), methodCode: z.string(), amount: z.number().int(), tenderedAmount: z.number().int().nullable(), changeAmount: z.number().int(), createdAt: z.string().datetime() })) });
const cancellationSnapshot = z.object({ orderGlobalId: z.string().uuid(), shiftGlobalId: z.string().uuid().nullable(), actorGlobalId: z.string().uuid(), idempotencyKey: z.string(), reason: z.string(), wasPaid: z.boolean(), inventoryDisposition: z.enum(["returned_unused", "prepared_discarded"]).nullable(), createdAt: z.string().datetime(), refunds: z.array(z.object({ refundGlobalId: z.string().uuid(), originalPaymentGlobalId: z.string().uuid(), transactionGlobalId: z.string().uuid(), methodCode: z.string(), amount: z.number().int(), createdAt: z.string().datetime() })) });
const changeSchema = z.object({ cursor: z.number().int().positive(), domain: z.string(), entityType: z.string(), entityGlobalId: z.string().uuid(), action: z.string(), revision: z.number().int().positive(), snapshot: z.unknown().nullable() });

function authorized(request: NextRequest) {
  const expected = process.env.FORNO_DESKTOP_SETUP_TOKEN ?? "";
  const supplied = request.headers.get("x-forno-desktop-setup") ?? "";
  return process.env.FORNO_DESKTOP_MODE === "1" && expected.length > 0 && supplied.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Local synchronization is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } });
  const body = await request.json().catch(() => null) as { changes?: unknown; nextCursor?: unknown } | null;
  if (!body || !Array.isArray(body.changes) || body.changes.length > 200 || !Number.isSafeInteger(body.nextCursor) || Number(body.nextCursor) < 0) return NextResponse.json({ error: "Change page is invalid." }, { status: 400 });
  const changes = body.changes.map((item) => changeSchema.safeParse(item));
  if (changes.some((item) => !item.success)) return NextResponse.json({ error: "A typed change is invalid." }, { status: 400 });
  const deviceId = process.env.FORNO_DESKTOP_DEVICE_ID ?? "";
  try {
    await db.transaction(async (tx) => {
      const [device] = await tx.select().from(syncDevices).where(eq(syncDevices.id, deviceId)).for("update").limit(1);
      if (!device) throw new Error("Local device identity is missing.");
      if (Number(body.nextCursor) < device.last_pulled_cursor) throw new Error("Change cursor cannot move backwards.");
      let previousCursor = device.last_pulled_cursor;
      for (const parsed of changes) {
        if (!parsed.success) continue;
        const change = parsed.data;
        if (change.cursor <= previousCursor || change.cursor > Number(body.nextCursor)) throw new Error("Change page ordering is invalid.");
        previousCursor = change.cursor;
        const isCustomer = change.domain === "customers" && change.entityType === "customer";
        const isProduct = change.domain === "products" && change.entityType === "product";
        const isShift = change.domain === "shifts" && change.entityType === "cashier_shift";
        const isCashMovement = change.domain === "shifts" && change.entityType === "cash_movement";
        const isOrder = change.domain === "orders" && change.entityType === "order";
        const isPrintJob = change.domain === "printing" && change.entityType === "print_job";
        const isPrintPreferences = change.domain === "printing" && change.entityType === "register_print_preferences";
        const isCheckout = change.domain === "checkout" && change.entityType === "order_checkout";
        const isCancellation = change.domain === "checkout" && change.entityType === "order_cancellation";
        if (!isCustomer && !isProduct && !isShift && !isCashMovement && !isOrder && !isPrintJob && !isPrintPreferences && !isCheckout && !isCancellation) continue;
        const isDelete = change.action === "delete" && change.snapshot === null;
        if (!isDelete && !change.snapshot) continue;
        const isShiftClose = isShift && change.action === "close";
        const parsedSnapshot = isDelete ? null : isCustomer ? customerSnapshot.safeParse(change.snapshot) : isProduct ? productSnapshot.safeParse(change.snapshot) : isShiftClose ? shiftCloseSnapshot.safeParse(change.snapshot) : isShift ? shiftSnapshot.safeParse(change.snapshot) : isCashMovement ? cashMovementSnapshot.safeParse(change.snapshot) : isOrder ? orderSnapshot.safeParse(change.snapshot) : isPrintJob ? printJobSnapshot.safeParse(change.snapshot) : isPrintPreferences ? printPreferencesSnapshot.safeParse(change.snapshot) : isCheckout ? checkoutSnapshot.safeParse(change.snapshot) : cancellationSnapshot.safeParse(change.snapshot);
        if (parsedSnapshot && !parsedSnapshot.success) throw new Error("A typed domain snapshot is invalid.");
        const snapshot = parsedSnapshot?.success ? parsedSnapshot.data : null;
        const entityType = change.entityType;
        const mapping = await tx.query.syncEntityMappings.findFirst({ where: and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, entityType), eq(syncEntityMappings.global_id, change.entityGlobalId)) });
        if (mapping) {
          const queuedCommands = await tx.select().from(syncOutbox).where(and(eq(syncOutbox.device_id, device.id), eq(syncOutbox.state, "pending")));
          const globalKey = isShift ? "shiftGlobalId" : isCashMovement ? "cashMovementGlobalId" : isPrintJob ? "jobGlobalId" : isPrintPreferences ? "preferenceGlobalId" : isCheckout ? "checkoutGlobalId" : isCancellation ? "cancellationGlobalId" : `${entityType}GlobalId`;
          const queued = queuedCommands.find((item) => item.domain === change.domain && item.payload[globalKey] === change.entityGlobalId);
          if (queued) {
            const operationId = randomUUID();
            const idempotencyKey = randomUUID();
            const localPayload = queued.payload;
            const remotePayload = isDelete ? { [globalKey]: change.entityGlobalId, deleted: true } : { [globalKey]: change.entityGlobalId, values: snapshot };
            const payloadHash = createHash("sha256").update(JSON.stringify(remotePayload)).digest("hex");
            const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: operationId, branch_id: device.branch_id, actor_global_id: queued.actor_global_id, domain: change.domain, action: "pull_conflict", schema_version: 1, payload: remotePayload, payload_hash: payloadHash, idempotency_key: idempotencyKey, state: "needs_review" }).returning();
            await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: entityType, entity_global_id: change.entityGlobalId, local_payload: localPayload, server_snapshot: remotePayload, reason: `A local ${entityType} edit is pending while an authoritative server change arrived.` });
            const [actor] = await tx.select().from(syncGlobalEntities).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, "user"))).limit(1);
            if (actor) await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: `sync.${entityType}.needs_review`, entity_type: entityType, entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor }) });
            continue;
          }
          if (isCheckout || isCancellation) {
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            continue;
          }
          if (isPrintPreferences) {
            const preference = snapshot as z.infer<typeof printPreferencesSnapshot>;
            const [register] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register"), eq(syncEntityMappings.global_id, preference.registerGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, preference.updatedByGlobalId))).limit(1);
            if (!register || !actor) throw new Error("Pulled print preferences reference an unmapped register or actor.");
            const [updated] = await tx.update(registerPrintPreferences).set({ paper_width: preference.paperWidth, language: preference.language, receipt_copies: preference.receiptCopies, kot_copies: preference.kotCopies, updated_by: actor.local_id, updated_at: new Date(preference.updatedAt) }).where(eq(registerPrintPreferences.id, Number(mapping.local_id))).returning();
            if (!updated) throw new Error("Mapped print preferences are unavailable.");
            await tx.update(syncEntityMappings).set({ local_id: String(updated.id), server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            await tx.update(syncGlobalEntities).set({ local_id: String(updated.id), server_revision: change.revision, updated_at: new Date() }).where(and(eq(syncGlobalEntities.organization_id, device.organization_id), eq(syncGlobalEntities.entity_type, entityType), eq(syncGlobalEntities.global_id, change.entityGlobalId)));
            continue;
          }
          if (isOrder) {
            const remote = snapshot as z.infer<typeof orderSnapshot>;
            const [localBranch] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "branch"), eq(syncEntityMappings.local_id, String(device.branch_id)))).limit(1);
            if (!localBranch || localBranch.global_id !== remote.branchGlobalId) throw new Error("Pulled order belongs to a different branch.");
            const [localOrder] = await tx.select().from(orders).where(and(eq(orders.id, Number(mapping.local_id)), eq(orders.branch_id, device.branch_id))).for("update").limit(1);
            if (!localOrder) throw new Error("Mapped order is not present in the local branch.");
            if (localOrder.status !== remote.status) {
              const latestHistory = remote.history.at(-1);
              const [actor] = latestHistory?.actorGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, latestHistory.actorGlobalId))).limit(1) : [undefined];
              if (!latestHistory || !actor) throw new Error("Pulled order transition actor is unavailable.");
              await tx.insert(orderStatusHistory).values({ order_id: localOrder.id, from_status: localOrder.status, to_status: remote.status, changed_by: actor.local_id, note: latestHistory.note, created_at: new Date(latestHistory.createdAt) });
              if (["completed", "cancelled"].includes(remote.status) && localOrder.dining_table_id) await tx.update(restaurantTables).set({ status: "available" }).where(eq(restaurantTables.id, localOrder.dining_table_id));
            }
            await tx.update(orders).set({ status: remote.status, payment_status: remote.paymentStatus, subtotal_amount: remote.subtotalAmount, discount_type: remote.discountType, discount_value: remote.discountValue, discount_amount: remote.discountAmount, discount_reason: remote.discountReason, total_amount: remote.totalAmount, updated_at: new Date(remote.updatedAt) }).where(eq(orders.id, localOrder.id));
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            continue;
          }
          if (isPrintJob) {
            const job = snapshot as z.infer<typeof printJobSnapshot>;
            const [jobRow] = await tx.select().from(printJobs).where(eq(printJobs.id, Number(mapping.local_id))).for("update").limit(1);
            if (!jobRow) throw new Error("Mapped print job was not found.");
            await tx.update(printJobs).set({ status: job.status, error_message: job.errorMessage, previewed_at: job.previewedAt ? new Date(job.previewedAt) : null, acknowledged_at: job.acknowledgedAt ? new Date(job.acknowledgedAt) : null, updated_at: new Date() }).where(eq(printJobs.id, jobRow.id));
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            continue;
          }
          if (isOrder) {
            const order = snapshot as z.infer<typeof orderSnapshot>;
            const [localBranch] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "branch"), eq(syncEntityMappings.local_id, String(device.branch_id)))).limit(1);
            if (!localBranch || localBranch.global_id !== order.branchGlobalId) throw new Error("Pulled order belongs to a different branch.");
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, order.actorGlobalId))).limit(1);
            const [customer] = order.customerGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, order.customerGlobalId))).limit(1) : [undefined];
            const [table] = order.diningTableGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "restaurant_table"), eq(syncEntityMappings.global_id, order.diningTableGlobalId))).limit(1) : [undefined];
            const localItems = await Promise.all(order.items.map(async (item) => {
              const [menuItem] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "menu_item"), eq(syncEntityMappings.global_id, item.menuItemGlobalId))).limit(1);
              const [product] = item.productGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.global_id, item.productGlobalId))).limit(1) : [undefined];
              const [variant] = item.variantGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "menu_item_variant"), eq(syncEntityMappings.global_id, item.variantGlobalId))).limit(1) : [undefined];
              const modifiers = await Promise.all(item.modifiers.map(async (modifier) => {
                const [mapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "modifier_option"), eq(syncEntityMappings.global_id, modifier.modifierOptionGlobalId))).limit(1);
                if (!mapping) throw new Error("Pulled order references an unmapped modifier option.");
                return { ...modifier, modifierOptionId: Number(mapping.local_id) };
              }));
              if (!menuItem) throw new Error("Pulled order references an unmapped menu item.");
              return { ...item, menuItemId: Number(menuItem.local_id), productId: product ? Number(product.local_id) : null, variantId: variant ? Number(variant.local_id) : null, modifiers };
            }));
            const [created] = await tx.insert(orders).values({ branch_id: device.branch_id, customer_id: customer ? Number(customer.local_id) : null, dining_table_id: table ? Number(table.local_id) : null, client_request_id: order.clientRequestId, order_type: order.orderType, subtotal_amount: order.subtotalAmount, discount_type: order.discountType, discount_value: order.discountValue, discount_amount: order.discountAmount, discount_reason: order.discountReason, total_amount: order.totalAmount, payment_status: order.paymentStatus, delivery_address: order.deliveryAddress, user_uid: actor?.local_id ?? "", status: order.status, created_at: new Date(order.createdAt), updated_at: new Date(order.updatedAt) }).returning();
            if (!created || !actor) throw new Error("Pulled order actor mapping is unavailable.");
            for (const item of localItems) {
              const [createdItem] = await tx.insert(orderItems).values({ order_id: created.id, product_id: item.productId, menu_item_id: item.menuItemId, variant_id: item.variantId, quantity: item.quantity, price: item.price, notes: item.notes }).returning();
              if (item.modifiers.length) await tx.insert(orderItemModifiers).values(item.modifiers.map((modifier) => ({ order_item_id: createdItem!.id, modifier_option_id: modifier.modifierOptionId, name_en: modifier.name_en, name_ar: modifier.name_ar, price_delta: modifier.price_delta })));
            }
            for (const entry of order.history) {
              const [historyActor] = entry.actorGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, entry.actorGlobalId))).limit(1) : [undefined];
              if (!historyActor) throw new Error("Pulled order history actor is unmapped.");
              await tx.insert(orderStatusHistory).values({ order_id: created.id, from_status: entry.fromStatus, to_status: entry.toStatus, changed_by: historyActor.local_id, note: entry.note, created_at: new Date(entry.createdAt) });
            }
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            continue;
          }
          if (isShiftClose) {
            const close = snapshot as z.infer<typeof shiftCloseSnapshot>;
            const [closedBy] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, close.closedByGlobalId))).limit(1);
            if (!closedBy) throw new Error("Pulled shift close references an unmapped actor.");
            await tx.update(cashierShifts).set({ status: "closed", expected_cash: close.expectedCash, closing_cash: close.closingCash, variance: close.variance, closed_by: closedBy.local_id, closed_at: new Date(close.closedAt) }).where(eq(cashierShifts.id, Number(mapping.local_id)));
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: Number(mapping.local_id), actor_user_id: closedBy.local_id, action: "sync.cashier_shift.closed", entity_type: "cashier_shift", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor, expectedCash: close.expectedCash, closingCash: close.closingCash, variance: close.variance }) });
            continue;
          }
          if (isShift || isCashMovement) {
            await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
            continue;
          }
          if (isDelete && entityType === "customer") await tx.delete(customers).where(eq(customers.id, Number(mapping.local_id)));
          else if (isDelete && entityType === "product") await tx.delete(products).where(eq(products.id, Number(mapping.local_id)));
          else if (entityType === "customer") await tx.update(customers).set(snapshot as z.infer<typeof customerSnapshot>).where(eq(customers.id, Number(mapping.local_id)));
          else {
            const { imageKey, ...values } = snapshot as z.infer<typeof productSnapshot>;
            await tx.update(products).set({ ...values, image_key: imageKey }).where(eq(products.id, Number(mapping.local_id)));
          }
          await tx.update(syncEntityMappings).set({ server_revision: change.revision, local_revision: mapping.local_revision + 1, updated_at: new Date() }).where(eq(syncEntityMappings.id, mapping.id));
        } else {
          if (isDelete) continue;
          if (isCancellation) {
            const cancellation = snapshot as z.infer<typeof cancellationSnapshot>;
            const [orderIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, cancellation.orderGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, cancellation.actorGlobalId))).limit(1);
            const [shift] = cancellation.shiftGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, cancellation.shiftGlobalId))).limit(1) : [undefined];
            if (!orderIdentity || !actor || cancellation.shiftGlobalId && !shift) throw new Error("Pulled cancellation references an unmapped order, actor, or shift.");
            const [created] = await tx.insert(orderCancellations).values({ order_id: Number(orderIdentity.local_id), shift_id: shift ? Number(shift.local_id) : null, idempotency_key: cancellation.idempotencyKey, reason: cancellation.reason, was_paid: cancellation.wasPaid, cancelled_by: actor.local_id, approved_by: actor.local_id, inventory_disposition: cancellation.inventoryDisposition, inventory_resolved_by: cancellation.inventoryDisposition ? actor.local_id : null, created_at: new Date(cancellation.createdAt) }).returning();
            for (const refund of cancellation.refunds) {
              if (!shift) throw new Error("A financial reversal import requires a mapped shift.");
              const [originalPayment] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order_payment"), eq(syncEntityMappings.global_id, refund.originalPaymentGlobalId))).limit(1);
              const method = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, refund.methodCode), eq(paymentMethods.is_active, true)) });
              if (!originalPayment || !method) throw new Error("Pulled refund references an unmapped original payment or method.");
              const [createdRefund] = await tx.insert(orderPayments).values({ order_id: Number(orderIdentity.local_id), shift_id: Number(shift.local_id), payment_method_id: method.id, kind: "refund", amount: refund.amount, change_amount: 0, original_payment_id: Number(originalPayment.local_id), created_by: actor.local_id, created_at: new Date(refund.createdAt) }).returning();
              const [originalFinancial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, Number(originalPayment.local_id))).limit(1);
              const [createdTransaction] = await tx.insert(transactions).values({ order_id: Number(orderIdentity.local_id), shift_id: Number(shift.local_id), order_payment_id: createdRefund!.id, original_transaction_id: originalFinancial?.id ?? null, payment_method_id: method.id, amount: refund.amount, user_uid: actor.local_id, type: "expense", category: "refund", status: "completed", description: `Synchronized payment reversal for order #${Number(orderIdentity.local_id)}: ${cancellation.reason}`, created_at: new Date(refund.createdAt) }).returning();
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refund.refundGlobalId, local_id: String(createdRefund!.id), local_revision: 1, server_revision: change.revision });
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: refund.refundGlobalId, local_id: String(createdRefund!.id), server_revision: change.revision });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: refund.transactionGlobalId, local_id: String(createdTransaction!.id), local_revision: 1, server_revision: change.revision });
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: refund.transactionGlobalId, local_id: String(createdTransaction!.id), server_revision: change.revision });
            }
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_cancellation", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: shift ? Number(shift.local_id) : null, order_id: Number(orderIdentity.local_id), actor_user_id: actor.local_id, action: cancellation.wasPaid ? "sync.order.payment_reversal" : "sync.order.cancel", entity_type: "order_cancellation", entity_id: change.entityGlobalId, reason: cancellation.reason, details: JSON.stringify({ cursor: change.cursor, refundedRows: cancellation.refunds.length }) });
            continue;
          }
          if (isCheckout) {
            const checkout = snapshot as z.infer<typeof checkoutSnapshot>;
            const [orderIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, checkout.orderGlobalId))).limit(1);
            const [shiftIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, checkout.shiftGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, checkout.actorGlobalId))).limit(1);
            const [approver] = checkout.approvedByGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, checkout.approvedByGlobalId))).limit(1) : [undefined];
            if (!orderIdentity || !shiftIdentity || !actor) throw new Error("Pulled checkout references an unmapped order, shift, or actor.");
            const [created] = await tx.insert(orderCheckouts).values({ order_id: Number(orderIdentity.local_id), shift_id: Number(shiftIdentity.local_id), idempotency_key: checkout.idempotencyKey, subtotal_amount: checkout.subtotalAmount, discount_amount: checkout.discountAmount, payable_amount: checkout.payableAmount, created_by: actor.local_id, approved_by: approver?.local_id ?? null, created_at: new Date(checkout.createdAt) }).returning();
            await tx.update(orders).set({ payment_status: "paid", subtotal_amount: checkout.subtotalAmount, discount_amount: checkout.discountAmount, total_amount: checkout.payableAmount, discount_approved_by: approver?.local_id ?? null, paid_at: new Date(checkout.createdAt), updated_at: new Date(checkout.createdAt) }).where(eq(orders.id, Number(orderIdentity.local_id)));
            for (const payment of checkout.payments) {
              const method = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, payment.methodCode), eq(paymentMethods.is_active, true)) });
              if (!method) throw new Error("Pulled checkout payment method is unavailable locally.");
              const [paymentRow] = await tx.insert(orderPayments).values({ checkout_id: created!.id, order_id: Number(orderIdentity.local_id), shift_id: Number(shiftIdentity.local_id), payment_method_id: method.id, kind: "payment", amount: payment.amount, tendered_amount: payment.tenderedAmount, change_amount: payment.changeAmount, created_by: actor.local_id, created_at: new Date(payment.createdAt) }).returning();
              await tx.insert(transactions).values({ order_id: Number(orderIdentity.local_id), shift_id: Number(shiftIdentity.local_id), order_payment_id: paymentRow!.id, payment_method_id: method.id, amount: payment.amount, user_uid: actor.local_id, type: "income", category: "selling", status: "completed", description: `Payment for order #${Number(orderIdentity.local_id)}`, created_at: new Date(payment.createdAt) });
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_payment", global_id: payment.paymentGlobalId, local_id: String(paymentRow!.id), local_revision: 1, server_revision: change.revision });
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_payment", global_id: payment.paymentGlobalId, local_id: String(paymentRow!.id), server_revision: change.revision });
              const [financial] = await tx.select().from(transactions).where(eq(transactions.order_payment_id, paymentRow!.id)).limit(1);
              await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "transaction", global_id: payment.transactionGlobalId, local_id: String(financial!.id), local_revision: 1, server_revision: change.revision });
              await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "transaction", global_id: payment.transactionGlobalId, local_id: String(financial!.id), server_revision: change.revision });
            }
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order_checkout", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: Number(shiftIdentity.local_id), order_id: Number(orderIdentity.local_id), actor_user_id: actor.local_id, action: "sync.checkout.imported", entity_type: "order_checkout", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor, paymentCount: checkout.payments.length }) });
            continue;
          }
          if (isPrintPreferences) {
            const preference = snapshot as z.infer<typeof printPreferencesSnapshot>;
            const [register] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register"), eq(syncEntityMappings.global_id, preference.registerGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, preference.updatedByGlobalId))).limit(1);
            if (!register || !actor) throw new Error("Pulled print preferences reference an unmapped register or actor.");
            const [created] = await tx.insert(registerPrintPreferences).values({ register_id: Number(register.local_id), paper_width: preference.paperWidth, language: preference.language, receipt_copies: preference.receiptCopies, kot_copies: preference.kotCopies, updated_by: actor.local_id, updated_at: new Date(preference.updatedAt) }).onConflictDoUpdate({ target: registerPrintPreferences.register_id, set: { paper_width: preference.paperWidth, language: preference.language, receipt_copies: preference.receiptCopies, kot_copies: preference.kotCopies, updated_by: actor.local_id, updated_at: new Date(preference.updatedAt) } }).returning();
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "register_print_preferences", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            continue;
          }
          if (isPrintJob) {
            const job = snapshot as z.infer<typeof printJobSnapshot>;
            if (change.action !== "request") throw new Error("A print transition arrived before its original print request.");
            const [orderIdentity] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "order"), eq(syncEntityMappings.global_id, job.orderGlobalId))).limit(1);
            const [requestedBy] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, job.requestedByGlobalId))).limit(1);
            const [approvedBy] = job.approvedByGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, job.approvedByGlobalId))).limit(1) : [undefined];
            const [station] = job.stationGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "kitchen_station"), eq(syncEntityMappings.global_id, job.stationGlobalId))).limit(1) : [undefined];
            const [shift] = job.shiftGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, job.shiftGlobalId))).limit(1) : [undefined];
            if (!orderIdentity || !requestedBy || job.stationGlobalId && !station || job.shiftGlobalId && !shift) throw new Error("Pulled print job references an unmapped dependency.");
            const [created] = await tx.insert(printJobs).values({ order_id: Number(orderIdentity.local_id), station_id: station ? Number(station.local_id) : null, register_id: device.register_id, shift_id: shift ? Number(shift.local_id) : null, requested_by: requestedBy.local_id, approved_by: approvedBy?.local_id ?? null, document_type: job.documentType, status: job.status, is_reprint: job.isReprint, idempotency_key: job.idempotencyKey, copy_count: job.copyCount, paper_width: job.paperWidth, language: job.language, reprint_reason: job.reprintReason, error_message: job.errorMessage, requested_at: new Date(job.requestedAt), previewed_at: job.previewedAt ? new Date(job.previewedAt) : null, acknowledged_at: job.acknowledgedAt ? new Date(job.acknowledgedAt) : null }).returning();
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "print_job", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "print_job", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            continue;
          }
          if (isOrder) {
            const order = snapshot as z.infer<typeof orderSnapshot>;
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, order.actorGlobalId))).limit(1);
            if (!actor) throw new Error("Pulled order actor mapping is unavailable.");
            const [customer] = order.customerGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "customer"), eq(syncEntityMappings.global_id, order.customerGlobalId))).limit(1) : [undefined];
            const [table] = order.diningTableGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "restaurant_table"), eq(syncEntityMappings.global_id, order.diningTableGlobalId))).limit(1) : [undefined];
            const localItems = await Promise.all(order.items.map(async (item) => {
              const [menuItem] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "menu_item"), eq(syncEntityMappings.global_id, item.menuItemGlobalId))).limit(1);
              const [product] = item.productGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "product"), eq(syncEntityMappings.global_id, item.productGlobalId))).limit(1) : [undefined];
              const [variant] = item.variantGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "menu_item_variant"), eq(syncEntityMappings.global_id, item.variantGlobalId))).limit(1) : [undefined];
              const modifiers = await Promise.all(item.modifiers.map(async (modifier) => {
                const [mapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "modifier_option"), eq(syncEntityMappings.global_id, modifier.modifierOptionGlobalId))).limit(1);
                if (!mapping) throw new Error("Pulled order references an unmapped modifier option.");
                return { ...modifier, modifierOptionId: Number(mapping.local_id) };
              }));
              if (!menuItem) throw new Error("Pulled order references an unmapped menu item.");
              return { ...item, menuItemId: Number(menuItem.local_id), productId: product ? Number(product.local_id) : null, variantId: variant ? Number(variant.local_id) : null, modifiers };
            }));
            const [created] = await tx.insert(orders).values({ branch_id: device.branch_id, customer_id: customer ? Number(customer.local_id) : null, dining_table_id: table ? Number(table.local_id) : null, client_request_id: order.clientRequestId, order_type: order.orderType, subtotal_amount: order.subtotalAmount, discount_type: order.discountType, discount_value: order.discountValue, discount_amount: order.discountAmount, discount_reason: order.discountReason, total_amount: order.totalAmount, payment_status: order.paymentStatus, delivery_address: order.deliveryAddress, user_uid: actor.local_id, status: order.status, created_at: new Date(order.createdAt), updated_at: new Date(order.updatedAt) }).returning();
            if (!created) throw new Error("Pulled order was not created.");
            for (const item of localItems) {
              const [createdItem] = await tx.insert(orderItems).values({ order_id: created.id, product_id: item.productId, menu_item_id: item.menuItemId, variant_id: item.variantId, quantity: item.quantity, price: item.price, notes: item.notes }).returning();
              if (item.modifiers.length) await tx.insert(orderItemModifiers).values(item.modifiers.map((modifier) => ({ order_item_id: createdItem!.id, modifier_option_id: modifier.modifierOptionId, name_en: modifier.name_en, name_ar: modifier.name_ar, price_delta: modifier.price_delta })));
            }
            for (const entry of order.history) {
              const [historyActor] = entry.actorGlobalId ? await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, entry.actorGlobalId))).limit(1) : [undefined];
              if (!historyActor) throw new Error("Pulled order history actor is unmapped.");
              await tx.insert(orderStatusHistory).values({ order_id: created.id, from_status: entry.fromStatus, to_status: entry.toStatus, changed_by: historyActor.local_id, note: entry.note, created_at: new Date(entry.createdAt) });
            }
            if (table && order.orderType === "dine_in") await tx.update(restaurantTables).set({ status: "occupied" }).where(eq(restaurantTables.id, Number(table.local_id)));
            const localId = String(created.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "order", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "order", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.order.imported", entity_type: "order", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor }) });
            continue;
          }
          if (isShift) {
            const shift = snapshot as z.infer<typeof shiftSnapshot>;
            const [register] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "register"), eq(syncEntityMappings.global_id, shift.registerGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, shift.actorGlobalId))).limit(1);
            if (!register || !actor) throw new Error("Pulled shift references an unmapped register or actor.");
            const conflict = await tx.query.cashierShifts.findFirst({ where: and(eq(cashierShifts.branch_id, device.branch_id), eq(cashierShifts.status, "open"), or(eq(cashierShifts.register_id, Number(register.local_id)), eq(cashierShifts.cashier_user_id, actor.local_id))) });
            if (conflict) {
              const operationId = randomUUID();
              const idempotencyKey = randomUUID();
              const [inbox] = await tx.insert(syncCommandInbox).values({ organization_id: device.organization_id, device_id: device.id, operation_id: operationId, branch_id: device.branch_id, actor_global_id: shift.actorGlobalId, domain: change.domain, action: "pull_conflict", schema_version: 1, payload: { cashierShiftGlobalId: change.entityGlobalId }, payload_hash: createHash("sha256").update(change.entityGlobalId).digest("hex"), idempotency_key: idempotencyKey, state: "needs_review" }).returning();
              await tx.insert(syncConflicts).values({ inbox_id: inbox!.id, organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", entity_global_id: change.entityGlobalId, local_payload: { activeShiftId: conflict.id }, server_snapshot: shift, reason: "A conflicting local cashier shift is already open." });
              await tx.insert(auditLogs).values({ branch_id: device.branch_id, actor_user_id: actor.local_id, action: "sync.cashier_shift.needs_review", entity_type: "cashier_shift", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor, activeShiftId: conflict.id }) });
              continue;
            }
            const [created] = await tx.insert(cashierShifts).values({ branch_id: device.branch_id, register_id: Number(register.local_id), cashier_user_id: actor.local_id, opened_by: actor.local_id, opening_float: shift.openingFloat, status: "open", opened_at: new Date(shift.openedAt) }).returning();
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cashier_shift", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: created!.id, actor_user_id: actor.local_id, action: "sync.cashier_shift.imported", entity_type: "cashier_shift", entity_id: change.entityGlobalId, details: JSON.stringify({ cursor: change.cursor }) });
            continue;
          }
          if (isCashMovement) {
            const movement = snapshot as z.infer<typeof cashMovementSnapshot>;
            const [shiftMapping] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "cashier_shift"), eq(syncEntityMappings.global_id, movement.shiftGlobalId))).limit(1);
            const [actor] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"), eq(syncEntityMappings.global_id, movement.actorGlobalId))).limit(1);
            const cashMethod = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, "CASH"), eq(paymentMethods.is_active, true)) });
            if (!shiftMapping || !actor || !cashMethod) throw new Error("Pulled cash adjustment references an unmapped shift, actor, or CASH method.");
            const [created] = await tx.insert(shiftCashMovements).values({ shift_id: Number(shiftMapping.local_id), type: movement.type, amount: movement.amount, reason: movement.reason, created_by: actor.local_id, created_at: new Date(movement.createdAt) }).returning();
            await tx.insert(transactions).values({ shift_id: Number(shiftMapping.local_id), payment_method_id: cashMethod.id, amount: movement.amount, user_uid: actor.local_id, type: movement.type === "cash_in" ? "income" : "expense", category: movement.type, status: "completed", description: movement.reason });
            const localId = String(created!.id);
            await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
            await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: "cash_movement", global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
            await tx.insert(auditLogs).values({ branch_id: device.branch_id, shift_id: Number(shiftMapping.local_id), actor_user_id: actor.local_id, action: `sync.shift.${movement.type}`, entity_type: "cash_movement", entity_id: change.entityGlobalId, reason: movement.reason, details: JSON.stringify({ cursor: change.cursor, amount: movement.amount }) });
            continue;
          }
          const [owner] = await tx.select().from(syncEntityMappings).where(and(eq(syncEntityMappings.device_id, device.id), eq(syncEntityMappings.entity_type, "user"))).limit(1);
          if (!owner) throw new Error("No local user mapping is available to import customer ownership.");
          let localId: string;
          if (entityType === "customer") {
            const [customer] = await tx.insert(customers).values({ ...(snapshot as z.infer<typeof customerSnapshot>), user_uid: owner.local_id }).returning();
            localId = String(customer!.id);
          } else {
            const { imageKey, ...values } = snapshot as z.infer<typeof productSnapshot>;
            const [product] = await tx.insert(products).values({ ...values, image_key: imageKey, user_uid: owner.local_id }).returning();
            localId = String(product!.id);
          }
          await tx.insert(syncEntityMappings).values({ organization_id: device.organization_id, device_id: device.id, branch_id: device.branch_id, entity_type: entityType, global_id: change.entityGlobalId, local_id: localId, local_revision: 1, server_revision: change.revision });
          await tx.insert(syncGlobalEntities).values({ organization_id: device.organization_id, branch_id: device.branch_id, entity_type: entityType, global_id: change.entityGlobalId, local_id: localId, server_revision: change.revision });
        }
      }
      await tx.update(syncDevices).set({ last_pulled_cursor: Number(body.nextCursor), last_synchronized_at: new Date() }).where(eq(syncDevices.id, device.id));
    });
    return NextResponse.json({ applied: true, cursor: Number(body.nextCursor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Changes were not applied." }, { status: 409, headers: { "cache-control": "no-store" } });
  }
}
