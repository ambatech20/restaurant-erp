'use server';

import { prisma } from '@/lib/prisma';
import { authorize, FLOOR_ROLES, MANAGEMENT_ROLES } from '@/lib/auth';
import { TABLE_COUNT, allTableNumbers } from '@/lib/tables';

export interface TableAssignment {
  number: number;
  assignedStaffId: number | null;
  staffName: string | null;
}

export async function getTableAssignments() {
  const auth = await authorize(MANAGEMENT_ROLES);
  if (!auth.ok) return { success: false as const, error: auth.error, tables: [] as TableAssignment[] };

  try {
    const rows = await prisma.diningTable.findMany({
      include: { assignedStaff: { select: { id: true, name: true } } },
    });
    const byNumber = new Map(rows.map((row) => [row.number, row]));

    const tables = allTableNumbers().map((raw) => {
      const number = Number(raw);
      const row = byNumber.get(number);
      return {
        number,
        assignedStaffId: row?.assignedStaffId ?? null,
        staffName: row?.assignedStaff?.name ?? null,
      };
    });

    return { success: true as const, tables };
  } catch (error) {
    console.error('Get table assignments error:', error);
    return { success: false as const, error: 'Failed to fetch tables', tables: [] as TableAssignment[] };
  }
}

export async function assignTable(number: number, staffId: number | null) {
  const auth = await authorize(MANAGEMENT_ROLES);
  if (!auth.ok) return { success: false as const, error: auth.error };

  if (!Number.isInteger(number) || number < 1 || number > TABLE_COUNT) {
    return { success: false as const, error: 'Unknown table' };
  }

  try {
    if (staffId !== null) {
      const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { isActive: true } });
      if (!staff || !staff.isActive) return { success: false as const, error: 'That employee is inactive' };
    }

    await prisma.diningTable.upsert({
      where: { number },
      create: { number, assignedStaffId: staffId },
      update: { assignedStaffId: staffId },
    });

    return { success: true as const };
  } catch (error) {
    console.error('Assign table error:', error);
    return { success: false as const, error: 'Failed to assign table' };
  }
}

/**
 * Tables this staff member may open bills on. Waiters see their own tables plus
 * tables nobody owns; everyone else sees all of them.
 */
export async function getMyTables() {
  const auth = await authorize(FLOOR_ROLES);
  if (!auth.ok) return { success: false as const, error: auth.error, tables: allTableNumbers() };

  if (auth.session.role !== 'WAITER') {
    return { success: true as const, tables: allTableNumbers() };
  }

  try {
    const rows = await prisma.diningTable.findMany({
      select: { number: true, assignedStaffId: true },
    });
    const ownedByOthers = new Set(
      rows
        .filter((row) => row.assignedStaffId && row.assignedStaffId !== auth.session.staffId)
        .map((row) => row.number)
    );

    const tables = allTableNumbers().filter((raw) => !ownedByOthers.has(Number(raw)));
    return { success: true as const, tables };
  } catch (error) {
    console.error('Get my tables error:', error);
    return { success: false as const, error: 'Failed to fetch tables', tables: allTableNumbers() };
  }
}
