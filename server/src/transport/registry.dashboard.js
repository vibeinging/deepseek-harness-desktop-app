// dashboard 域路由表(批 1:Dashboard & Panel CRUD)。一域一文件,避免多 agent 扇出改同一文件冲突。
// path 顺序对齐源文件 routes/dashboard_crud.js 的注册顺序(字面量段优先于 :param,见源注释)。
import * as dashboard from '../app/dashboard/index.js';

export const dashboardRoutes = [
  // Dashboard CRUD
  { m: 'POST', p: '/api/projects/:pid/dashboards', fn: dashboard.createDashboard, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/dashboards/:did', fn: dashboard.updateDashboard, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/dashboards/:did', fn: dashboard.deleteDashboard, auth: true },
  { m: 'POST', p: '/api/projects/:pid/dashboards/:did/refresh', fn: dashboard.refreshDashboard, auth: true },

  // Dashboard Panel CRUD
  { m: 'POST', p: '/api/projects/:pid/dashboards/:did/panels', fn: dashboard.createDashboardPanel, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/panels/:panelId', fn: dashboard.updatePanel, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/dashboards/panels/:panelId', fn: dashboard.deleteDashboardPanel, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/dashboards/:did/panels/layout', fn: dashboard.updatePanelsLayout, auth: true },
  { m: 'POST', p: '/api/projects/:pid/dashboards/:did/panels/:panelId/refresh', fn: dashboard.refreshDashboardPanel, auth: true },

  // Panel 库 CRUD
  { m: 'POST', p: '/api/projects/:pid/panels', fn: dashboard.createPanel, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/panels/:panelId', fn: dashboard.deletePanel, auth: true },
  { m: 'POST', p: '/api/projects/:pid/panels/generate', fn: dashboard.generatePanel, auth: true },
];
