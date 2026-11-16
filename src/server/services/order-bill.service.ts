/**
 * One open bill per table.
 *
 * An order is an OPEN BILL when its money is not collected (`paymentStatus` is
 * UNPAID or ON_TAB) and it is not CANCELLED. A SERVED bill that has not been
 * paid is still open: second courses are appended to the same bill. A SETTLED
 * bill (`paymentStatus` PAID or a payment row) is never modified.
 *
 * The service owns the database rules so both the server actions and the
 * acceptance tests exercise the same path. It never reads cookies or emits
 * socket events; callers pass the actor and the shift.
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeOrderTotals, parseMoney, roundMoney } from '@/lib/money';
import { getEffectiveUnitPrice } from '@/lib/scheduled-pricing';
import {
  isLegalStatusTransition,
  isOrderItemStatus,
  isOrderStatus,
  rollUpOrderStatus,
  type OrderStatus,
} from '@/lib/orderStatus';
import { FLOOR_ROLES, MANAGEMENT_ROLES, type Role } from '@/lib/roles';

type Db = PrismaClient | Prisma.TransactionClient;

export const ORDER_TYPES = ['DINE_IN', 'TAKEOUT'] as const;

/** Payment states that keep a bill open (money not collected yet). */
export const OPEN_BILL_PAYMENT_STATUSES = ['UNPAID', 'ON_TAB'] as const;

/**
 * Partial unique index that makes "one open bill per table" a database
 * guarantee. Prisma cannot declare partial indexes, so it is applied with raw
 * SQL once per process (and by the test setup).
 */
export const OPEN_BILL_INDEX_NAME = 'Order_open_bill_per_table';
const OPEN_BILL_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS "${OPEN_BILL_INDEX_NAME}"
  ON "Order" ("tableNumber")
  WHERE "tableNumber" IS NOT NULL
    AND "type" = 'DINE_IN'
    AND "status" <> 'CANCELLED'
    AND "paymentStatus" IN ('UNPAID', 'ON_TAB')`;

/** Stable error codes. The action layer localizes them for the till. */
export type BillErrorCode =
  | 'NOT_AUTHORIZED'
  | 'NO_SHIFT'
  | 'INVALID_TYPE'
  | 'TABLE_REQUIRED'
  | 'EMPTY_ITEMS'
  | 'INVALID_QUANTITY'
  | 'PRICE_OVERRIDE'
  | 'DISCOUNT'
  | 'INVALID_DISCOUNT'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'SETTLED'
  | 'CLOSED_SHIFT'
  | 'SETTLED_REOPEN'
  | 'ALREADY_PAID'
  | 'TAB_CUSTOMER'
  | 'TABLE_HAS_OPEN_BILL'
  | 'UNKNOWN_ITEM'
  | 'UNKNOWN_STATUS'
  | 'UNKNOWN_ITEM_STATUS'
  | 'USE_CANCEL'
  | 'FAILED';

export const BILL_ERROR_MESSAGES: Record<BillErrorCode, string> = {
  NOT_AUTHORIZED: 'Not authorized for this action',
  NO_SHIFT: 'No active shift',
  INVALID_TYPE: 'Invalid order type',
  TABLE_REQUIRED: 'Select a table for this bill',
  EMPTY_ITEMS: 'Order must contain at least one item',
  INVALID_QUANTITY: 'Item quantities must be greater than zero',
  PRICE_OVERRIDE: 'Not authorized to override prices',
  DISCOUNT: 'Not authorized to apply a discount',
  INVALID_DISCOUNT: 'Discount must be a positive amount',
  NOT_FOUND: 'Order not found',
  CANCELLED: 'Order is cancelled',
  SETTLED: 'Order is already settled — start a new order',
  CLOSED_SHIFT: 'That bill belongs to a closed shift — start a new order',
  SETTLED_REOPEN: 'Settled orders cannot be reopened',
  ALREADY_PAID: 'This order has already been paid',
  TAB_CUSTOMER: 'This credit bill has no customer attached',
  TABLE_HAS_OPEN_BILL: 'This table already has an open bill — add to that bill',
  UNKNOWN_ITEM: 'A menu item in this order is no longer available',
  UNKNOWN_STATUS: 'Unknown order status',
  UNKNOWN_ITEM_STATUS: 'Unknown item status',
  USE_CANCEL: 'Use cancelOrder to cancel',
  FAILED: 'Something went wrong',
};

export interface BillFailure {
  ok: false;
  code: BillErrorCode;
  error: string;
}

export function billFailure(code: BillErrorCode): BillFailure {
  return { ok: false, code, error: BILL_ERROR_MESSAGES[code] };
}

export interface Actor {
  staffId: number;
  role: Role;
}

export interface NewOrderLine {
  menuItemId: number;
  variantId?: number;
  quantity: number;
  note?: string;
  overridePrice?: number;
}

const ORDER_INCLUDE = {
  items: true,
  staff: { select: { name: true, nameAm: true, nameOm: true } },
  payment: true,
} satisfies Prisma.OrderInclude;

let indexPromise: Promise<void> | null = null;

export function ensureOpenBillIndex(db: Db = prisma): Promise<void> {
  let cached = indexPromise;
  if (!cached) {
    cached = applyOpenBillIndex(db)
      .then(() => undefined)
      .catch((error) => {
        // Existing duplicate bills are an operators' problem, not a reason to
        // stop taking orders. Keep the application-level check as the fallback.
        console.error('Open-bill unique index could not be created:', error);
      });
    indexPromise = cached;
  }
  return cached;
}

export function applyOpenBillIndex(db: Db = prisma): Promise<unknown> {
  return db.$executeRawUnsafe(OPEN_BILL_INDEX_SQL);
}

/** Predicate used by both the pre-check and the listing queries. */
export function openBillWhere(tableNumber: string): Prisma.OrderWhereInput {
  return {
    tableNumber,
    type: 'DINE_IN',
    status: { not: 'CANCELLED' },
    paymentStatus: { in: [...OPEN_BILL_PAYMENT_STATUSES] },
  };
}

interface OrderState {
  status: string;
  paymentStatus: string;
  payment: { amountPaid: number } | null;
}

/** A bill is settled once any money has been taken for it. */
export function isSettledBill(order: OrderState): boolean {
  if (order.paymentStatus === 'PAID') return true;
  return (order.payment?.amountPaid ?? 0) > 0;
}

export function listOpenBillsForTable(tableNumber: string, db: Db = prisma) {
  return db.order.findMany({
    where: openBillWhere(tableNumber),
    include: ORDER_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * The cashier's settle queue: unpaid bills that reached the guest (SERVED) or
 * were handed off (deliveredAt stamped). Kitchen work in progress stays in the
 * kitchen views.
 */
export function listCashierUnpaidBills(db: Db = prisma) {
  return db.order.findMany({
    where: {
      paymentStatus: 'UNPAID',
      status: { not: 'CANCELLED' },
      OR: [{ status: 'SERVED' }, { deliveredAt: { not: null } }],
    },
    include: {
      items: true,
      staff: { select: { name: true, nameAm: true, nameOm: true, role: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

interface BuiltLine {
  menuItemId: number;
  variantId?: number;
  quantity: number;
  unitPrice: number;
  itemNameEn: string;
  itemNameAm: string | null;
  itemNameOm: string | null;
  totalPrice: number;
  note?: string;
  requiresTicket: boolean;
}

type BuildResult = { ok: true; lines: BuiltLine[] } | BillFailure;

/**
 * Price an incoming cart from the live menu: base price plus active scheduled
 * increase, then the variant offset and its own scheduled increase. Name and
 * price are snapshotted onto the line, exactly like order creation.
 */
export async function buildOrderLines(
  db: Db,
  items: NewOrderLine[],
  role: Role,
  now: Date = new Date(),
): Promise<BuildResult> {
  if (!Array.isArray(items) || items.length === 0) return billFailure('EMPTY_ITEMS');
  if (items.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0)) {
    return billFailure('INVALID_QUANTITY');
  }
  if (!MANAGEMENT_ROLES.includes(role) && items.some((item) => item.overridePrice !== undefined)) {
    return billFailure('PRICE_OVERRIDE');
  }

  const menuItemIds = [...new Set(items.map((item) => item.menuItemId))];
  const variantIds = [...new Set(items.map((item) => item.variantId).filter((v): v is number => !!v))];
  const [menuItems, variants] = await Promise.all([
    db.menuItem.findMany({ where: { id: { in: menuItemIds } } }),
    variantIds.length
      ? db.menuVariant.findMany({ where: { id: { in: variantIds } } })
      : Promise.resolve([]),
  ]);
  const menuItemMap = new Map(menuItems.map((item) => [item.id, item]));
  const variantMap = new Map(variants.map((variant) => [variant.id, variant]));

  const lines: BuiltLine[] = [];
  for (const item of items) {
    const menuItem = menuItemMap.get(item.menuItemId);
    if (!menuItem) return billFailure('UNKNOWN_ITEM');
    const variant = item.variantId ? variantMap.get(item.variantId) : undefined;
    if (item.variantId && (!variant || variant.menuItemId !== menuItem.id)) {
      return billFailure('UNKNOWN_ITEM');
    }

    let unitPrice = getEffectiveUnitPrice(menuItem, variant ?? null, now);
    if (item.overridePrice !== undefined) unitPrice = roundMoney(item.overridePrice);

    let itemNameEn = menuItem.nameEn;
    let itemNameAm = menuItem.nameAm;
    let itemNameOm = menuItem.nameOm;
    if (variant) {
      itemNameEn = `${menuItem.nameEn} (${variant.nameEn})`;
      if (menuItem.nameAm && variant.nameAm) {
        itemNameAm = `${menuItem.nameAm} (${variant.nameAm})`;
      }
      if (menuItem.nameOm && variant.nameOm) {
        itemNameOm = `${menuItem.nameOm} (${variant.nameOm})`;
      }
    }

    lines.push({
      menuItemId: menuItem.id,
      variantId: variant?.id,
      quantity: item.quantity,
      unitPrice,
      itemNameEn,
      itemNameAm,
      itemNameOm,
      totalPrice: roundMoney(unitPrice * item.quantity),
      note: item.note,
      requiresTicket: menuItem.requiresTicket,
    });
  }

  return { ok: true, lines };
}

// ============ CREATE ============

export interface CreateBillInput {
  type: string;
  shiftId: number;
  tableNumber?: string;
  note?: string;
  discount?: number;
  clientKey?: string;
  autoConfirm?: boolean;
  items: NewOrderLine[];
}

export type CreateBillResult =
  | {
      ok: true;
      order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
      replayed?: boolean;
    }
  | BillFailure;

async function loadOrder(orderId: number, db: Db = prisma) {
  return db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
}

async function findByClientKey(clientKey: string, db: Db = prisma) {
  return db.order.findUnique({ where: { clientKey }, include: ORDER_INCLUDE });
}

function uniqueTarget(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = (error.meta as { target?: unknown } | undefined)?.target;
    return Array.isArray(target) ? target.join(',') : String(target ?? '');
  }
  return '';
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function nextOrderNumber(seq: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return `${today.toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
}

export async function createOrderRecord(
  input: CreateBillInput,
  actor: Actor,
): Promise<CreateBillResult> {
  if (!FLOOR_ROLES.includes(actor.role)) return billFailure('NOT_AUTHORIZED');
  if (!input.shiftId) return billFailure('NO_SHIFT');
  if (!(ORDER_TYPES as readonly string[]).includes(input.type)) return billFailure('INVALID_TYPE');

  const isManagement = MANAGEMENT_ROLES.includes(actor.role);

  let discount = 0;
  if (input.discount !== undefined) {
    const parsed = parseMoney(input.discount);
    if (parsed === null || parsed < 0) return billFailure('INVALID_DISCOUNT');
    if (!isManagement) return billFailure('DISCOUNT');
    discount = parsed;
  }

  if (input.type === 'DINE_IN' && !input.tableNumber) return billFailure('TABLE_REQUIRED');

  const built = await buildOrderLines(prisma, input.items, actor.role);
  if (!built.ok) return built;

  if (input.clientKey) {
    const existing = await findByClientKey(input.clientKey);
    if (existing) return { ok: true, order: existing, replayed: true };
  }

  await ensureOpenBillIndex();

  const taxRate = 0.15;
  const totals = computeOrderTotals(
    built.lines.map((line) => ({ unitPrice: line.unitPrice, quantity: line.quantity })),
    discount,
    taxRate,
  );

  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const order = await prisma.$transaction(async (tx) => {
          if (input.type === 'DINE_IN' && input.tableNumber) {
            const open = await tx.order.findFirst({
              where: openBillWhere(input.tableNumber),
              select: { id: true },
            });
            if (open) throw new OpenBillExistsError();
          }

          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const seq = await tx.order.count({ where: { createdAt: { gte: today } } });

          return tx.order.create({
            data: {
              orderNumber: nextOrderNumber(seq + 1),
              type: input.type,
              status: input.autoConfirm ? 'PREPARING' : 'PENDING',
              clientKey: input.clientKey ?? null,
              tableNumber: input.tableNumber ?? null,
              staffId: actor.staffId,
              shiftId: input.shiftId,
              subtotal: totals.subtotal,
              taxRate,
              taxAmount: totals.taxAmount,
              discount: totals.discount,
              total: totals.total,
              note: input.note,
              confirmedByStaffId: input.autoConfirm ? actor.staffId : null,
              confirmedAt: input.autoConfirm ? new Date() : null,
              items: {
                create: built.lines.map((line) => ({
                  ...line,
                  status: input.autoConfirm ? 'PREPARING' : 'PENDING',
                })),
              },
            },
            include: ORDER_INCLUDE,
          });
        });

        return { ok: true, order };
      } catch (error) {
        lastError = error;
        if (error instanceof OpenBillExistsError) return billFailure('TABLE_HAS_OPEN_BILL');
        if (!isUniqueViolation(error)) break;

        if (input.clientKey) {
          const existing = await findByClientKey(input.clientKey);
          if (existing) return { ok: true, order: existing, replayed: true };
        }
        if (!uniqueTarget(error).includes('orderNumber')) break;
        // Two terminals picked the same daily sequence; take the next one.
      }
    }

    if (lastError instanceof OpenBillExistsError) return billFailure('TABLE_HAS_OPEN_BILL');
    if (isUniqueViolation(lastError) && input.type === 'DINE_IN' && input.tableNumber) {
      const open = await prisma.order.findFirst({
        where: openBillWhere(input.tableNumber),
        select: { id: true },
      });
      if (open) return billFailure('TABLE_HAS_OPEN_BILL');
    }
    console.error('Create order error:', lastError);
    return billFailure('FAILED');
  } catch (error) {
    console.error('Create order error:', error);
    return billFailure('FAILED');
  }
}

class OpenBillExistsError extends Error {}

// ============ APPEND ============

export interface AppendItemsInput {
  orderId: number;
  items: NewOrderLine[];
  clientKey?: string;
}

export type AppendItemsResult =
  | {
      ok: true;
      order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
      replayed?: boolean;
      beforeTotal: number;
      afterTotal: number;
      addedCount: number;
      statusChanged: boolean;
    }
  | BillFailure;

export async function appendItemsToBill(
  input: AppendItemsInput,
  actor: Actor,
): Promise<AppendItemsResult> {
  if (!FLOOR_ROLES.includes(actor.role)) return billFailure('NOT_AUTHORIZED');

  const built = await buildOrderLines(prisma, input.items, actor.role);
  if (!built.ok) return built;

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { payment: true, shift: { select: { status: true } } },
  });
  if (!order) return billFailure('NOT_FOUND');

  // A replay is the original successful append: answer before looking at the
  // bill's current state, which may have moved on (served, settled) since.
  if (input.clientKey) {
    const replayed = await findAppendReplay(input.clientKey);
    if (replayed) {
      const replayedOrder = await loadOrder(replayed.orderId);
      if (replayedOrder) {
        return {
          ok: true,
          order: replayedOrder,
          replayed: true,
          beforeTotal: replayed.beforeTotal,
          afterTotal: replayed.afterTotal,
          addedCount: replayed.addedCount,
          statusChanged: false,
        };
      }
    }
  }

  if (order.status === 'CANCELLED') return billFailure('CANCELLED');
  if (isSettledBill(order)) return billFailure('SETTLED');
  if (order.shift.status === 'CLOSED') return billFailure('CLOSED_SHIFT');
  if (order.paymentStatus === 'ON_TAB' && !order.customerId) return billFailure('TAB_CUSTOMER');

  // New courses join the queue when the bill is untouched or already served;
  // when the kitchen is mid-service they join the cooking stage.
  const lineStatus = order.status === 'PENDING' || order.status === 'SERVED' ? 'PENDING' : 'PREPARING';

  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({
        where: { id: input.orderId },
        include: { payment: true, shift: { select: { status: true } } },
      });
      if (!current) throw new BillError(billFailure('NOT_FOUND'));
      if (current.status === 'CANCELLED') throw new BillError(billFailure('CANCELLED'));
      if (isSettledBill(current)) throw new BillError(billFailure('SETTLED'));
      if (current.shift.status === 'CLOSED') throw new BillError(billFailure('CLOSED_SHIFT'));

      await tx.orderItem.createMany({
        data: built.lines.map((line) => ({
          orderId: input.orderId,
          menuItemId: line.menuItemId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          itemNameEn: line.itemNameEn,
          itemNameAm: line.itemNameAm,
          itemNameOm: line.itemNameOm,
          totalPrice: line.totalPrice,
          note: line.note,
          requiresTicket: line.requiresTicket,
          status: lineStatus,
        })),
      });

      const allItems = await tx.orderItem.findMany({
        where: { orderId: input.orderId },
        select: { status: true, unitPrice: true, quantity: true },
      });

      // The bill-level discount stays as it was; totals come from every line.
      const totals = computeOrderTotals(
        allItems.map((item) => ({ unitPrice: item.unitPrice, quantity: item.quantity })),
        current.discount,
        current.taxRate,
      );

      const rolled = rollUpOrderStatus(allItems);
      const from = current.status as OrderStatus;
      const statusChanged = rolled !== from && isLegalStatusTransition(from, rolled);
      const nextStatus = statusChanged ? rolled : from;
      const enteringKitchen =
        !current.confirmedAt && (nextStatus === 'PREPARING' || nextStatus === 'READY');

      const updated = await tx.order.update({
        where: { id: input.orderId },
        data: {
          subtotal: totals.subtotal,
          discount: totals.discount,
          taxAmount: totals.taxAmount,
          total: totals.total,
          status: nextStatus,
          ...(enteringKitchen
            ? { confirmedAt: new Date(), confirmedByStaffId: actor.staffId }
            : {}),
        },
        include: ORDER_INCLUDE,
      });

      const delta = roundMoney(totals.total - current.total);
      if (current.paymentStatus === 'ON_TAB' && current.customerId && delta !== 0) {
        await tx.tabEntry.create({
          data: {
            customerId: current.customerId,
            orderId: input.orderId,
            kind: 'CHARGE',
            amount: delta,
            note: `Order ${current.orderNumber}`,
            staffId: actor.staffId,
          },
        });
        await tx.customer.update({
          where: { id: current.customerId },
          data: { balance: { increment: delta } },
        });
      }

      await tx.auditLog.create({
        data: {
          staffId: actor.staffId,
          action: 'ORDER_ADD_ITEMS',
          clientKey: input.clientKey ?? null,
          entity: String(input.orderId),
          before: JSON.stringify({ total: current.total }),
          after: JSON.stringify({ total: totals.total }),
          details: JSON.stringify({
            orderId: input.orderId,
            orderNumber: current.orderNumber,
            clientKey: input.clientKey ?? null,
            addedCount: built.lines.length,
            deltaTotal: delta,
            beforeTotal: current.total,
            afterTotal: totals.total,
            statusFrom: current.status,
            statusTo: nextStatus,
          }),
        },
      });

      return {
        ok: true as const,
        order: updated,
        beforeTotal: current.total,
        afterTotal: totals.total,
        addedCount: built.lines.length,
        statusChanged: nextStatus !== current.status,
      };
    });
  } catch (error) {
    if (error instanceof BillError) return error.failure;
    // Same append retried from two terminals: the loser returns the winner.
    if (input.clientKey && isUniqueViolation(error)) {
      const replayed = await findAppendReplay(input.clientKey);
      const replayedOrder = replayed ? await loadOrder(replayed.orderId) : null;
      if (replayed && replayedOrder) {
        return {
          ok: true,
          order: replayedOrder,
          replayed: true,
          beforeTotal: replayed.beforeTotal,
          afterTotal: replayed.afterTotal,
          addedCount: replayed.addedCount,
          statusChanged: false,
        };
      }
    }
    console.error('Add items to order error:', error);
    return billFailure('FAILED');
  }
}

class BillError extends Error {
  constructor(public failure: BillFailure) {
    super(failure.error);
  }
}

interface AppendReplay {
  orderId: number;
  addedCount: number;
  beforeTotal: number;
  afterTotal: number;
}

async function findAppendReplay(clientKey: string): Promise<AppendReplay | null> {
  const entry = await prisma.auditLog.findUnique({
    where: { action_clientKey: { action: 'ORDER_ADD_ITEMS', clientKey } },
    select: { entity: true, details: true },
  });
  if (!entry?.entity) return null;
  let details: Record<string, unknown> = {};
  try {
    details = entry.details ? JSON.parse(entry.details) : {};
  } catch {
    details = {};
  }
  return {
    orderId: Number(entry.entity),
    addedCount: Number(details.addedCount ?? 0),
    beforeTotal: Number(details.beforeTotal ?? 0),
    afterTotal: Number(details.afterTotal ?? 0),
  };
}

// ============ STATUS CHANGES ============

export interface UpdateStatusInput {
  orderId: number;
  status: string;
  actor: Actor;
}

export type UpdateStatusResult =
  | { ok: true; order: NonNullable<Awaited<ReturnType<typeof loadOrder>>>; statusChanged: boolean }
  | BillFailure;

export async function updateOrderStatusRecord(
  input: UpdateStatusInput,
): Promise<UpdateStatusResult> {
  const { actor } = input;
  if (!isOrderStatus(input.status)) return billFailure('UNKNOWN_STATUS');
  if (input.status === 'CANCELLED') return billFailure('USE_CANCEL');

  const existing = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { payment: true },
  });
  if (!existing) return billFailure('NOT_FOUND');
  if (existing.status === 'CANCELLED') return billFailure('CANCELLED');

  const reopening = existing.status === 'SERVED' && input.status !== 'SERVED';
  if (reopening && isSettledBill(existing)) return billFailure('SETTLED_REOPEN');

  const data: Prisma.OrderUpdateInput = {
    status: input.status,
    items: {
      updateMany: {
        where: { orderId: input.orderId },
        data: { status: isOrderItemStatus(input.status) ? input.status : 'CANCELLED' },
      },
    },
  };

  if (input.status === 'SERVED') {
    // Only a real hand-off stamps delivery; a reopen never clears it.
    data.deliveredAt = existing.deliveredAt ?? new Date();
  }
  if (
    (input.status === 'PREPARING' || input.status === 'READY') &&
    !existing.confirmedAt
  ) {
    data.confirmedAt = new Date();
    data.confirmedBy = { connect: { id: actor.staffId } };
  }

  try {
    const order = await prisma.order.update({
      where: { id: input.orderId },
      data,
      include: ORDER_INCLUDE,
    });

    if (input.status === 'SERVED') {
      const { recordUsageForOrder } = await import('@/server/services/reconciliation.service');
      await recordUsageForOrder(input.orderId, existing.shiftId).catch((error) => {
        console.error('recordUsageForOrder failed:', error);
      });
    }

    return { ok: true, order, statusChanged: existing.status !== input.status };
  } catch (error) {
    console.error('Update order status error:', error);
    return billFailure('FAILED');
  }
}

export interface UpdateItemStatusInput {
  orderItemId: number;
  status: string;
  actor: Actor;
}

export async function updateOrderItemStatusRecord(input: UpdateItemStatusInput) {
  if (!isOrderItemStatus(input.status)) return billFailure('UNKNOWN_ITEM_STATUS');

  try {
    const item = await prisma.orderItem.update({
      where: { id: input.orderItemId },
      data: { status: input.status },
    });

    const [allItems, order] = await Promise.all([
      prisma.orderItem.findMany({ where: { orderId: item.orderId }, select: { status: true } }),
      prisma.order.findUnique({
        where: { id: item.orderId },
        select: { status: true, deliveredAt: true, shiftId: true },
      }),
    ]);

    if (order && order.status !== 'CANCELLED') {
      const rolled = rollUpOrderStatus(allItems);
      const from = order.status as OrderStatus;
      if (rolled !== from && order.status !== 'SERVED' && isLegalStatusTransition(from, rolled)) {
        await prisma.order.update({
          where: { id: item.orderId },
          data: {
            status: rolled,
            ...(rolled === 'SERVED' && !order.deliveredAt ? { deliveredAt: new Date() } : {}),
          },
        });
      }
    }

    if (input.status === 'SERVED' && order) {
      const { recordUsageForOrder } = await import('@/server/services/reconciliation.service');
      await recordUsageForOrder(item.orderId, order.shiftId).catch((error) => {
        console.error('recordUsageForOrder failed:', error);
      });
    }

    return { ok: true as const, item };
  } catch (error) {
    console.error('Update item status error:', error);
    return billFailure('FAILED');
  }
}
