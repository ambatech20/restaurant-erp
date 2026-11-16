import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import type { Role } from '@/lib/roles';
import { resolveAppendTarget, shortOrderNumber } from '@/features/orders/openBills';
import {
  appendItemsToBill,
  applyOpenBillIndex,
  createOrderRecord,
  listCashierUnpaidBills,
  listOpenBillsForTable,
  updateOrderStatusRecord,
} from './order-bill.service';

function actorOf(staff: { id: number; role: string }) {
  return { staffId: staff.id, role: staff.role as Role };
}

async function resetDatabase() {
  await prisma.tabEntry.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.inventoryTransaction.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.recipeIngredient.deleteMany();
  await prisma.menuVariant.deleteMany();
  await prisma.menuItem.deleteMany();
  await prisma.category.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.staff.deleteMany();
}

async function baseFixture() {
  const cashier = await prisma.staff.create({
    data: { name: 'Cashier', pinHash: 'x', role: 'CASHIER' },
  });
  const manager = await prisma.staff.create({
    data: { name: 'Manager', pinHash: 'x', role: 'MANAGER' },
  });
  const shift = await prisma.shift.create({
    data: { staffId: cashier.id, openingCash: 0, status: 'OPEN' },
  });
  const category = await prisma.category.create({ data: { nameEn: 'Mains' } });
  const item1 = await prisma.menuItem.create({
    data: { nameEn: 'Doro Wat', price: 200, categoryId: category.id },
  });
  const item2 = await prisma.menuItem.create({
    data: { nameEn: 'Shiro', price: 100, categoryId: category.id },
  });
  return { cashier, manager, shift, category, item1, item2 };
}

async function aBill(tableNumber: string) {
  const fixture = await baseFixture();
  const created = await createOrderRecord(
    {
      type: 'DINE_IN',
      shiftId: fixture.shift.id,
      tableNumber,
      items: [{ menuItemId: fixture.item1.id, quantity: 1 }],
    },
    actorOf(fixture.cashier),
  );
  if (!created.ok) throw new Error(`fixture create failed: ${created.code}`);
  return { ...fixture, order: created.order };
}

beforeEach(resetDatabase);

describe('one open bill per table — appends', () => {
  it('appends to the table’s open bill instead of opening a second order', async () => {
    const { cashier, manager, shift, item1, item2 } = await baseFixture();

    const created = await createOrderRecord(
      {
        type: 'DINE_IN',
        shiftId: shift.id,
        tableNumber: 'T1',
        discount: 50,
        items: [{ menuItemId: item1.id, quantity: 1 }],
      },
      actorOf(manager),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.order.discount).toBe(50);
    expect(created.order.total).toBe(172.5); // (200 - 50) * 1.15

    const appended = await appendItemsToBill(
      { orderId: created.order.id, items: [{ menuItemId: item2.id, quantity: 2 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const orders = await prisma.order.findMany({ where: { tableNumber: 'T1' } });
    expect(orders).toHaveLength(1);

    const order = await prisma.order.findUnique({
      where: { id: created.order.id },
      include: { items: true },
    });
    expect(order).not.toBeNull();
    // Exactly the added lines: +200 subtotal, bill-level discount untouched.
    expect(order!.items).toHaveLength(2);
    expect(order!.discount).toBe(50);
    expect(order!.subtotal).toBe(400);
    expect(order!.taxAmount).toBe(52.5); // (400 - 50) * 0.15
    expect(order!.total).toBe(402.5);
    expect(appended.afterTotal - appended.beforeTotal).toBe(230); // 402.5 - 172.5
  });

  it('makes the staff pick when a legacy table has two open bills', async () => {
    const { cashier, shift, item1 } = await baseFixture();

    const created = await createOrderRecord(
      {
        type: 'DINE_IN',
        shiftId: shift.id,
        tableNumber: 'T2',
        items: [{ menuItemId: item1.id, quantity: 1 }],
      },
      actorOf(cashier),
    );
    if (!created.ok) throw new Error(created.code);

    // Two open bills predate the constraint; simulate the legacy row directly.
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "Order_open_bill_per_table"');
    try {
      await prisma.order.create({
        data: {
          orderNumber: 'LEGACY-T2',
          type: 'DINE_IN',
          status: 'PENDING',
          tableNumber: 'T2',
          staffId: cashier.id,
          shiftId: shift.id,
          subtotal: 200,
          taxAmount: 30,
          total: 230,
          items: {
            create: [
              {
                menuItemId: item1.id,
                quantity: 1,
                unitPrice: 200,
                itemNameEn: 'Doro Wat',
                totalPrice: 200,
              },
            ],
          },
        },
      });

      const bills = await listOpenBillsForTable('T2');
      expect(bills).toHaveLength(2);

      // Nothing is auto-selected; the staff must choose one explicitly.
      expect(resolveAppendTarget(bills, null)).toBeNull();
      expect(resolveAppendTarget(bills, bills[1])).toBe(bills[1]);
      // A target that disappeared while two bills remain is dropped.
      expect(resolveAppendTarget(bills, { ...bills[1], id: 999_999 })).toBeNull();
      expect(shortOrderNumber(bills[0].orderNumber)).toBe(
        bills[0].orderNumber.split('-').pop(),
      );
    } finally {
      await prisma.order.deleteMany({ where: { orderNumber: 'LEGACY-T2' } });
      await applyOpenBillIndex();
    }
  });

  it('pulls a SERVED unpaid bill back into the kitchen, keeping deliveredAt', async () => {
    const { cashier, item2, order } = await aBill('T3');

    // Kitchen progress is not a cashier queue item yet.
    expect((await listCashierUnpaidBills()).map((bill) => bill.id)).not.toContain(order.id);

    const served = await updateOrderStatusRecord({
      orderId: order.id,
      status: 'SERVED',
      actor: actorOf(cashier),
    });
    expect(served.ok).toBe(true);

    const deliveredAt = (
      await prisma.order.findUnique({ where: { id: order.id } })
    )!.deliveredAt;
    expect(deliveredAt).not.toBeNull();
    expect((await listCashierUnpaidBills()).map((bill) => bill.id)).toContain(order.id);

    const appended = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.order.status).toBe('PREPARING');

    const lines = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      orderBy: { id: 'asc' },
    });
    expect(lines.map((line) => line.status)).toEqual(['SERVED', 'PENDING']);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.deliveredAt!.getTime()).toBe(deliveredAt!.getTime());
    // deliveredAt keeps the reopened bill in the cashier queue.
    expect((await listCashierUnpaidBills()).map((bill) => bill.id)).toContain(order.id);
  });

  it('refuses to modify a settled bill', async () => {
    const { cashier, item2, shift, order } = await aBill('T4');

    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'PAID' },
    });
    await prisma.payment.create({
      data: {
        orderId: order.id,
        method: 'CASH',
        amountPaid: order.total,
        amountDue: order.total,
        shiftId: shift.id,
      },
    });

    const appended = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.code).toBe('SETTLED');

    const after = await prisma.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    expect(after!.items).toHaveLength(1);
    expect(after!.total).toBe(order.total);
  });

  it('refuses a bill that belongs to a closed shift', async () => {
    const { cashier, item2, shift, order } = await aBill('T5');
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'CLOSED' } });

    const appended = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.code).toBe('CLOSED_SHIFT');

    const after = await prisma.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    expect(after!.items).toHaveLength(1);
    expect(after!.total).toBe(order.total);
  });

  it('adds a replayed clientKey exactly once', async () => {
    const { cashier, item2, order } = await aBill('T6');
    const clientKey = 'append-key-1';

    const first = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }], clientKey },
      actorOf(cashier),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBeFalsy();

    const second = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }], clientKey },
      actorOf(cashier),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.addedCount).toBe(first.addedCount);

    const lines = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(lines).toHaveLength(2); // original + one appended line
    const audit = await prisma.auditLog.count({
      where: { action: 'ORDER_ADD_ITEMS', clientKey },
    });
    expect(audit).toBe(1);

    // Offline replay must still succeed if the bill moved on (settled) since.
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
    const replayedAfterSettle = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }], clientKey },
      actorOf(cashier),
    );
    expect(replayedAfterSettle.ok).toBe(true);
    if (replayedAfterSettle.ok) expect(replayedAfterSettle.replayed).toBe(true);
  });
});

describe('one open bill per table — concurrency and stock', () => {
  it('lets at most one terminal open a bill for the same table', async () => {
    const { cashier, shift, item1 } = await baseFixture();

    const payload = {
      type: 'DINE_IN',
      shiftId: shift.id,
      tableNumber: 'T7',
      items: [{ menuItemId: item1.id, quantity: 1 }],
    };

    const results = await Promise.allSettled([
      createOrderRecord({ ...payload, clientKey: 'race-a' }, actorOf(cashier)),
      createOrderRecord({ ...payload, clientKey: 'race-b' }, actorOf(cashier)),
    ]);

    const ok = results.filter(
      (result) => result.status === 'fulfilled' && result.value.ok,
    );
    expect(ok).toHaveLength(1);

    const open = await prisma.order.findMany({
      where: {
        tableNumber: 'T7',
        type: 'DINE_IN',
        status: { not: 'CANCELLED' },
        paymentStatus: { in: ['UNPAID', 'ON_TAB'] },
      },
    });
    expect(open).toHaveLength(1);

    const rejected = results.filter(
      (result) => result.status === 'fulfilled' && !result.value.ok,
    );
    for (const result of rejected) {
      if (result.status !== 'fulfilled' || result.value.ok) continue;
      expect(['TABLE_HAS_OPEN_BILL', 'FAILED']).toContain(result.value.code);
    }
  });

  it('deducts stock only for the lines added after a reopen', async () => {
    const { cashier, shift, item1 } = await baseFixture();
    const stock = await prisma.inventoryItem.create({
      data: { nameEn: 'Chicken', unit: 'g', currentStock: 1000 },
    });
    await prisma.recipeIngredient.create({
      data: {
        menuItemId: item1.id,
        inventoryItemId: stock.id,
        quantity: 100,
        unit: 'g',
      },
    });

    const created = await createOrderRecord(
      {
        type: 'DINE_IN',
        shiftId: shift.id,
        tableNumber: 'T8',
        items: [{ menuItemId: item1.id, quantity: 1 }],
      },
      actorOf(cashier),
    );
    if (!created.ok) throw new Error(created.code);

    await updateOrderStatusRecord({
      orderId: created.order.id,
      status: 'SERVED',
      actor: actorOf(cashier),
    });
    expect((await prisma.inventoryItem.findUnique({ where: { id: stock.id } }))!.currentStock).toBe(900);

    const appended = await appendItemsToBill(
      { orderId: created.order.id, items: [{ menuItemId: item1.id, quantity: 2 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(true);

    await updateOrderStatusRecord({
      orderId: created.order.id,
      status: 'SERVED',
      actor: actorOf(cashier),
    });

    // Re-serving the reopened bill must only consume the new line (2 × 100 g).
    expect((await prisma.inventoryItem.findUnique({ where: { id: stock.id } }))!.currentStock).toBe(700);
    const usage = await prisma.inventoryTransaction.findMany({ where: { inventoryItemId: stock.id } });
    expect(usage).toHaveLength(2);
    expect(usage.reduce((sum, row) => sum + row.quantity, 0)).toBe(-300);
  });

  it('adds exactly the delta to a credit customer’s tab', async () => {
    const { cashier, item2, order } = await aBill('T9');
    const customer = await prisma.customer.create({ data: { name: 'Abebe', balance: 0 } });
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'ON_TAB', customerId: customer.id },
    });

    const appended = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item2.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const delta = appended.afterTotal - appended.beforeTotal;
    expect(delta).toBe(115); // (300 - 0) * 1.15 − 230
    const after = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(after!.balance).toBe(delta);

    const charges = await prisma.tabEntry.findMany({ where: { customerId: customer.id } });
    expect(charges).toHaveLength(1);
    expect(charges[0].kind).toBe('CHARGE');
    expect(charges[0].amount).toBe(delta);
  });
});

describe('append validation order', () => {
  it('rejects bad carts before touching the bill', async () => {
    const { cashier, item1, order } = await aBill('V1');

    const empty = await appendItemsToBill(
      { orderId: order.id, items: [] },
      actorOf(cashier),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('EMPTY_ITEMS');

    const zero = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item1.id, quantity: 0 }] },
      actorOf(cashier),
    );
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.code).toBe('INVALID_QUANTITY');

    const override = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item1.id, quantity: 1, overridePrice: 1 }] },
      actorOf(cashier),
    );
    expect(override.ok).toBe(false);
    if (!override.ok) expect(override.code).toBe('PRICE_OVERRIDE');

    const missing = await appendItemsToBill(
      { orderId: 999_999, items: [{ menuItemId: item1.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');
  });

  it('refuses cancelled bills and non-floor roles', async () => {
    const { cashier, item1, order } = await aBill('V2');

    const kitchen = await prisma.staff.create({
      data: { name: 'Cook', pinHash: 'x', role: 'KITCHEN' },
    });
    const unauthorized = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item1.id, quantity: 1 }] },
      actorOf(kitchen),
    );
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.code).toBe('NOT_AUTHORIZED');

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', items: { updateMany: { where: {}, data: { status: 'CANCELLED' } } } },
    });
    const cancelled = await appendItemsToBill(
      { orderId: order.id, items: [{ menuItemId: item1.id, quantity: 1 }] },
      actorOf(cashier),
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe('CANCELLED');
  });
});

describe('open bill selection', () => {
  it('preselects the only open bill and clears a vanished target', () => {
    const a = { id: 1, orderNumber: '20261116-001', status: 'PENDING', total: 230 };
    const b = { id: 2, orderNumber: '20261116-002', status: 'SERVED', total: 460 };

    expect(resolveAppendTarget([], null)).toBeNull();
    expect(resolveAppendTarget([a], null)).toBe(a);
    expect(resolveAppendTarget([a], b)).toBe(a); // sole survivor is unambiguous
    expect(resolveAppendTarget([a, b], null)).toBeNull();
    expect(resolveAppendTarget([a, b], b)).toBe(b);
    expect(resolveAppendTarget([a, b], { ...b, id: 99 })).toBeNull();
    expect(shortOrderNumber('20261116-007')).toBe('007');
  });
});

describe('status rules', () => {
  it('refuses to reopen a settled bill into the kitchen', async () => {
    const { cashier, shift, order } = await aBill('S1');
    await prisma.payment.create({
      data: {
        orderId: order.id,
        method: 'CASH',
        amountPaid: order.total,
        amountDue: order.total,
        shiftId: shift.id,
      },
    });
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
    await updateOrderStatusRecord({
      orderId: order.id,
      status: 'SERVED',
      actor: actorOf(cashier),
    });

    const reopen = await updateOrderStatusRecord({
      orderId: order.id,
      status: 'PREPARING',
      actor: actorOf(cashier),
    });
    expect(reopen.ok).toBe(false);
    if (!reopen.ok) expect(reopen.code).toBe('SETTLED_REOPEN');
  });
});
