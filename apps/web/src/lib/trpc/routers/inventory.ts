import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  auditLogs,
  ingredientCategories,
  ingredients,
  inventoryLocations,
  menuCategories,
  menuItems,
  modifierGroups,
  modifierOptions,
  orders,
  recipeComponents,
  recipeVersions,
  stockBalances,
  stockMovements,
  staffAssignments,
  unitsOfMeasure,
} from "@/lib/db/schema";
import { hasPermission, requireStaff } from "@/lib/permissions";
import { protectedProcedure, router } from "../init";
import { applyYieldLoss, convertScaledQuantity, costMinorForQuantity } from "@/lib/inventory/exact";
import { menuAvailability, postStockIncrease } from "@/lib/inventory/service";

const branchInput = z.object({ branchId: z.number().int().positive() });
const componentInput = z.object({
  ingredientId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  unitId: z.number().int().positive(),
  quantityScaled: z.number().int().refine((value) => value !== 0),
  modifierOptionId: z.number().int().positive().nullable().optional(),
});

async function branchEntities(branchId: number, input: { categoryId?: number; locationId?: number; ingredientId?: number }) {
  const [category, location, ingredient] = await Promise.all([
    input.categoryId ? db.query.ingredientCategories.findFirst({ where: and(eq(ingredientCategories.id, input.categoryId), eq(ingredientCategories.branch_id, branchId)) }) : null,
    input.locationId ? db.query.inventoryLocations.findFirst({ where: and(eq(inventoryLocations.id, input.locationId), eq(inventoryLocations.branch_id, branchId)) }) : null,
    input.ingredientId ? db.query.ingredients.findFirst({ where: and(eq(ingredients.id, input.ingredientId), eq(ingredients.branch_id, branchId)) }) : null,
  ]);
  if (input.categoryId && !category) throw new TRPCError({ code: "NOT_FOUND", message: "Ingredient category not found in this branch" });
  if (input.locationId && !location) throw new TRPCError({ code: "NOT_FOUND", message: "Inventory location not found in this branch" });
  if (input.ingredientId && !ingredient) throw new TRPCError({ code: "NOT_FOUND", message: "Ingredient not found in this branch" });
  return { category, location, ingredient };
}

export const inventoryRouter = router({
  context: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const assignment = await db.query.staffAssignments.findFirst({ where: and(eq(staffAssignments.user_id, ctx.user.id), eq(staffAssignments.is_active, true)), with: { branch: true } });
    if (!assignment || !hasPermission(assignment.role, "inventory:view")) throw new TRPCError({ code: "FORBIDDEN", message: "Inventory access is not available" });
    return { branch: assignment.branch, role: assignment.role, canManage: hasPermission(assignment.role, "inventory:configure"), canAdjust: hasPermission(assignment.role, "inventory:adjust"), canManageRecipes: hasPermission(assignment.role, "recipe:manage"), canViewCost: hasPermission(assignment.role, "inventory:cost:view"), canOverride: hasPermission(assignment.role, "inventory:override") };
  }),
  referenceData: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "inventory:view");
    const [locations, categories, units, modifiers] = await Promise.all([
      db.select().from(inventoryLocations).where(eq(inventoryLocations.branch_id, input.branchId)).orderBy(inventoryLocations.code),
      db.select().from(ingredientCategories).where(eq(ingredientCategories.branch_id, input.branchId)).orderBy(ingredientCategories.code),
      db.select().from(unitsOfMeasure).orderBy(unitsOfMeasure.id),
      db.query.modifierGroups.findMany({ where: eq(modifierGroups.branch_id, input.branchId), with: { options: true } }),
    ]);
    return { locations, categories, units, modifiers };
  }),

  overview: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "inventory:view");
    const [rows, recent, availability] = await Promise.all([
      db.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, input.branchId), eq(ingredients.is_tracked, true)), with: { balances: true, category: true, baseUnit: true, defaultLocation: true } }),
      db.query.stockMovements.findMany({ where: eq(stockMovements.branch_id, input.branchId), with: { ingredient: true, location: true }, orderBy: [desc(stockMovements.created_at)], limit: 12 }),
      db.transaction((tx) => menuAvailability(tx, input.branchId)),
    ]);
    let valuation = 0;
    const attention = rows.map((ingredient) => {
      const onHand = ingredient.balances.reduce((sum, balance) => sum + balance.quantity_base, 0);
      const status = onHand <= 0 ? "out_of_stock" as const : onHand <= ingredient.low_stock_threshold ? "low_stock" as const : "in_stock" as const;
      valuation += ingredient.balances.reduce((sum, balance) => {
        const value = costMinorForQuantity(Math.abs(balance.quantity_base), balance.average_unit_cost_micros);
        return sum + (balance.quantity_base < 0 ? -value : value);
      }, 0);
      return { id: ingredient.id, sku: ingredient.sku, name_en: ingredient.name_en, name_ar: ingredient.name_ar, onHand, status, unit: ingredient.baseUnit.code, dimension: ingredient.dimension };
    });
    const recipeConfigurations = availability.length;
    const covered = availability.filter((entry) => entry.status !== "recipe_missing").length;
    return {
      tracked: rows.length,
      inStock: attention.filter((row) => row.status === "in_stock").length,
      lowStock: attention.filter((row) => row.status === "low_stock").length,
      outOfStock: attention.filter((row) => row.status === "out_of_stock").length,
      valuation: hasPermission(assignment.role, "inventory:cost:view") ? valuation : null,
      attention: attention.filter((row) => row.status !== "in_stock"),
      recent,
      recipeCoverage: { covered, total: recipeConfigurations },
      exceptions: availability.filter((entry) => ["recipe_missing", "unavailable"].includes(entry.status)).length,
    };
  }),

  ingredients: protectedProcedure.input(branchInput.extend({ includeArchived: z.boolean().optional() })).query(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "inventory:view");
    const rows = await db.query.ingredients.findMany({ where: and(eq(ingredients.branch_id, input.branchId), input.includeArchived ? undefined : eq(ingredients.is_active, true)), with: { category: true, baseUnit: true, defaultLocation: true, balances: true, packages: true }, orderBy: [ingredients.name_en] });
    return rows.map((ingredient) => ({ ...ingredient, average_unit_cost_micros: hasPermission(assignment.role, "inventory:cost:view") ? ingredient.average_unit_cost_micros : null, balances: ingredient.balances.map((balance) => ({ ...balance, average_unit_cost_micros: hasPermission(assignment.role, "inventory:cost:view") ? balance.average_unit_cost_micros : null })) }));
  }),

  createIngredient: protectedProcedure.input(branchInput.extend({
    categoryId: z.number().int().positive(), sku: z.string().trim().min(2).max(40), nameEn: z.string().trim().min(2).max(120), nameAr: z.string().trim().min(2).max(120), baseUnitId: z.number().int().positive(), dimension: z.enum(["mass", "volume", "count"]), defaultLocationId: z.number().int().positive(), tracked: z.boolean().default(true), reorderLevel: z.number().int().nonnegative(), lowStockThreshold: z.number().int().nonnegative(), parLevel: z.number().int().nonnegative().nullable().optional(), allowNegative: z.boolean().default(false),
  })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "inventory:configure");
    const [{ category, location }, unit] = await Promise.all([branchEntities(input.branchId, { categoryId: input.categoryId, locationId: input.defaultLocationId }), db.query.unitsOfMeasure.findFirst({ where: eq(unitsOfMeasure.id, input.baseUnitId) })]);
    if (!category || !location || !unit || unit.dimension !== input.dimension) throw new Error("The ingredient base unit must match its measurement dimension");
    return db.transaction(async (tx) => {
      const [ingredient] = await tx.insert(ingredients).values({ branch_id: input.branchId, category_id: input.categoryId, sku: input.sku, name_en: input.nameEn, name_ar: input.nameAr, base_unit_id: input.baseUnitId, dimension: input.dimension, default_location_id: input.defaultLocationId, is_active: true, is_tracked: input.tracked, reorder_level: input.reorderLevel, low_stock_threshold: input.lowStockThreshold, par_level: input.parLevel ?? null, allow_negative: input.allowNegative, average_unit_cost_micros: 0, created_by: ctx.user.id, updated_by: ctx.user.id }).returning();
      await tx.insert(stockBalances).values({ branch_id: input.branchId, location_id: input.defaultLocationId, ingredient_id: ingredient.id, quantity_base: 0, average_unit_cost_micros: 0 });
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "inventory.ingredient_create", entity_type: "ingredient", entity_id: String(ingredient.id), details: JSON.stringify({ sku: input.sku }) });
      return ingredient;
    });
  }),

  archiveIngredient: protectedProcedure.input(branchInput.extend({ ingredientId: z.number().int().positive(), reason: z.string().trim().min(3).max(500) })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "inventory:configure");
    const { ingredient } = await branchEntities(input.branchId, input);
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(ingredients).set({ is_active: false, updated_by: ctx.user.id, updated_at: new Date() }).where(eq(ingredients.id, ingredient!.id)).returning();
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "inventory.ingredient_archive", entity_type: "ingredient", entity_id: String(updated.id), reason: input.reason });
      return updated;
    });
  }),

  adjust: protectedProcedure.input(branchInput.extend({ ingredientId: z.number().int().positive(), locationId: z.number().int().positive(), quantityBase: z.number().int().positive(), unitCostMicros: z.number().int().nonnegative().optional(), direction: z.enum(["positive", "negative"]), opening: z.boolean().optional(), idempotencyKey: z.string().trim().min(8).max(140), reason: z.string().trim().min(3).max(500), override: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "inventory:adjust");
    const { ingredient, location } = await branchEntities(input.branchId, input);
    if (!ingredient || !location) throw new Error("Inventory entity unavailable");
    if (input.direction === "positive") {
      if (input.unitCostMicros == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Positive stock requires an explicit trusted unit cost" });
      const unitCostMicros = input.unitCostMicros;
      return db.transaction((tx) => postStockIncrease(tx, { branchId: input.branchId, locationId: input.locationId, ingredientId: input.ingredientId, quantityBase: input.quantityBase, unitCostMicros, actorUserId: ctx.user.id, idempotencyKey: input.idempotencyKey, movementType: input.opening ? "opening_balance" : "manual_positive", reason: input.reason }));
    }
    return db.transaction(async (tx) => {
      const duplicate = await tx.query.stockMovements.findFirst({ where: eq(stockMovements.idempotency_key, input.idempotencyKey) });
      if (duplicate) return duplicate;
      await tx.execute(sql`select id from stock_balances where ingredient_id = ${input.ingredientId} and location_id = ${input.locationId} for update`);
      const balance = await tx.query.stockBalances.findFirst({ where: and(eq(stockBalances.ingredient_id, input.ingredientId), eq(stockBalances.location_id, input.locationId)) });
      if (!balance) throw new Error("Stock balance unavailable");
      const negative = balance.quantity_base < input.quantityBase;
      if (negative && (!input.override || !hasPermission(assignment.role, "inventory:override"))) throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient stock requires an authorized negative-stock override" });
      if (negative && !ingredient.allow_negative) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This ingredient does not permit negative-stock override" });
      const [movement] = await tx.insert(stockMovements).values({ branch_id: input.branchId, location_id: input.locationId, ingredient_id: input.ingredientId, movement_type: negative ? "negative_override" : "manual_negative", direction: -1, quantity_base: input.quantityBase, unit_cost_micros: balance.average_unit_cost_micros, total_cost_amount: costMinorForQuantity(input.quantityBase, balance.average_unit_cost_micros), source_type: "inventory_adjustment", source_id: input.idempotencyKey, idempotency_key: input.idempotencyKey, actor_user_id: ctx.user.id, reason: input.reason }).returning();
      await tx.update(stockBalances).set({ quantity_base: balance.quantity_base - input.quantityBase, updated_at: new Date() }).where(eq(stockBalances.id, balance.id));
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: negative ? ctx.user.id : null, action: negative ? "inventory.negative_override" : "inventory.adjustment", entity_type: "stock_movement", entity_id: String(movement.id), reason: input.reason });
      return movement;
    });
  }),

  movements: protectedProcedure.input(branchInput.extend({ ingredientId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "inventory:view");
    const rows = await db.query.stockMovements.findMany({ where: and(eq(stockMovements.branch_id, input.branchId), input.ingredientId ? eq(stockMovements.ingredient_id, input.ingredientId) : undefined), with: { ingredient: true, location: true }, orderBy: [desc(stockMovements.created_at)], limit: 250 });
    return rows.map((row) => ({ ...row, unit_cost_micros: hasPermission(assignment.role, "inventory:cost:view") ? row.unit_cost_micros : null, total_cost_amount: hasPermission(assignment.role, "inventory:cost:view") ? row.total_cost_amount : null }));
  }),

  createRecipe: protectedProcedure.input(branchInput.extend({ menuItemId: z.number().int().positive(), variantId: z.number().int().positive().nullable().optional(), yieldLossBps: z.number().int().min(0).max(9999), components: z.array(componentInput).min(1) })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "recipe:manage");
    const item = await db.query.menuItems.findFirst({ where: eq(menuItems.id, input.menuItemId), with: { category: true, variants: true, modifierGroups: { with: { modifierGroup: { with: { options: true } } } } } });
    if (!item || item.category.branch_id !== input.branchId || (input.variantId && !item.variants.some((variant) => variant.id === input.variantId))) throw new Error("Menu configuration does not belong to this branch");
    const ingredientIds = [...new Set(input.components.map((component) => component.ingredientId))];
    const unitIds = [...new Set(input.components.map((component) => component.unitId))];
    const modifierIds = [...new Set(input.components.flatMap((component) => component.modifierOptionId ? [component.modifierOptionId] : []))];
    const componentKeys = new Set(input.components.map((component) => `${component.ingredientId}:${component.locationId}:${component.modifierOptionId ?? "base"}`));
    if (componentKeys.size !== input.components.length) throw new Error("Duplicate ambiguous recipe components are not allowed");
    const [ingredientRows, unitRows, locationRows, modifierRows] = await Promise.all([
      db.select().from(ingredients).where(and(eq(ingredients.branch_id, input.branchId), inArray(ingredients.id, ingredientIds))),
      db.select().from(unitsOfMeasure).where(inArray(unitsOfMeasure.id, unitIds)),
      db.select().from(inventoryLocations).where(eq(inventoryLocations.branch_id, input.branchId)),
      modifierIds.length ? db.query.modifierOptions.findMany({ where: inArray(modifierOptions.id, modifierIds), with: { group: true } }) : [],
    ]);
    const ingredientById = new Map(ingredientRows.map((row) => [row.id, row]));
    const unitById = new Map(unitRows.map((row) => [row.id, row]));
    const locationIds = new Set(locationRows.map((row) => row.id));
    const allowedModifierIds = new Set(item.modifierGroups.flatMap((link) => link.modifierGroup.options.map((option) => option.id)));
    if (modifierRows.length !== modifierIds.length || modifierRows.some((row) => row.group.branch_id !== input.branchId) || modifierIds.some((id) => !allowedModifierIds.has(id))) throw new Error("Recipe modifier is outside this menu configuration or branch");
    const resolved = input.components.map((component) => {
      const ingredient = ingredientById.get(component.ingredientId); const unit = unitById.get(component.unitId);
      if (!ingredient || !unit || !locationIds.has(component.locationId)) throw new Error("Recipe component is outside this branch");
      const quantityBase = convertScaledQuantity({ quantityScaled: component.quantityScaled, fromDimension: unit.dimension, toDimension: ingredient.dimension, factor: { numerator: unit.base_numerator, denominator: unit.base_denominator } });
      return { ...component, quantityBase };
    });
    return db.transaction(async (tx) => {
      const latest = await tx.select().from(recipeVersions).where(and(eq(recipeVersions.menu_item_id, input.menuItemId), input.variantId ? eq(recipeVersions.variant_id, input.variantId) : isNull(recipeVersions.variant_id))).orderBy(desc(recipeVersions.version)).limit(1);
      const [version] = await tx.insert(recipeVersions).values({ branch_id: input.branchId, menu_item_id: input.menuItemId, variant_id: input.variantId ?? null, version: (latest[0]?.version ?? 0) + 1, status: "draft", effective_at: null, yield_loss_bps: input.yieldLossBps, authored_by: ctx.user.id }).returning();
      await tx.insert(recipeComponents).values(resolved.map((component) => ({ recipe_version_id: version.id, ingredient_id: component.ingredientId, source_location_id: component.locationId, modifier_option_id: component.modifierOptionId ?? null, unit_id: component.unitId, quantity_input_scaled: component.quantityScaled, quantity_base: component.quantityBase })));
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, action: "recipe.create", entity_type: "recipe_version", entity_id: String(version.id), details: JSON.stringify({ version: version.version, componentCount: resolved.length }) });
      return version;
    });
  }),

  activateRecipe: protectedProcedure.input(branchInput.extend({ recipeVersionId: z.number().int().positive(), reason: z.string().trim().min(3).max(500) })).mutation(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "recipe:manage");
    return db.transaction(async (tx) => {
      const version = await tx.query.recipeVersions.findFirst({ where: and(eq(recipeVersions.id, input.recipeVersionId), eq(recipeVersions.branch_id, input.branchId)), with: { components: true } });
      if (!version || version.status !== "draft" || !version.components.length) throw new Error("Only a complete draft recipe can be activated");
      const base = new Map<string, number>();
      for (const component of version.components.filter((row) => row.modifier_option_id == null)) base.set(`${component.ingredient_id}:${component.source_location_id}`, (base.get(`${component.ingredient_id}:${component.source_location_id}`) ?? 0) + component.quantity_base);
      if ([...base.values()].some((quantity) => quantity <= 0)) throw new Error("Recipe base quantities must remain positive");
      for (const component of version.components.filter((row) => row.modifier_option_id != null && row.quantity_base < 0)) if ((base.get(`${component.ingredient_id}:${component.source_location_id}`) ?? 0) + component.quantity_base <= 0) throw new Error("Modifier delta creates a negative final ingredient quantity");
      await tx.update(recipeVersions).set({ status: "retired" }).where(and(eq(recipeVersions.menu_item_id, version.menu_item_id), version.variant_id ? eq(recipeVersions.variant_id, version.variant_id) : isNull(recipeVersions.variant_id), eq(recipeVersions.status, "active")));
      const [active] = await tx.update(recipeVersions).set({ status: "active", effective_at: new Date(), approved_by: ctx.user.id, approved_at: new Date() }).where(eq(recipeVersions.id, version.id)).returning();
      await tx.insert(auditLogs).values({ branch_id: input.branchId, actor_user_id: ctx.user.id, approver_user_id: ctx.user.id, action: "recipe.activate", entity_type: "recipe_version", entity_id: String(active.id), reason: input.reason, details: JSON.stringify({ version: active.version }) });
      return active;
    });
  }),

  recipes: protectedProcedure.input(branchInput).query(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "recipe:manage");
    const availability = await db.transaction((tx) => menuAvailability(tx, input.branchId, { includeInventoryDetails: hasPermission(assignment.role, "inventory:view") }));
    const items = await db.query.menuItems.findMany({ with: { category: true, variants: true, recipeVersions: { with: { components: { with: { ingredient: true, sourceLocation: true, unit: true, modifierOption: true } } }, orderBy: [desc(recipeVersions.version)] } } });
    return items.filter((item) => item.category.branch_id === input.branchId).map((item) => ({
      ...item,
      recipeVersions: item.recipeVersions.map((version) => {
        const componentCost = (component: (typeof version.components)[number]) => {
          const signedQuantity = applyYieldLoss(component.quantity_base, version.yield_loss_bps);
          const cost = costMinorForQuantity(Math.abs(signedQuantity), component.ingredient.average_unit_cost_micros);
          return signedQuantity < 0 ? -cost : cost;
        };
        const modifierCosts = new Map<number, number>();
        for (const component of version.components) if (component.modifier_option_id != null) modifierCosts.set(component.modifier_option_id, (modifierCosts.get(component.modifier_option_id) ?? 0) + componentCost(component));
        return {
          ...version,
          theoreticalBaseCost: hasPermission(assignment.role, "inventory:cost:view") ? version.components.filter((component) => component.modifier_option_id == null).reduce((sum, component) => sum + componentCost(component), 0) : null,
          modifierIncrementalCosts: hasPermission(assignment.role, "inventory:cost:view") ? [...modifierCosts].map(([modifierOptionId, cost]) => ({ modifierOptionId, cost })) : [],
          components: version.components.map((component) => ({ ...component, ingredient: { ...component.ingredient, average_unit_cost_micros: hasPermission(assignment.role, "inventory:cost:view") ? component.ingredient.average_unit_cost_micros : null } })),
        };
      }),
      availability: availability.filter((row) => row.menuItemId === item.id).map((row) => ({ ...row, theoreticalCost: hasPermission(assignment.role, "inventory:cost:view") ? row.theoreticalCost : null })),
    }));
  }),
  availability: protectedProcedure.input(branchInput.extend({ configurations: z.array(z.object({ menuItemId: z.number().int().positive(), variantId: z.number().int().positive().nullable(), modifierOptionIds: z.array(z.number().int().positive()).max(30).optional(), quantity: z.number().int().min(1).max(1_000_000).optional() })).max(250).optional() })).query(async ({ ctx, input }) => {
    const assignment = await requireStaff(ctx.user.id, input.branchId, "order:create");
    const rows = await db.transaction((tx) => menuAvailability(tx, input.branchId, { configurations: input.configurations, includeInventoryDetails: hasPermission(assignment.role, "inventory:view") }));
    return rows.map((row) => ({ ...row, theoreticalCost: hasPermission(assignment.role, "inventory:cost:view") ? row.theoreticalCost : null }));
  }),
  orderCost: protectedProcedure.input(branchInput.extend({ orderId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await requireStaff(ctx.user.id, input.branchId, "inventory:cost:view");
    const order = await db.query.orders.findFirst({ where: and(eq(orders.id, input.orderId), eq(orders.branch_id, input.branchId)), with: { inventoryIssues: { with: { consumptions: { with: { ingredient: true, location: true, recipeVersion: true, orderItem: { with: { menuItem: true, variant: true } } } } } }, orderItems: { with: { menuItem: true, variant: true, cogs: { with: { recipeVersion: true } } } } } });
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found in this branch" });
    return { orderId: order.id, netSale: order.total_amount, totalCogs: order.total_cogs_amount, theoreticalGrossMargin: order.total_cogs_amount == null ? null : order.total_amount - order.total_cogs_amount, issuedAt: order.inventory_issued_at, issues: order.inventoryIssues, items: order.orderItems.map((item) => ({ id: item.id, name_en: item.menuItem?.name_en ?? `Item ${item.id}`, name_ar: item.menuItem?.name_ar ?? `صنف ${item.id}`, variant: item.variant, quantity: item.quantity, cogs: item.cogs[0]?.total_cogs_amount ?? null, recipeVersion: item.cogs[0]?.recipeVersion.version ?? null })) };
  }),
});
