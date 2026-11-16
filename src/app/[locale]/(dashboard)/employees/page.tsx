'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { getEmployees, createEmployee, updateEmployee, deleteEmployee, paySalary, getSalaryHistory } from '@/features/employees/actions';
import { getTableAssignments, assignTable, type TableAssignment } from '@/features/tables/actions';
import { formatPrice, getLocaleName } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/utils';
import { roundMoney } from '@/lib/money';
import { useAsyncEffect } from '@/hooks/useAsyncEffect';
import Icon from '@/components/shared/Icon';

interface Employee {
  id: number; name: string; nameAm: string | null; nameOm: string | null; role: string; isActive: boolean;
  phone: string | null; salary: number; bankName: string | null; bankAccount: string | null;
  startDate: string; createdAt: string;
  salaryPayments: { id: number; netPay: number; month: string; paidAt: string | null }[];
  _count: { shifts: number; orders: number };
}

interface SalaryRecord {
  id: number; staffId: number; amount: number; bonus: number; deductions: number;
  netPay: number; month: string; status: string; paidAt: string | null;
  staff: { name: string; nameAm: string | null; nameOm?: string | null; role: string };
}

export default function EmployeesPage() {
  const t = useTranslations('employees');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [salaryHistory, setSalaryHistory] = useState<SalaryRecord[]>([]);
  const [tableAssignments, setTableAssignments] = useState<TableAssignment[]>([]);
  const [tab, setTab] = useState<'list' | 'payroll' | 'tables'>('list');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showPayForm, setShowPayForm] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', nameAm: '', nameOm: '', role: 'CASHIER', phone: '', salary: '', bankName: '', bankAccount: '', pin: '' });
  const [form, setForm] = useState({ name: '', nameAm: '', nameOm: '', pin: '', role: 'CASHIER', phone: '', salary: '', bankName: '', bankAccount: '' });
  const [payForm, setPayForm] = useState({ bonus: '0', deductions: '0', absentDays: '0', note: '' });

  const loadData = async () => {
    const [empRes, salRes, tableRes] = await Promise.all([getEmployees(), getSalaryHistory(), getTableAssignments()]);
    if (empRes.success) setEmployees(empRes.employees as Employee[]);
    if (salRes.success) setSalaryHistory(salRes.payments as SalaryRecord[]);
    if (tableRes.success) setTableAssignments(tableRes.tables);
  };

  useAsyncEffect(loadData, []);

  const handleAssignTable = async (number: number, staffId: number | null) => {
    const res = await assignTable(number, staffId);
    if (!res.success) {
      alert(res.error || 'Failed to assign table');
      return;
    }
    setTableAssignments((prev) =>
      prev.map((row) =>
        row.number === number
          ? { ...row, assignedStaffId: staffId, staffName: employees.find((e) => e.id === staffId)?.name ?? null }
          : row
      )
    );
  };

  const handleAdd = async () => {
    if (!form.name) return;
    // PIN is required for all roles except WAITER
    if (form.role !== 'WAITER' && !form.pin) return;
    await createEmployee({
      name: form.name, nameAm: form.nameAm || undefined, nameOm: form.nameOm || undefined,
      pin: form.pin || '0000', // WAITER gets a dummy PIN they'll never use
      role: form.role, phone: form.phone || undefined, salary: parseFloat(form.salary) || 0,
      bankName: form.bankName || undefined, bankAccount: form.bankAccount || undefined,
    });
    setForm({ name: '', nameAm: '', nameOm: '', pin: '', role: 'CASHIER', phone: '', salary: '', bankName: '', bankAccount: '' });
    setShowAddForm(false);
    loadData();
  };

  const handleToggleActive = async (emp: Employee) => {
    await updateEmployee(emp.id, { isActive: !emp.isActive });
    loadData();
  };

  const startEdit = (emp: Employee) => {
    setShowPayForm(null);
    setEditingId(emp.id);
    setEditForm({
      name: emp.name,
      nameAm: emp.nameAm ?? '',
      nameOm: emp.nameOm ?? '',
      role: emp.role,
      phone: emp.phone ?? '',
      salary: String(emp.salary ?? 0),
      bankName: emp.bankName ?? '',
      bankAccount: emp.bankAccount ?? '',
      pin: '',
    });
  };

  const handleSaveEdit = async (emp: Employee) => {
    if (!editForm.name) return;
    if (editForm.pin && !/^\d{4,8}$/.test(editForm.pin)) {
      alert(t('pinInvalid'));
      return;
    }
    const res = await updateEmployee(emp.id, {
      name: editForm.name,
      nameAm: editForm.nameAm,
      nameOm: editForm.nameOm,
      role: editForm.role,
      phone: editForm.phone,
      salary: parseFloat(editForm.salary) || 0,
      bankName: editForm.bankName,
      bankAccount: editForm.bankAccount,
      ...(editForm.pin ? { pin: editForm.pin } : {}),
    });
    if (!res.success) {
      alert(res.error || 'Failed to update employee');
      return;
    }
    setEditingId(null);
    loadData();
  };

  const handleDelete = async (emp: Employee) => {
    if (!window.confirm(`Are you sure you want to permanently delete ${emp.name}?`)) return;
    const res = await deleteEmployee(emp.id);
    if (!res.success) {
      alert(res.error || 'Failed to delete employee.');
    } else {
      loadData();
    }
  };

  const handlePay = async (emp: Employee) => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await paySalary({
      staffId: emp.id, amount: emp.salary, month,
      bonus: parseFloat(payForm.bonus) || 0, deductions: parseFloat(payForm.deductions) || 0,
      absentDays: parseInt(payForm.absentDays) || 0,
      note: payForm.note || undefined,
    });
    setShowPayForm(null);
    setPayForm({ bonus: '0', deductions: '0', absentDays: '0', note: '' });
    loadData();
  };

  const roles = ['ADMIN', 'MANAGER', 'CASHIER', 'KITCHEN', 'WAITER'];
  const waiters = employees.filter((emp) => emp.role === 'WAITER');

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 'var(--space-5)' }}>
        <div className="page-title">{t('title')}</div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <button className={`btn ${tab === 'list' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('list')}>
            <Icon name="employees" size={15} /> {t('totalEmployees')}
          </button>
          <button className={`btn ${tab === 'payroll' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('payroll')}>
            <Icon name="coins" size={15} /> {t('payroll')}
          </button>
          <button className={`btn ${tab === 'tables' ? 'btn-primary' : 'btn-secondary'} btn-sm`} onClick={() => setTab('tables')}>
            <Icon name="menu" size={15} /> {t('tables')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddForm(!showAddForm)}>+ {t('addEmployee')}</button>
        </div>
      </div>

      {/* Add Employee Form */}
      {showAddForm && (
        <div className="glass-card-static panel" style={{ marginBottom: 'var(--space-5)' }}>
          <h3 className="section-title" style={{ marginBottom: 'var(--space-4)' }}>{t('addEmployee')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('name')} *</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('nameAm')}</label>
              <input className="input" value={form.nameAm} onChange={(e) => setForm({ ...form, nameAm: e.target.value })} placeholder="አማርኛ ስም" /></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('nameOm')}</label>
              <input className="input" value={form.nameOm} onChange={(e) => setForm({ ...form, nameOm: e.target.value })} placeholder="Maqaa Afaan Oromoo" /></div>
            {form.role !== 'WAITER' && (
              <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pin')} *</label>
                <input className="input" type="password" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} maxLength={4} /></div>
            )}
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('role')}</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]?.en || r}</option>)}
              </select></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('phone')}</label>
              <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('salaryAmount')}</label>
              <input className="input" type="number" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} /></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}><Icon name="bank" size={13} /> Bank Name</label>
              <input className="input" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} placeholder="e.g. CBE, Awash" /></div>
            <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}><Icon name="hash" size={13} /> Bank Account</label>
              <input className="input" value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} placeholder="Account number" /></div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <button className="btn btn-primary" onClick={handleAdd}>{tc('save')}</button>
            <button className="btn btn-ghost" onClick={() => setShowAddForm(false)}>{tc('cancel')}</button>
          </div>
        </div>
      )}

      {tab === 'list' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--space-4)' }}>
          {employees.map((emp) => {
            const roleLabel = locale === 'am' ? ROLE_LABELS[emp.role]?.am : locale === 'om' ? ROLE_LABELS[emp.role]?.om : ROLE_LABELS[emp.role]?.en;
            const lastPay = emp.salaryPayments[0];
            return (
              <div key={emp.id} className="glass-card-static panel" style={{ opacity: emp.isActive ? 1 : 0.5 }}>
                <div className="flex-between" style={{ marginBottom: 'var(--space-3)' }}>
                  <div>
                    <h3 style={{ fontSize: '1rem' }}>{getLocaleName(emp.name, emp.nameAm, locale, emp.nameOm)}</h3>
                    <span className={`badge ${emp.role === 'ADMIN' ? 'badge-danger' : emp.role === 'MANAGER' ? 'badge-preparing' : emp.role === 'CASHIER' ? 'badge-pending' : emp.role === 'WAITER' ? 'badge-served' : 'badge-ready'}`}>
                      {roleLabel || emp.role}
                    </span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {emp.role === 'ADMIN' ? <Icon name="crown" size={24} /> : emp.role === 'MANAGER' ? <Icon name="orders" size={24} /> : emp.role === 'CASHIER' ? <Icon name="cashier" size={24} /> : emp.role === 'WAITER' ? <Icon name="menu" size={24} /> : <Icon name="kitchen" size={24} />}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', fontSize: '0.8125rem' }}>
                  {emp.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ color: 'var(--text-muted)' }}><Icon name="phone" size={14} /></span> {emp.phone}</div>}
                  <div><span style={{ color: 'var(--text-muted)' }}>{t('salary')}:</span> <span style={{ color: 'var(--accent-gold)', fontWeight: 600 }}>{formatPrice(emp.salary, locale)}</span></div>
                  {(emp.bankName || emp.bankAccount) && (
                    <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ color: 'var(--text-muted)' }}><Icon name="bank" size={14} /></span> {emp.bankName} {emp.bankAccount ? `— ${emp.bankAccount}` : ''}</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ color: 'var(--text-muted)' }}><Icon name="chartBar" size={14} /></span> {emp._count.orders} orders</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ color: 'var(--text-muted)' }}><Icon name="clock" size={14} /></span> {emp._count.shifts} shifts</div>
                </div>

                {lastPay && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-3)', padding: 'var(--space-2)', background: 'var(--bg-input)', borderRadius: 'var(--radius-xs)' }}>
                    {t('lastPayment')}: {formatPrice(lastPay.netPay, locale)} ({lastPay.month})
                  </div>
                )}

                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setShowPayForm(emp.id)}><Icon name="coins" size={15} /> {t('paySalary')}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => (editingId === emp.id ? setEditingId(null) : startEdit(emp))}>
                    <Icon name="edit" size={15} /> {tc('edit')}
                  </button>
                  <button className={`btn btn-sm ${emp.isActive ? 'btn-secondary' : 'btn-primary'}`} onClick={() => handleToggleActive(emp)}>
                    {emp.isActive ? t('inactive') : t('active')}
                  </button>
                  <button className="btn btn-sm" style={{ background: 'var(--danger)', color: 'white', marginLeft: 'auto' }} onClick={() => handleDelete(emp)} aria-label={tc('delete')}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>

                {/* Edit Employee Form */}
                {editingId === emp.id && (
                  <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--bg-input)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    <h4 style={{ marginBottom: 'var(--space-3)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Icon name="edit" size={15} /> {t('editEmployee')}
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('name')} *</label>
                        <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('nameAm')}</label>
                        <input className="input" value={editForm.nameAm} onChange={(e) => setEditForm({ ...editForm, nameAm: e.target.value })} placeholder="አማርኛ ስም" /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('nameOm')}</label>
                        <input className="input" value={editForm.nameOm} onChange={(e) => setEditForm({ ...editForm, nameOm: e.target.value })} placeholder="Maqaa Afaan Oromoo" /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('role')}</label>
                        <select className="input" value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                          {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]?.en || r}</option>)}
                        </select></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('phone')}</label>
                        <input className="input" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('salaryAmount')}</label>
                        <input className="input" type="number" value={editForm.salary} onChange={(e) => setEditForm({ ...editForm, salary: e.target.value })} /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}><Icon name="bank" size={13} /> {t('bankName')}</label>
                        <input className="input" value={editForm.bankName} onChange={(e) => setEditForm({ ...editForm, bankName: e.target.value })} placeholder="e.g. CBE, Awash" /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}><Icon name="hash" size={13} /> {t('bankAccount')}</label>
                        <input className="input" value={editForm.bankAccount} onChange={(e) => setEditForm({ ...editForm, bankAccount: e.target.value })} placeholder="Account number" /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('pin')}</label>
                        <input className="input" type="password" inputMode="numeric" value={editForm.pin} onChange={(e) => setEditForm({ ...editForm, pin: e.target.value })} maxLength={8} placeholder={t('pinKeep')} /></div>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => handleSaveEdit(emp)}><Icon name="check" size={15} /> {tc('save')}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>{tc('cancel')}</button>
                    </div>
                  </div>
                )}

                {/* Pay Salary Form */}
                {showPayForm === emp.id && (() => {
                  const dailyRate = roundMoney(emp.salary / 30);
                  const absentDays = Math.max(parseInt(payForm.absentDays) || 0, 0);
                  const absentDeduction = roundMoney(dailyRate * absentDays);
                  const bonus = Math.max(roundMoney(parseFloat(payForm.bonus) || 0), 0);
                  const otherDeductions = Math.max(roundMoney(parseFloat(payForm.deductions) || 0), 0);
                  const totalDeductions = roundMoney(absentDeduction + otherDeductions);
                  const netPay = roundMoney(emp.salary + bonus - totalDeductions);

                  return (
                  <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-4)', background: 'var(--bg-input)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    <h4 style={{ marginBottom: 'var(--space-3)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '6px' }}><Icon name="coins" size={15} /> {t('paySalary')} — {emp.name}</h4>

                    {/* Bank info */}
                    {(emp.bankName || emp.bankAccount) && (
                      <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', fontSize: '0.8125rem' }}>
                        {emp.bankName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Icon name="bank" size={14} /> <strong>{emp.bankName}</strong></span>}
                        {emp.bankAccount && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Icon name="hash" size={14} /> {emp.bankAccount}</span>}
                      </div>
                    )}

                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-gold)', marginBottom: 'var(--space-3)' }}>
                      {t('salary')}: {formatPrice(emp.salary, locale)}/mo
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400, marginLeft: 'var(--space-2)' }}>
                        ({formatPrice(dailyRate, locale)}/day)
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-2)' }}>
                      <div style={{ background: 'var(--bg-card)', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)' }}>
                        <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}><Icon name="calendar" size={13} /> Absent Days</label>
                        <input className="input" type="number" min="0" max="30" value={payForm.absentDays} onChange={(e) => setPayForm({ ...payForm, absentDays: e.target.value })} />
                        {absentDays > 0 && (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--danger)', marginTop: '4px' }}>
                            −{formatPrice(absentDeduction, locale)} ({absentDays} × {formatPrice(dailyRate, locale)})
                          </div>
                        )}
                      </div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('bonus')}</label>
                        <input className="input" type="number" value={payForm.bonus} onChange={(e) => setPayForm({ ...payForm, bonus: e.target.value })} /></div>
                      <div><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{t('deductions')}</label>
                        <input className="input" type="number" value={payForm.deductions} onChange={(e) => setPayForm({ ...payForm, deductions: e.target.value })} /></div>
                    </div>

                    <div style={{ marginTop: 'var(--space-2)' }}><label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('paymentNote')}</label>
                      <input className="input" value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} /></div>

                    {/* Breakdown */}
                    <div style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span>{t('salary')}</span>
                        <span>{formatPrice(emp.salary, locale)}</span>
                      </div>
                      {absentDays > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: 'var(--danger)' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><Icon name="calendar" size={13} /> Absent ({absentDays} days)</span>
                          <span>−{formatPrice(absentDeduction, locale)}</span>
                        </div>
                      )}
                      {otherDeductions > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: 'var(--danger)' }}>
                          <span>{t('deductions')}</span>
                          <span>−{formatPrice(otherDeductions, locale)}</span>
                        </div>
                      )}
                      {bonus > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: 'var(--success)' }}>
                          <span>{t('bonus')}</span>
                          <span>+{formatPrice(bonus, locale)}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border)', fontSize: '1.125rem', fontWeight: 700 }}>
                        <span>{t('netPay')}</span>
                        <span style={{ color: netPay >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatPrice(netPay, locale)}</span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => handlePay(emp)}><Icon name="check" size={15} /> {t('markPaid')}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowPayForm(null)}>{tc('cancel')}</button>
                    </div>
                  </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'payroll' && (
        <div className="glass-card-static table-scroll">
          <div className="panel-header">
            <h3 className="section-title">{t('paymentHistory')}</h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('role')}</th>
                <th>Month</th>
                <th>{t('salary')}</th>
                <th>{t('bonus')}</th>
                <th>{t('deductions')}</th>
                <th>{t('netPay')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {salaryHistory.map((rec) => (
                <tr key={rec.id}>
                  <td style={{ fontWeight: 600 }}>{getLocaleName(rec.staff.name, rec.staff.nameAm, locale, rec.staff.nameOm)}</td>
                  <td><span className="badge">{rec.staff.role}</span></td>
                  <td>{rec.month}</td>
                  <td>{formatPrice(rec.amount, locale)}</td>
                  <td style={{ color: 'var(--success)' }}>{rec.bonus > 0 ? '+' + formatPrice(rec.bonus, locale) : '—'}</td>
                  <td style={{ color: 'var(--danger)' }}>{rec.deductions > 0 ? '-' + formatPrice(rec.deductions, locale) : '—'}</td>
                  <td style={{ fontWeight: 700, color: 'var(--accent-gold)' }}>{formatPrice(rec.netPay, locale)}</td>
                  <td><span className={`badge ${rec.status === 'PAID' ? 'badge-ready' : 'badge-pending'}`}>{rec.status === 'PAID' ? t('paid') : t('pending')}</span></td>
                </tr>
              ))}
              {salaryHistory.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 'var(--space-10)' }}>{t('noEmployees')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'tables' && (
        <div className="glass-card-static panel">
          <div className="panel-header">
            <h3 className="section-title">{t('tables')}</h3>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--space-3)' }}>
            {tableAssignments.map((row) => (
              <div key={row.number} style={{ background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', padding: 'var(--space-3)' }}>
                <div style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '6px' }}>
                  {t('table')} {row.number}
                </div>
                <select
                  className="input"
                  value={row.assignedStaffId ?? ''}
                  onChange={(e) => handleAssignTable(row.number, e.target.value ? Number(e.target.value) : null)}
                  aria-label={`${t('table')} ${row.number}`}
                >
                  <option value="">{t('unassigned')}</option>
                  {waiters.map((w) => (
                    <option key={w.id} value={w.id} disabled={!w.isActive}>
                      {getLocaleName(w.name, w.nameAm, locale, w.nameOm)}{w.isActive ? '' : ` (${t('inactive')})`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
