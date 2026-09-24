import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLogs,
  branches,
  cashierRegisters,
  cashierShifts,
  customers,
  menuItems,
  offlinePriceSnapshots,
  offlineSyncRecords,
  orderCheckouts,
  orderItemModifiers,
  orderItems,
  orderPayments,
  orders,
  orderStatusHistory,
  paymentMethods,
  printJobs,
  registerPrintPreferences,
  restaurantTables,
  staffAssignments,
  transactions,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/permissions";
import { InventoryConflict, issueOrderInventory } from "@/lib/inventory/service";
import {
  conflictCategory,
  expectedOfflineReceiptNumber,
  OfflineConflict,
  snapshotRevision,
  stableDeliveryEmail,
  type OfflineConflictCode,
  type OfflinePricingPayload,
  type OfflineSyncInput,
} from "./contracts";

export async function findExistingOfflineResult(operationId: string, userId: string) {
  const record = await db.query.offlineSyncRecords.findFirst({
    where: eq(offlineSyncRecords.client_operation_id, operationId),
  });
  if (!record) return null;
  if (record.actor_user_id !== userId) {
    throw new TRPCError({ code: "CONFLICT", message: "Offline operation ID belongs to another user" });
  }
  if (record.status === "accepted") {
    const receipt = record.order_id ? await db.query.printJobs.findFirst({
      where: and(eq(printJobs.order_id, record.order_id), eq(printJobs.document_type, "receipt"), eq(printJobs.is_reprint, false)),
    }) : null;
    return {
      status: "accepted" as const,
      duplicate: true,
      operationId,
      orderId: record.order_id!,
      checkoutId: record.checkout_id,
      receiptJobId: receipt?.id ?? null,
      conflict: null,
    };
  }
  // A manager-approved record is deliberately retried through the full
  // authoritative validation and transaction path. The local client keeps the
  // same operation ID, so an interruption remains idempotent.
  if (record.status === "resolved") return null;
  return {
    status: "needs_review" as const,
    duplicate: true,
    operationId,
    orderId: record.order_id,
    checkoutId: record.checkout_id,
    receiptJobId: null,
    conflict: {
      code: record.conflict_code as OfflineConflictCode,
      category: conflictCategory(record.conflict_code as OfflineConflictCode),
      message: record.conflict_details ?? "Offline operation requires review",
      recordId: record.id,
    },
  };
}

export async function recordOfflineConflict(input: OfflineSyncInput, userId: string, conflict: OfflineConflict) {
  const branch = await db.query.branches.findFirst({ where: eq(branches.id, input.branchId) });
  if (!branch) return null;
  const register = await db.query.cashierRegisters.findFirst({ where: eq(cashierRegisters.id, input.registerId) });
  const shift = await db.query.cashierShifts.findFirst({ where: eq(cashierShifts.id, input.shiftId) });
  return db.transaction(async (tx) => {
    const [record] = await tx.insert(offlineSyncRecords).values({
      branch_id: branch.id,
      register_id: register?.branch_id === branch.id ? register.id : null,
      shift_id: shift?.branch_id === branch.id ? shift.id : null,
      actor_user_id: userId,
      client_operation_id: input.clientOperationId,
      order_client_request_id: input.order.clientRequestId,
      checkout_idempotency_key: input.cash?.checkoutIdempotencyKey ?? null,
      price_snapshot_reference: input.priceSnapshotReference,
      offline_receipt_number: input.offlineReceipt?.number ?? null,
      printed_subtotal_amount: input.offlineReceipt?.subtotal ?? null,
      printed_total_amount: input.offlineReceipt?.total ?? null,
      printed_tendered_amount: input.offlineReceipt?.cashReceived ?? null,
      printed_change_amount: input.offlineReceipt?.change ?? null,
      status: "needs_review",
      conflict_code: conflict.code,
      conflict_details: conflict.message,
    }).onConflictDoUpdate({
      target: offlineSyncRecords.client_operation_id,
      set: { status: "needs_review", conflict_code: conflict.code, conflict_details: conflict.message, updated_at: new Date() },
    }).returning();
    await tx.insert(auditLogs).values({
      branch_id: branch.id,
      shift_id: shift?.branch_id === branch.id ? shift.id : null,
      actor_user_id: userId,
      action: "offline.sync.needs_review",
      entity_type: "offline_sync_record",
      entity_id: String(record.id),
      reason: conflict.message,
      details: JSON.stringify({ code: conflict.code, financial: conflict.financial, operationId: input.clientOperationId }),
    });
    return record;
  });
}

export async function synchronizeOfflineOperation(input: OfflineSyncInput, userId: string, review: { approved: boolean; reason: string | null; approverUserId: string | null }) {
  const assignment = await db.query.staffAssignments.findFirst({ where: and(
    eq(staffAssignments.user_id, userId),
    eq(staffAssignments.branch_id, input.branchId),
    eq(staffAssignments.is_active, true),
  ) });
  if (!assignment) throw new OfflineConflict("user_branch_mismatch", "The signed-in user no longer belongs to this branch", input.kind === "cash_sale");
  if (!hasPermission(assignment.role, "order:create") || (input.kind === "cash_sale" && !hasPermission(assignment.role, "checkout:create"))) {
    throw new OfflineConflict("permission_changed", "POS or checkout permission changed while this operation was offline", input.kind === "cash_sale");
  }
  const branch = await db.query.branches.findFirst({ where: and(eq(branches.id, input.branchId), eq(branches.is_active, true)) });
  if (!branch) throw new OfflineConflict("user_branch_mismatch", "The selected branch is unavailable", input.kind === "cash_sale");

  let trustedPricing: OfflinePricingPayload | null = null;
  if (input.cash) {
    const priceSnapshot = await db.query.offlinePriceSnapshots.findFirst({ where: eq(offlinePriceSnapshots.reference, input.priceSnapshotReference) });
    if (!priceSnapshot || priceSnapshot.actor_user_id !== userId || priceSnapshot.branch_id !== input.branchId || priceSnapshot.register_id !== input.registerId || priceSnapshot.shift_id !== input.shiftId || priceSnapshot.revision !== input.priceSnapshotRevision) {
      throw new OfflineConflict("price_snapshot_invalid", "The server-issued offline price snapshot is missing, invalid, or belongs to another scope", true);
    }
    if (priceSnapshot.expires_at.getTime() <= Date.now()) {
      throw new OfflineConflict("price_snapshot_expired", "The server-issued offline price snapshot expired before synchronization", true);
    }
    try {
      trustedPricing = JSON.parse(priceSnapshot.pricing_payload) as OfflinePricingPayload;
    } catch {
      throw new OfflineConflict("price_snapshot_invalid", "The stored offline price snapshot cannot be verified", true);
    }
    if (snapshotRevision(trustedPricing) !== priceSnapshot.revision) {
      throw new OfflineConflict("price_snapshot_invalid", "The stored offline price snapshot failed its integrity check", true);
    }
    const receiptOwner = input.offlineReceipt ? await db.query.offlineSyncRecords.findFirst({ where: eq(offlineSyncRecords.offline_receipt_number, input.offlineReceipt.number) }) : null;
    if (receiptOwner && receiptOwner.client_operation_id !== input.clientOperationId) {
      throw new OfflineConflict("duplicate_already_accepted", "The offline receipt number is already associated with another operation", true);
    }
  }

  return db.transaction(async (tx) => {
    const shift = await tx.query.cashierShifts.findFirst({ where: eq(cashierShifts.id, input.shiftId) });
    if (!shift || shift.status !== "open" || shift.branch_id !== input.branchId || shift.cashier_user_id !== userId || shift.register_id !== input.registerId) {
      throw new OfflineConflict("shift_closed", "The cached cashier shift was closed or changed", input.kind === "cash_sale");
    }
    const register = await tx.query.cashierRegisters.findFirst({ where: eq(cashierRegisters.id, input.registerId) });
    if (!register || !register.is_active || register.branch_id !== input.branchId) {
      throw new OfflineConflict("register_unavailable", "The cached register is no longer available", input.kind === "cash_sale");
    }
    if (input.cash && input.offlineReceipt) {
      const expectedNumber = expectedOfflineReceiptNumber({ branchCode: branch.code, registerCode: register.code, branchId: input.branchId, registerId: input.registerId, deviceInstanceId: input.offlineReceipt.deviceInstanceId, checkoutIdempotencyKey: input.cash.checkoutIdempotencyKey, checkoutAt: input.offlineReceipt.checkoutAt });
      const valuesMatch = input.offlineReceipt.number === expectedNumber
        && input.offlineReceipt.subtotal === input.order.expectedTotal
        && input.offlineReceipt.total === input.order.expectedTotal
        && input.offlineReceipt.cashReceived === input.cash.tenderedAmount
        && input.offlineReceipt.change === input.cash.tenderedAmount - input.offlineReceipt.total;
      if (!valuesMatch) throw new OfflineConflict("receipt_payload_tampered", "The immutable offline cash receipt identity or financial values were modified", true);
    }
    if (input.order.diningTableId) {
      const table = await tx.query.restaurantTables.findFirst({
        where: eq(restaurantTables.id, input.order.diningTableId),
        with: { diningArea: true },
      });
      if (!table || !table.is_active || table.status !== "available" || table.diningArea.branch_id !== input.branchId) {
        throw new OfflineConflict("table_occupied", "The selected table is occupied or unavailable", input.kind === "cash_sale");
      }
    }

    const prepared: Array<{
      requested: OfflineSyncInput["order"]["items"][number];
      menuItemId: number;
      productId: number | null;
      variantId: number | null;
      basePrice: number;
      stationId: number;
      modifiers: Array<{ id: number; name_en: string; name_ar: string; price_delta: number }>;
    }> = [];
    for (const requested of input.order.items) {
      const item = await tx.query.menuItems.findFirst({
        where: eq(menuItems.id, requested.menuItemId),
        with: {
          category: true,
          kitchenStation: true,
          variants: true,
          modifierGroups: { with: { modifierGroup: { with: { options: true } } } },
        },
      });
      if (!item || item.category.branch_id !== input.branchId || !item.is_available || !item.category.is_active || !item.kitchenStation.is_active) {
        throw new OfflineConflict("menu_item_unavailable", `Menu item ${requested.menuItemId} is unavailable`, input.kind === "cash_sale");
      }
      const trustedItem = trustedPricing?.items.find((entry) => entry.id === item.id) ?? null;
      if (input.cash && !trustedItem) throw new OfflineConflict("price_snapshot_invalid", `Menu item ${item.code} is absent from the trusted price snapshot`, true);
      const variants = item.variants.filter((variant) => variant.is_available);
      const variant = requested.variantId ? variants.find((entry) => entry.id === requested.variantId) ?? null : variants.length === 1 ? variants[0] : null;
      if ((requested.variantId && !variant) || (!requested.variantId && variants.length > 1)) {
        throw new OfflineConflict("variant_unavailable", `A selected variant for ${item.code} is unavailable`, input.kind === "cash_sale");
      }
      const ids = [...new Set(requested.modifierOptionIds)];
      if (ids.length !== requested.modifierOptionIds.length) throw new OfflineConflict("modifier_unavailable", "Duplicate modifier options are invalid", input.kind === "cash_sale");
      const allowed = new Set<number>();
      const selected: Array<{ id: number; name_en: string; name_ar: string; price_delta: number }> = [];
      for (const link of item.modifierGroups) {
        const group = link.modifierGroup;
        if (!group.is_active) continue;
        const options = group.options.filter((option) => option.is_available);
        options.forEach((option) => allowed.add(option.id));
        const chosen = options.filter((option) => ids.includes(option.id));
        if (chosen.length < group.min_selections || chosen.length > group.max_selections) {
          throw new OfflineConflict("modifier_unavailable", `Modifier selection for ${group.code} is no longer valid`, input.kind === "cash_sale");
        }
        selected.push(...chosen.map((option) => {
          const trustedOption = trustedItem?.modifiers.find((entry) => entry.id === option.id);
          if (input.cash && !trustedOption) throw new OfflineConflict("price_snapshot_invalid", `Modifier ${option.code} is absent from the trusted price snapshot`, true);
          return { id: option.id, name_en: option.name_en, name_ar: option.name_ar, price_delta: trustedOption?.priceDelta ?? option.price_delta };
        }));
      }
      if (ids.some((id) => !allowed.has(id))) throw new OfflineConflict("modifier_unavailable", `A modifier for ${item.code} is unavailable`, input.kind === "cash_sale");
      const trustedBasePrice = variant
        ? trustedItem?.variants.find((entry) => entry.id === variant.id)?.price
        : trustedItem?.basePrice;
      if (input.cash && trustedBasePrice == null) throw new OfflineConflict("price_snapshot_invalid", `Variant pricing for ${item.code} is absent from the trusted price snapshot`, true);
      prepared.push({ requested, menuItemId: item.id, productId: item.product_id, variantId: variant?.id ?? null, basePrice: trustedBasePrice ?? variant?.price ?? item.base_price, stationId: item.kitchen_station_id, modifiers: selected });
    }
    const authoritativeTotal = prepared.reduce((sum, item) => sum + (item.basePrice + item.modifiers.reduce((value, modifier) => value + modifier.price_delta, 0)) * item.requested.quantity, 0);
    if (authoritativeTotal !== input.order.expectedTotal && (Boolean(input.cash) || !review.approved)) {
      throw new OfflineConflict("menu_price_changed", `Authoritative total changed from ${input.order.expectedTotal} to ${authoritativeTotal}`, input.kind === "cash_sale");
    }
    if (input.cash && input.cash.tenderedAmount < authoritativeTotal) {
      throw new OfflineConflict("cash_insufficient", `Cash received ${input.cash.tenderedAmount} no longer covers authoritative total ${authoritativeTotal}`, true);
    }

    let customerId: number | null = null;
    if (input.order.deliveryContact) {
      const email = stableDeliveryEmail(input.branchId, userId, input.order.deliveryContact.phone);
      const existingCustomer = await tx.query.customers.findFirst({ where: eq(customers.email, email) });
      if (existingCustomer && existingCustomer.user_uid !== userId) throw new OfflineConflict("user_branch_mismatch", "Delivery contact belongs to a different user scope", input.kind === "cash_sale");
      if (existingCustomer) customerId = existingCustomer.id;
      else {
        const [created] = await tx.insert(customers).values({ name: input.order.deliveryContact.name, phone: input.order.deliveryContact.phone, email, user_uid: userId, status: "active" }).returning({ id: customers.id });
        customerId = created.id;
      }
    }

    const [insertedOrder] = await tx.insert(orders).values({
      branch_id: input.branchId,
      customer_id: customerId,
      dining_table_id: input.order.diningTableId,
      client_request_id: input.order.clientRequestId,
      offline_receipt_reference: input.offlineReceipt?.number ?? null,
      order_type: input.order.orderType,
      subtotal_amount: authoritativeTotal,
      discount_value: 0,
      discount_amount: 0,
      total_amount: authoritativeTotal,
      delivery_address: input.order.deliveryAddress,
      user_uid: userId,
      status: "pending",
      payment_status: "unpaid",
    }).onConflictDoNothing({ target: orders.client_request_id }).returning();
    let order = insertedOrder;
    if (!order) {
      const duplicate = await tx.query.orders.findFirst({ where: eq(orders.client_request_id, input.order.clientRequestId) });
      if (!duplicate || duplicate.user_uid !== userId || duplicate.branch_id !== input.branchId) throw new OfflineConflict("duplicate_already_accepted", "The order request was accepted under a different scope", input.kind === "cash_sale");
      order = duplicate;
    } else {
      if (input.order.diningTableId) {
        const [claimed] = await tx.update(restaurantTables).set({ status: "occupied" }).where(and(eq(restaurantTables.id, input.order.diningTableId), eq(restaurantTables.status, "available"), eq(restaurantTables.is_active, true))).returning({ id: restaurantTables.id });
        if (!claimed) throw new OfflineConflict("table_occupied", "The selected table became occupied during synchronization", input.kind === "cash_sale");
      }
      for (const item of prepared) {
        const [line] = await tx.insert(orderItems).values({ order_id: order.id, product_id: item.productId, menu_item_id: item.menuItemId, variant_id: item.variantId, quantity: item.requested.quantity, price: item.basePrice, notes: item.requested.notes }).returning();
        if (item.modifiers.length) await tx.insert(orderItemModifiers).values(item.modifiers.map((modifier) => ({ order_item_id: line.id, modifier_option_id: modifier.id, name_en: modifier.name_en, name_ar: modifier.name_ar, price_delta: modifier.price_delta })));
      }
    }

    try {
      await issueOrderInventory(tx, {
        orderId: order.id,
        actorUserId: userId,
        idempotencyKey: `offline-inventory:${input.clientOperationId}`,
        allowNegative: review.approved,
        overrideReason: review.approved ? review.reason ?? undefined : undefined,
        overrideApproverUserId: review.approved ? review.approverUserId ?? undefined : undefined,
      });
    } catch (cause) {
      if (cause instanceof InventoryConflict) {
        throw new OfflineConflict(cause.code, cause.message, input.kind === "cash_sale");
      }
      throw cause;
    }
    if (order.status === "pending") {
      await tx.update(orders).set({ status: "confirmed", updated_at: new Date() }).where(eq(orders.id, order.id));
      await tx.insert(orderStatusHistory).values({ order_id: order.id, from_status: "pending", to_status: "confirmed", changed_by: userId, note: "Offline POS order synchronized and inventory issued" });
      order = { ...order, status: "confirmed" };
    }

    let checkout: typeof orderCheckouts.$inferSelect | null = null;
    let receiptJobId: number | null = null;
    if (input.cash) {
      checkout = await tx.query.orderCheckouts.findFirst({ where: eq(orderCheckouts.idempotency_key, input.cash.checkoutIdempotencyKey) }) ?? null;
      if (checkout && (checkout.order_id !== order.id || checkout.created_by !== userId)) throw new OfflineConflict("duplicate_already_accepted", "Checkout idempotency key belongs to another sale", true);
      if (!checkout) {
        const cashMethod = await tx.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.code, "CASH"), eq(paymentMethods.is_active, true), eq(paymentMethods.affects_drawer, true)) });
        if (!cashMethod) throw new OfflineConflict("register_unavailable", "The cash payment method is unavailable", true);
        [checkout] = await tx.insert(orderCheckouts).values({ order_id: order.id, shift_id: shift.id, idempotency_key: input.cash.checkoutIdempotencyKey, subtotal_amount: authoritativeTotal, discount_amount: 0, payable_amount: authoritativeTotal, created_by: userId }).returning();
        const change = input.cash.tenderedAmount - authoritativeTotal;
        const [payment] = await tx.insert(orderPayments).values({ checkout_id: checkout.id, order_id: order.id, shift_id: shift.id, payment_method_id: cashMethod.id, kind: "payment", amount: authoritativeTotal, tendered_amount: input.cash.tenderedAmount, change_amount: change, created_by: userId }).returning();
        await tx.insert(transactions).values({ description: `Offline cash payment for order #${order.id}`, order_id: order.id, shift_id: shift.id, order_payment_id: payment.id, payment_method_id: cashMethod.id, amount: authoritativeTotal, user_uid: userId, type: "income", category: "sale", status: "completed" });
        await tx.update(orders).set({ payment_status: "paid", paid_at: new Date(), subtotal_amount: authoritativeTotal, total_amount: authoritativeTotal, updated_at: new Date() }).where(eq(orders.id, order.id));
        await tx.insert(auditLogs).values({ branch_id: input.branchId, shift_id: shift.id, order_id: order.id, actor_user_id: userId, action: "offline.checkout.accepted", entity_type: "order_checkout", entity_id: String(checkout.id), details: JSON.stringify({ operationId: input.clientOperationId, authoritativeTotal, tenderedAmount: input.cash.tenderedAmount, change }) });
      }
    }

    const preference = await tx.query.registerPrintPreferences.findFirst({ where: eq(registerPrintPreferences.register_id, register.id) });
    const stationIds = [...new Set(prepared.map((item) => item.stationId))];
    for (const stationId of stationIds) {
      const local = input.kotAcknowledgements.find((entry) => entry.stationId === stationId);
      const key = local?.idempotencyKey ?? `offline-kot:${input.clientOperationId}:${stationId}`;
      let job = await tx.query.printJobs.findFirst({ where: eq(printJobs.idempotency_key, key) });
      if (!job) {
        [job] = await tx.insert(printJobs).values({
          order_id: order.id,
          station_id: stationId,
          register_id: register.id,
          shift_id: shift.id,
          requested_by: userId,
          document_type: "kot",
          status: local?.acknowledged ? "acknowledged" : local?.previewed ? "previewed" : "requested",
          is_reprint: false,
          idempotency_key: key,
          copy_count: preference?.kot_copies ?? 1,
          paper_width: preference?.paper_width ?? 80,
          language: preference?.language ?? "bilingual",
          previewed_at: local?.previewed || local?.acknowledged ? new Date() : null,
          acknowledged_at: local?.acknowledged ? new Date() : null,
        }).onConflictDoNothing().returning();
        job ??= await tx.query.printJobs.findFirst({ where: and(eq(printJobs.order_id, order.id), eq(printJobs.station_id, stationId), eq(printJobs.document_type, "kot"), eq(printJobs.is_reprint, false)) });
      }
      if (!job) throw new OfflineConflict("duplicate_already_accepted", "A station print job could not be reconciled", input.kind === "cash_sale");
      await tx.insert(auditLogs).values({ branch_id: input.branchId, shift_id: shift.id, order_id: order.id, actor_user_id: userId, action: local?.acknowledged ? "offline.kot.acknowledged" : "offline.kot.requested", entity_type: "print_job", entity_id: String(job.id), details: JSON.stringify({ operationId: input.clientOperationId, stationId }) });
    }

    if (checkout) {
      let receipt = await tx.query.printJobs.findFirst({ where: and(eq(printJobs.order_id, order.id), eq(printJobs.document_type, "receipt"), eq(printJobs.is_reprint, false)) });
      if (!receipt) {
        [receipt] = await tx.insert(printJobs).values({ order_id: order.id, register_id: register.id, shift_id: shift.id, requested_by: userId, document_type: "receipt", status: input.offlineReceipt?.previewedAt ? "previewed" : "requested", is_reprint: false, idempotency_key: input.offlineReceipt?.printIdempotencyKey ?? `offline-receipt:${input.clientOperationId}`, copy_count: preference?.receipt_copies ?? 1, paper_width: preference?.paper_width ?? 80, language: preference?.language ?? "bilingual", previewed_at: input.offlineReceipt?.previewedAt ? new Date(input.offlineReceipt.previewedAt) : null }).returning();
        await tx.insert(auditLogs).values({ branch_id: input.branchId, shift_id: shift.id, order_id: order.id, actor_user_id: userId, action: input.offlineReceipt?.previewedAt ? "offline.receipt.previewed" : "offline.receipt.available", entity_type: "print_job", entity_id: String(receipt.id), details: JSON.stringify({ operationId: input.clientOperationId, offlineReceiptNumber: input.offlineReceipt?.number ?? null, physicalPrintConfirmed: false }) });
      }
      receiptJobId = receipt.id;
    }

    const [syncRecord] = await tx.insert(offlineSyncRecords).values({
      branch_id: input.branchId,
      register_id: register.id,
      shift_id: shift.id,
      actor_user_id: userId,
      client_operation_id: input.clientOperationId,
      order_client_request_id: input.order.clientRequestId,
      checkout_idempotency_key: input.cash?.checkoutIdempotencyKey ?? null,
      price_snapshot_reference: input.priceSnapshotReference,
      offline_receipt_number: input.offlineReceipt?.number ?? null,
      printed_subtotal_amount: input.offlineReceipt?.subtotal ?? null,
      printed_total_amount: input.offlineReceipt?.total ?? null,
      printed_tendered_amount: input.offlineReceipt?.cashReceived ?? null,
      printed_change_amount: input.offlineReceipt?.change ?? null,
      status: "accepted",
      order_id: order.id,
      checkout_id: checkout?.id ?? null,
    }).onConflictDoUpdate({ target: offlineSyncRecords.client_operation_id, set: { status: "accepted", conflict_code: null, conflict_details: null, order_id: order.id, checkout_id: checkout?.id ?? null, updated_at: new Date() } }).returning();
    await tx.insert(auditLogs).values({ branch_id: input.branchId, shift_id: shift.id, order_id: order.id, actor_user_id: userId, action: "offline.sync.accepted", entity_type: "offline_sync_record", entity_id: String(syncRecord.id), details: JSON.stringify({ operationId: input.clientOperationId, snapshotRevision: input.snapshotRevision, authoritativeTotal, kind: input.kind }) });
    return { status: "accepted" as const, duplicate: !insertedOrder, operationId: input.clientOperationId, orderId: order.id, checkoutId: checkout?.id ?? null, receiptJobId, conflict: null };
  });
}
