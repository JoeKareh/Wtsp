export const PERMISSIONS = {
  'dashboard:read': 'View dashboard',
  'orders:read': 'View orders', 'orders:write': 'Create / edit orders',
  'customers:read': 'View customers', 'customers:write': 'Create / edit customers',
  'products:read': 'View products & inventory', 'products:write': 'Edit products & stock',
  'payments:read': 'View payments', 'payments:write': 'Record payments',
  'expenses:read': 'View expenses', 'expenses:write': 'Record expenses',
  'finance:read': 'See costs, profit & margins',
  'analytics:read': 'Sales analytics & recommendations',
  'marketing:read': 'View WhatsApp marketing', 'marketing:write': 'Send campaigns & manage consent',
  'notifications:read': 'View notifications',
  'reports:read': 'Run & export reports',
  'audit:read': 'View audit log',
  'settings:write': 'Change business settings',
  'users:manage': 'Manage users & roles',
};
export const ALL_PERMS = Object.keys(PERMISSIONS);

export const DEFAULT_ROLES = {
  OWNER: { description: 'Full access to everything', permissions: ['*'] },
  ADMIN: {
    description: 'Runs daily operations, finance and reports',
    permissions: ALL_PERMS.filter((p) => !['settings:write', 'users:manage'].includes(p)),
  },
  EMPLOYEE: {
    description: 'Operational access only (no financial data)',
    permissions: ['dashboard:read', 'orders:read', 'orders:write', 'customers:read', 'customers:write', 'products:read', 'notifications:read'],
  },
  VIEWER: { description: 'Read-only access to authorised areas', permissions: ['dashboard:read', 'orders:read', 'customers:read', 'products:read'] },
};

export function hasPerm(user, perm) {
  if (!user) return false;
  if (user.role === 'OWNER' || user.permissions.includes('*')) return true;
  return user.permissions.includes(perm);
}
export const hasAny = (user, perms) => perms.some((p) => hasPerm(user, p));

// Keys removed from API output for users without finance:read.
const FINANCE_KEYS = new Set([
  'unit_cost', 'line_cost', 'total_cost', 'extra_cost', 'cost', 'cost_base', 'gross_profit', 'net_profit',
  'profit', 'profit_base', 'margin', 'margin_pct', 'opex', 'total_costs', 'product_costs', 'purchase_cost',
  'avg_margin', 'stock_cost_value', 'cost_value',
]);
export function stripFinance(v) {
  if (Array.isArray(v)) return v.map(stripFinance);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!FINANCE_KEYS.has(k)) o[k] = stripFinance(x);
    return o;
  }
  return v;
}
