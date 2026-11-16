'use server';

import { prisma } from '@/lib/prisma';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { authorize, ALL_ROLES, FLOOR_ROLES, MANAGEMENT_ROLES } from '@/lib/auth';
import { emitOutboundEvent } from '@/lib/integrations/outbox';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_STATUSES,
  READY_FOR_PICKUP,
} from '@/lib/orderStatus';
import {
  BILL_ERROR_MESSAGES,
  appendItemsToBill,
  createOrderRecord,
  listCashierUnpaidBills,
  listOpenBillsForTable,
  updateOrderItemStatusRecord,
  updateOrderStatusRecord,
  type BillErrorCode,
  type NewOrderLine,
} from '@/server/services/order-bill.service';

type BillOrder = Extract<Awaited<ReturnType<typeof createOrderRecord>>, { ok: true }>['order'];
type ActionFailure = { success: false; code: BillErrorCode; error: string };

interface CreateOrderInput {
  type: string;
  tableNumber?: string;
  note?: string;
  discount?: number;
  clientKey?: string;
  autoConfirm?: boolean;
  items: NewOrderLine[];
}

/**
 * Server errors are stable codes; the till renders them in the active
 * language. The English text is the fallback for API/offline callers.
 */
async function localizedError(code: BillErrorCode): Promise<string> {
  const fallback = BILL_ERROR_MESSAGES[code] ?? BILL_ERROR_MESSAGES.FAILED;
  try {
    const t = await getTranslations('posErrors');
    return t.has(code) ? t(code) : fallback;
  } catch {
    return fallback;
  }
}

async function failure(code: BillErrorCode) {
  return { success: false as const, code, error: await localizedError(code) };
}

export async function createOrder(input: CreateOrderInput): Promise<
  ActionFailure | { success: true; order: BillOrder; replayed?: boolean }
> {
  const auth = await authorize(FLOOR_ROLES);
  if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

  const cookieStore = await cookies();
  const shiftId = parseInt(cookieStore.get('shiftId')?.value || '0', 10);

  // Servers may only open bills on their own tables; unassigned tables are shared.
  if (auth.session.role === 'WAITER' && input.type === 'DINE_IN' && input.tableNumber) {
    const tableNumber = Number(input.tableNumber);
    if (Number.isInteger(tableNumber)) {
      const table = await prisma.diningTable.findUnique({
        where: { number: tableNumber },
        select: { assignedStaffId: true },
      });
      if (table?.assignedStaffId && table.assignedStaffId !== auth.session.staffId) {
        return failure('TABLE_NOT_YOURS');
      }
    }
  }

  const result = await createOrderRecord(
    { ...input, shiftId },
    { staffId: auth.session.staffId, role: auth.session.role },
  );
  if (!result.ok) return failure(result.code);

  const { order } = result;
  await emitOutboundEvent(prisma, 'order.created', order.id, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    type: order.type,
    status: order.status,
    tableNumber: order.tableNumber ?? null,
    subtotal: order.subtotal,
    taxRate: order.taxRate,
    taxAmount: order.taxAmount,
    discount: order.discount,
    total: order.total,
    staffId: order.staffId,
    shiftId: order.shiftId,
    createdAt: order.createdAt,
  });

  if (result.replayed) return { success: true as const, order, replayed: true };

  if (input.autoConfirm) {
    await emitOutboundEvent(prisma, 'order.status.changed', order.id, {
      orderId: order.id,
      newStatus: order.status,
      updatedAt: new Date().toISOString(),
    });
  }

  return { success: true as const, order };
}

/** Open bills for a table — the till's append targets. */
export async function getOpenBillsForTable(tableNumber: string) {
  const auth = await authorize(FLOOR_ROLES);
  if (!auth.ok) return { success: false, error: auth.error, bills: [] };

  if (!tableNumber) return { success: true, bills: [] };
  try {
    const bills = await listOpenBillsForTable(tableNumber);
    return { success: true, bills };
  } catch (error) {
    console.error('Get open bills error:', error);
    return { success: false, error: BILL_ERROR_MESSAGES.FAILED, bills: [] };
  }
}

export async function updateOrderStatus(orderId: number, status: string) {
  const auth = await authorize(ALL_ROLES);
  if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

  const result = await updateOrderStatusRecord({
    orderId,
    status,
    actor: { staffId: auth.session.staffId, role: auth.session.role },
  });
  if (!result.ok) return failure(result.code);

  if (result.statusChanged) {
    await emitOutboundEvent(prisma, 'order.status.changed', orderId, {
      orderId,
      newStatus: result.order.status,
      updatedAt: new Date().toISOString(),
    });
  }

  return { success: true as const, order: result.order, statusChanged: result.statusChanged };
}

export async function updateOrderItemStatus(orderItemId: number, status: string) {
  const auth = await authorize(ALL_ROLES);
  if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

  const result = await updateOrderItemStatusRecord({
    orderItemId,
    status,
    actor: { staffId: auth.session.staffId, role: auth.session.role },
  });
  if (!result.ok) return failure(result.code);

  return { success: true as const, item: result.item };
}

export async function getUnpaidOrders() {
  try {
    const auth = await authorize(ALL_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error, orders: [] };

    // Cashier queue: unpaid bills that reached the guest. Bills still in the
    // kitchen stay on the kitchen screens.
    const orders = await listCashierUnpaidBills();

    return { success: true, orders };
  } catch (error) {
    console.error('Get unpaid orders error:', error);
    return { success: false, error: 'Failed to fetch unpaid orders', orders: [] };
  }
}

export async function getReadyOrders() {
  try {
    const auth = await authorize(ALL_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error, orders: [] };

    const orders = await prisma.order.findMany({
      where: {
        // "READY" = kitchen finished, waiting to be picked up / served.
        status: READY_FOR_PICKUP,
        // Servers only see their own pickups; the cashier and managers see all.
        ...(auth.session.role === 'WAITER' ? { staffId: auth.session.staffId } : {}),
      },
      include: {
        items: true,
        staff: { select: { name: true, nameAm: true, nameOm: true, role: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return { success: true, orders };
  } catch (error) {
    console.error('Get ready orders error:', error);
    return { success: false, error: 'Failed to fetch ready orders', orders: [] };
  }
}

export async function getActiveOrders() {
  try {
    const auth = await authorize(ALL_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error, orders: [] };

    const orders = await prisma.order.findMany({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
      },
      include: {
        items: true,
        staff: { select: { name: true, nameAm: true, nameOm: true } },
        payment: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return { success: true, orders };
  } catch (error) {
    console.error('Get active orders error:', error);
    return { success: false, error: 'Failed to fetch orders', orders: [] };
  }
}

export async function getOrderHistory(page: number = 1, limit: number = 20, status?: string) {
  try {
    const auth = await authorize(MANAGEMENT_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error, orders: [], total: 0, pages: 0 };

    if (status && !(ORDER_STATUSES as readonly string[]).includes(status)) {
      return { success: false, error: `Unknown order status: ${status}`, orders: [], total: 0, pages: 0 };
    }

    const where = status ? { status } : {};
    const [orders, total] = await Promise.all([      prisma.order.findMany({
        where,
        include: {
          items: true,
          staff: { select: { name: true, nameAm: true, nameOm: true } },
          payment: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return { success: true, orders, total, pages: Math.ceil(total / limit) };
  } catch (error) {
    console.error('Get order history error:', error);
    return { success: false, error: 'Failed to fetch order history', orders: [], total: 0, pages: 0 };
  }
}

export async function startOrderInKitchen(orderId: number) {
  try {
    const auth = await authorize(ALL_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, payment: true } });
    if (!order) return { success: false, error: 'Order not found' };
    if (order.status === 'READY' || order.status === 'SERVED' || order.status === 'CANCELLED') {
      return { success: false, error: 'Order cannot be started' };
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PREPARING',
        confirmedByStaffId: auth.session.staffId,
        confirmedAt: order.confirmedAt ?? new Date(),
        items: { updateMany: { where: { orderId }, data: { status: 'PREPARING' } } },
      },
    });

    await emitOutboundEvent(prisma, 'order.status.changed', orderId, {
      orderId,
      newStatus: 'PREPARING',
      updatedAt: new Date().toISOString(),
    });

    return { success: true };
  } catch (error) {
    console.error('Start order in kitchen error:', error);
    return { success: false, error: 'Failed to start order' };
  }
}

export async function confirmOrderAction(orderId: number) {
  return startOrderInKitchen(orderId);
}

export async function markOrderServed(orderId: number) {
  // Same path as a status change: stamps deliveredAt and records stock for the
  // lines that are being handed over.
  return updateOrderStatus(orderId, 'SERVED');
}

export async function cancelOrder(orderId: number, reason?: string) {
  try {
    const auth = await authorize(ALL_ROLES);
    if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

    if (!['ADMIN', 'MANAGER', 'KITCHEN'].includes(auth.session.role)) {
      return { success: false, error: 'Not authorized to cancel' };
    }

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payment: true } });
    if (!order) return { success: false, error: 'Order not found' };
    if (order.status === 'CANCELLED') return { success: true };
    if (order.payment) return { success: false, error: 'Cannot cancel a paid order' };
    if (order.paymentStatus === 'ON_TAB') {
      return { success: false, error: 'This bill sits on a customer tab — settle the tab before cancelling' };
    }

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        items: { updateMany: { where: { orderId }, data: { status: 'CANCELLED' } } },
        note: reason ? `${order.note ?? ''} [CANCELLED: ${reason}]`.trim() : order.note,
      },
    });

    await prisma.auditLog.create({
      data: {
        staffId: auth.session.staffId,
        action: 'ORDER_CANCEL',
        details: JSON.stringify({ orderId, orderNumber: order.orderNumber, reason: reason ?? null, paymentStatus: order.payment ? 'PAID' : 'UNPAID' }),
      },
    });

    await emitOutboundEvent(prisma, 'order.status.changed', orderId, {
      orderId,
      newStatus: 'CANCELLED',
      updatedAt: new Date().toISOString(),
    });

    return { success: true };
  } catch (error) {
    console.error('Cancel order error:', error);
    return { success: false, error: 'Failed to cancel order' };
  }
}

/**
 * Append a second course (or any extra round) to the table's open bill.
 * Kept under the original name so the offline queue can replay it unchanged.
 */
export async function addItemsToOrder(
  orderId: number,
  items: NewOrderLine[],
  clientKey?: string,
): Promise<
  ActionFailure | { success: true; order: BillOrder; replayed: boolean; statusChanged: boolean }
> {
  const auth = await authorize(FLOOR_ROLES);
  if (!auth.ok) return { success: false as const, code: 'NOT_AUTHORIZED' as const, error: auth.error };

  const result = await appendItemsToBill(
    { orderId, items, clientKey },
    { staffId: auth.session.staffId, role: auth.session.role },
  );
  if (!result.ok) return failure(result.code);

  if (!result.replayed) {
    await emitOutboundEvent(prisma, 'order.items.added', orderId, {
      orderId,
      orderNumber: result.order.orderNumber,
      tableNumber: result.order.tableNumber ?? null,
      addedCount: result.addedCount,
      deltaTotal: result.afterTotal - result.beforeTotal,
      total: result.afterTotal,
      status: result.order.status,
    });
    if (result.statusChanged) {
      await emitOutboundEvent(prisma, 'order.status.changed', orderId, {
        orderId,
        newStatus: result.order.status,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return {
    success: true as const,
    order: result.order,
    replayed: result.replayed ?? false,
    statusChanged: result.statusChanged,
  };
}
