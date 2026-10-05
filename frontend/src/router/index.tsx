/**
 * 路由表：
 * - 苗圃侧：/nursery 供苗台、/settlements 批次结算与对账
 * - 项目部侧：/plots、/plots/:id/plantings、/surveys、/replants
 * 旧版 /plots/:id/seedlings 重定向到苗圃供苗台（批次不再按地块登记）。
 * 层级路由支持直接深链访问（配合 nginx try_files 回退）；页面按路由懒加载自动分包。
 */
import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, type RouteObject } from 'react-router-dom';
import { Skeleton } from 'antd';
import App from '../App';

const PlotList = lazy(() => import('../pages/PlotList'));
const NurseryBoard = lazy(() => import('../pages/SeedlingBoard'));
const PlantingEntry = lazy(() => import('../pages/PlantingEntry'));
const SurveyBoard = lazy(() => import('../pages/SurveyBoard'));
const ReplantPlan = lazy(() => import('../pages/ReplantPlan'));
const SettlementBoard = lazy(() => import('../pages/SettlementBoard'));

/** 路由路径常量：全项目唯一来源，避免手写字符串不一致 */
export const ROUTES = {
  plots: '/plots',
  nursery: '/nursery',
  /** 批次改为苗圃全局登记，旧地块级链接统一回苗圃供苗台 */
  seedlings: (_plotId?: string): string => '/nursery',
  plantings: (plotId: string): string => `/plots/${plotId}/plantings`,
  surveys: '/surveys',
  replants: '/replants',
  settlements: '/settlements',
} as const;

/** 懒加载页面占位 */
function RouteFallback() {
  return <Skeleton active paragraph={{ rows: 6 }} style={{ background: '#ffffff', padding: 16, borderRadius: 10 }} />;
}

function withSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={ROUTES.plots} replace /> },
      { path: 'plots', element: withSuspense(<PlotList />) },
      { path: 'nursery', element: withSuspense(<NurseryBoard />) },
      { path: 'settlements', element: withSuspense(<SettlementBoard />) },
      { path: 'plots/:id/seedlings', element: <Navigate to={ROUTES.nursery} replace /> },
      { path: 'plots/:id/plantings', element: withSuspense(<PlantingEntry />) },
      { path: 'surveys', element: withSuspense(<SurveyBoard />) },
      { path: 'replants', element: withSuspense(<ReplantPlan />) },
      { path: '*', element: <Navigate to={ROUTES.plots} replace /> },
    ],
  },
];

export default appRoutes;
