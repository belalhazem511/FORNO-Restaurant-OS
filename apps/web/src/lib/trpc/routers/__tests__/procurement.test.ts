import { beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));
const { procurementRouter } = await import("../procurement");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const admin = createCallerFactory(procurementRouter)({
  user: makeUser("procurement-admin"),
});
const cashier = createCallerFactory(procurementRouter)({
  user: makeUser("procurement-cashier"),
});
let branchId: number;
let foreignBranchId: number;
let supplierId: number;
let ingredientId: number;
let gramId: number;
let packageConversionId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);
  await db.insert(schema.user).values([makeUser("procurement-admin"), makeUser("procurement-cashier")]);
  const [branch] = await db
    .insert(schema.branches)
    .values({
      code: "PROCUREMENT-MAIN",
      name_en: "Procurement Main",
      name_ar: "الفرع الرئيسي",
      currency: "EGP",
      timezone: "Africa/Cairo",
      is_active: true,
    })
    .returning();
  branchId = branch.id;
  const [foreign] = await db
    .insert(schema.branches)
    .values({
      code: "PROCUREMENT-OTHER",
      name_en: "Other",
      name_ar: "فرع آخر",
      currency: "EGP",
      timezone: "Africa/Cairo",
      is_active: true,
    })
    .returning();
  foreignBranchId = foreign.id;
  await db.insert(schema.staffAssignments).values([
    {
      user_id: "procurement-admin",
      branch_id: branchId,
      role: "admin",
      is_active: true,
    },
    {
      user_id: "procurement-cashier",
      branch_id: branchId,
      role: "cashier",
      is_active: true,
    },
  ]);
  const [category] = await db
    .insert(schema.ingredientCategories)
    .values({
      branch_id: branchId,
      code: "DRY",
      name_en: "Dry",
      name_ar: "جاف",
      is_active: true,
    })
    .returning();
  const [location] = await db
    .insert(schema.inventoryLocations)
    .values({
      branch_id: branchId,
      code: "STORE",
      name_en: "Store",
      name_ar: "مخزن",
      is_active: true,
    })
    .returning();
  const [mg] = await db
    .insert(schema.unitsOfMeasure)
    .values({
      code: "PROC-MG",
      name_en: "Milligram",
      name_ar: "ملليجرام",
      dimension: "mass",
      base_numerator: 1,
      base_denominator: 1,
    })
    .returning();
  const [gram] = await db
    .insert(schema.unitsOfMeasure)
    .values({
      code: "PROC-G",
      name_en: "Gram",
      name_ar: "جرام",
      dimension: "mass",
      base_numerator: 1_000,
      base_denominator: 1,
    })
    .returning();
  gramId = gram.id;
  const [ingredient] = await db
    .insert(schema.ingredients)
    .values({
      branch_id: branchId,
      category_id: category.id,
      sku: "PROC-FLOUR",
      name_en: "Procurement flour",
      name_ar: "دقيق المشتريات",
      base_unit_id: mg.id,
      dimension: "mass",
      default_location_id: location.id,
      is_active: true,
      is_tracked: true,
      reorder_level: 0,
      low_stock_threshold: 0,
      par_level: null,
      allow_negative: false,
      average_unit_cost_micros: 0,
      created_by: "procurement-admin",
      updated_by: "procurement-admin",
    })
    .returning();
  ingredientId = ingredient.id;
  const [packageConversion] = await db
    .insert(schema.ingredientPackageConversions)
    .values({
      ingredient_id: ingredientId,
      code: "PROC-CASE",
      name_en: "250 gram case",
      name_ar: "عبوة ٢٥٠ جرام",
      base_numerator: 250_000,
      base_denominator: 1,
      is_active: true,
    })
    .returning();
  packageConversionId = packageConversion.id;
  const [supplier] = await db
    .insert(schema.suppliers)
    .values({
      branch_id: branchId,
      code: "PROC-SUP",
      name_en: "Procurement Supplier",
      name_ar: "مورد المشتريات",
      is_active: true,
      created_by: "procurement-admin",
      updated_by: "procurement-admin",
    })
    .returning();
  supplierId = supplier.id;
});

describe("suppliers and purchase orders", () => {
  it("creates an exact-total draft and does not change inventory", async () => {
    const created = await admin.createPurchaseOrder({
      branchId,
      supplierId,
      poNumber: "PO-PROC-001",
      idempotencyKey: "procurement-idempotency-001",
      lines: [
        {
          ingredientId,
          packageConversionId: null,
          unitId: gramId,
          quantityScaled: 2_000,
          unitPriceMinor: 1_500,
          notes: null,
        },
      ],
    });
    expect(created.status).toBe("draft");
    expect(created.total_amount).toBe(3_000);
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.branch_id, branchId))).toHaveLength(0);
  });

  it("enforces submitted then approved lifecycle and preserves audit history", async () => {
    const created = await admin.createPurchaseOrder({
      branchId,
      supplierId,
      poNumber: "PO-PROC-002",
      idempotencyKey: "procurement-idempotency-002",
      lines: [
        {
          ingredientId,
          packageConversionId: null,
          unitId: gramId,
          quantityScaled: 1_000,
          unitPriceMinor: 2_000,
          notes: null,
        },
      ],
    });
    await expect(admin.approvePurchaseOrder({ branchId, purchaseOrderId: created.id })).rejects.toThrow("Only submitted");
    await admin.submitPurchaseOrder({ branchId, purchaseOrderId: created.id });
    const approved = await admin.approvePurchaseOrder({
      branchId,
      purchaseOrderId: created.id,
    });
    expect(approved.status).toBe("approved");
    await expect(
      admin.replaceDraftLines({
        branchId,
        purchaseOrderId: created.id,
        lines: [{ ingredientId, packageConversionId: null, unitId: gramId, quantityScaled: 3_000, unitPriceMinor: 2_000, notes: null }],
      }),
    ).rejects.toThrow("Only draft purchase orders can be edited");
    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity_id, String(created.id)));
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["purchase_order.create", "purchase_order.submit", "purchase_order.approve"]),
    );
  });

  it("protects permissions, branch scope, and idempotent retries", async () => {
    const input = {
      branchId,
      supplierId,
      poNumber: "PO-PROC-003",
      idempotencyKey: "procurement-idempotency-003",
      lines: [
        {
          ingredientId,
          packageConversionId: null,
          unitId: gramId,
          quantityScaled: 1_000,
          unitPriceMinor: 500,
          notes: null,
        },
      ],
    };
    const first = await admin.createPurchaseOrder(input);
    const tampered = await admin.createPurchaseOrder({
      ...input,
      poNumber: "PO-PROC-TAMPERED-PRICE",
      idempotencyKey: "procurement-idempotency-tampered",
      subtotalAmount: 1,
      totalAmount: 1,
    } as typeof input);
    expect(tampered.total_amount).toBe(500);
    const retry = await admin.createPurchaseOrder({
      ...input,
      poNumber: "DIFFERENT",
    });
    expect(retry.id).toBe(first.id);
    await expect(cashier.createPurchaseOrder(input)).rejects.toThrow("cannot perform purchase-order:create");
    await expect(admin.purchaseOrders({ branchId: foreignBranchId })).rejects.toThrow();
  });

  it("creates, edits, rejects duplicate codes, and archives suppliers without deleting history", async () => {
    const created = await admin.createSupplier({
      branchId,
      code: "CRUD-SUP",
      nameEn: "Created supplier",
      nameAr: "مورد جديد",
    });
    const historicalOrder = await admin.createPurchaseOrder({
      branchId,
      supplierId: created.id,
      poNumber: "PO-SUPPLIER-SNAPSHOT",
      idempotencyKey: "procurement-supplier-snapshot-001",
      lines: [{ ingredientId, packageConversionId: null, unitId: gramId, quantityScaled: 1_000, unitPriceMinor: 125, notes: null }],
    });
    await expect(
      admin.createSupplier({
        branchId,
        code: "CRUD-SUP",
        nameEn: "Duplicate supplier",
        nameAr: "مورد مكرر",
      }),
    ).rejects.toThrow("Supplier code already exists in this branch");
    await expect(
      admin.createSupplier({
        branchId,
        code: "x",
        nameEn: "Invalid code supplier",
        nameAr: "Invalid code",
      }),
    ).rejects.toThrow();
    const updated = await admin.updateSupplier({
      branchId,
      supplierId: created.id,
      code: "CRUD-SUP-2",
      nameEn: "Updated supplier",
      nameAr: "مورد محدث",
    });
    expect(updated.name_en).toBe("Updated supplier");
    expect((await admin.purchaseOrder({ branchId, purchaseOrderId: historicalOrder.id })).supplier_name_en_snapshot).toBe(
      "Created supplier",
    );
    const archived = await admin.archiveSupplier({
      branchId,
      supplierId: created.id,
      reason: "Supplier relationship ended",
    });
    expect(archived.is_active).toBe(false);
    expect((await admin.suppliers({ branchId, includeArchived: true })).some((row) => row.id === created.id)).toBe(true);
    expect((await admin.suppliers({ branchId })).some((row) => row.id === created.id)).toBe(false);
  });

  it("cancels drafts and submitted orders but rejects cancellation after approval", async () => {
    const makeOrder = async (poNumber: string, suffix: string) =>
      admin.createPurchaseOrder({
        branchId,
        supplierId,
        poNumber,
        idempotencyKey: `procurement-cancel-${suffix}`,
        lines: [{ ingredientId, packageConversionId: null, unitId: gramId, quantityScaled: 1_000, unitPriceMinor: 100, notes: null }],
      });
    const draft = await makeOrder("PO-CANCEL-DRAFT", "draft");
    expect((await admin.cancelPurchaseOrder({ branchId, purchaseOrderId: draft.id, reason: "Draft no longer needed" })).status).toBe(
      "cancelled",
    );
    const submitted = await makeOrder("PO-CANCEL-SUBMITTED", "submitted");
    await admin.submitPurchaseOrder({ branchId, purchaseOrderId: submitted.id });
    expect((await admin.cancelPurchaseOrder({ branchId, purchaseOrderId: submitted.id, reason: "Supplier unavailable" })).status).toBe(
      "cancelled",
    );
    const approved = await makeOrder("PO-CANCEL-APPROVED", "approved");
    await admin.submitPurchaseOrder({ branchId, purchaseOrderId: approved.id });
    await admin.approvePurchaseOrder({ branchId, purchaseOrderId: approved.id });
    await expect(admin.cancelPurchaseOrder({ branchId, purchaseOrderId: approved.id, reason: "Should be rejected" })).rejects.toThrow();
    expect(await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.branch_id, branchId))).toHaveLength(0);
    expect(await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.ingredient_id, ingredientId))).toHaveLength(0);
  });

  it("converts packages exactly and rounds integer EGP totals deterministically", async () => {
    const order = await admin.createPurchaseOrder({
      branchId,
      supplierId,
      poNumber: "PO-PACKAGE-ROUNDING",
      idempotencyKey: "procurement-package-rounding-001",
      lines: [{ ingredientId, packageConversionId, unitId: gramId, quantityScaled: 1_500, unitPriceMinor: 12_345, notes: null }],
    });
    expect(order.total_amount).toBe(18_518);
    const [line] = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.purchase_order_id, order.id));
    expect(line.quantity_base).toBe(375_000_000);
    expect(line.line_total_amount).toBe(18_518);
    await expect(
      admin.createPurchaseOrder({
        branchId,
        supplierId,
        poNumber: "PO-BAD-PACKAGE",
        idempotencyKey: "procurement-package-invalid-001",
        lines: [{ ingredientId, packageConversionId: 999_999, unitId: gramId, quantityScaled: 1_000, unitPriceMinor: 1, notes: null }],
      }),
    ).rejects.toThrow("Package conversion");
  });
});
