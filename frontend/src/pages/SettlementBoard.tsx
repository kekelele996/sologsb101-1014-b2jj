/**
 * /settlements 批次结算与对账台
 * 两侧按批次对账：
 *  - 苗圃侧口径：进场数量、供苗流水账出库、批次结算单（成活摊回 + 保证率差额）
 *  - 项目部侧口径：栽植领用落实数、验收测次
 * 测次成活株数按领用摊回批次 → 批次成活率 → 低于保证率的差额进结算单，等项目部确认。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, FileProtectOutlined } from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useNurseryStore } from '../stores/nurseryStore';
import { db } from '../utils/db';
import type { Seedling } from '../types/seedling';
import type { Settlement } from '../types/settlement';
import type { Survey } from '../types/survey';
import type { NurseryOutflow } from '../types/ledger';
import { apportionAliveToBatches } from '../utils/batch';

interface ReconcileRow {
  seedling: Seedling;
  arrival: number;
  /** 苗圃流水账出库合计 */
  outflow: number;
  /** 项目部领用落实合计 */
  fulfilled: number;
  /** 项目部领用（含挂起） */
  requested: number;
  /** 最新测次摊回 */
  share: { plotId: string; plotName: string; round: number; planted: number; alive: number; rate: number }[];
  /** 综合批次成活率（全部地块摊回汇总，%） */
  batchRate: number | null;
  matched: boolean;
  settlement?: Settlement;
}

export default function SettlementBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const plantings = usePlotStore((state) => state.plantings);
  const surveys = usePlotStore((state) => state.surveys);
  const confirmSettlement = useNurseryStore((state) => state.confirmSettlement);

  const { rows: seedlings, loading } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows: settlements } = useIdbTable<Settlement>(db.settlements, { sortByUpdatedAt: false });
  const { rows: outflows } = useIdbTable<NurseryOutflow>(db.nurseryOutflows, { sortByUpdatedAt: false });
  const [plotFilter, setPlotFilter] = useState<string>('all');

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  /** 各地块最新测次索引 */
  const latestSurveyByPlot = useMemo(() => {
    const map = new Map<string, Survey>();
    surveys.forEach((survey) => {
      const current = map.get(survey.plotId);
      if (!current || survey.round > current.round) map.set(survey.plotId, survey);
    });
    return map;
  }, [surveys]);

  const reconcileRows = useMemo<ReconcileRow[]>(() => {
    return seedlings.map((seedling) => {
      const seedlingPlantings = plantings.filter((row) => row.seedlingId === seedling.id);
      const requested = seedlingPlantings.reduce((acc, row) => acc + row.count, 0);
      const fulfilled = seedlingPlantings.reduce((acc, row) => acc + row.fulfilledCount, 0);
      const outflow = outflows
        .filter((row) => row.seedlingId === seedling.id && row.action === '领用出库')
        .reduce((acc, row) => acc + row.count, 0);

      const share: ReconcileRow['share'] = [];
      let plantedAll = 0;
      let aliveAll = 0;
      plots.forEach((plot) => {
        const latest = latestSurveyByPlot.get(plot.id);
        if (!latest) return;
        const parts = apportionAliveToBatches(latest, seedlingPlantings);
        const part = parts.find((item) => item.seedlingId === seedling.id);
        if (!part || part.planted <= 0) return;
        share.push({
          plotId: plot.id,
          plotName: plot.name,
          round: latest.round,
          planted: part.planted,
          alive: part.alive,
          rate: part.rate,
        });
        plantedAll += part.planted;
        aliveAll += part.alive;
      });
      const batchRate = plantedAll > 0 ? Math.round((aliveAll / plantedAll) * 1000) / 10 : null;
      const settlement = settlements.find((row) => row.seedlingId === seedling.id);
      return {
        seedling,
        arrival: seedling.quantity,
        outflow,
        fulfilled,
        requested,
        share,
        batchRate,
        matched: outflow === fulfilled,
        settlement,
      };
    });
  }, [seedlings, plantings, outflows, plots, latestSurveyByPlot, settlements]);

  const filteredRows = useMemo(
    () =>
      plotFilter === 'all'
        ? reconcileRows
        : reconcileRows.filter((row) => row.share.some((item) => item.plotId === plotFilter)),
    [reconcileRows, plotFilter],
  );

  const pending = settlements.filter((row) => row.status === '待确认');
  const confirmed = settlements.filter((row) => row.status === '已确认');
  const pendingShortfall = pending.reduce((acc, row) => acc + row.shortfallCount, 0);
  const mismatchCount = reconcileRows.filter((row) => !row.matched).length;

  const handleConfirm = async (row: Settlement, confirmed: boolean): Promise<void> => {
    await confirmSettlement(row.id, confirmed);
    message.success(confirmed ? '项目部已确认该批次结算差额' : '已撤回确认，恢复为待项目部确认');
  };

  const columns: ColumnsType<ReconcileRow> = [
    {
      title: '批次',
      key: 'seedling',
      width: 220,
      render: (_v, record) => (
        <Space direction="vertical" size={0}>
          <span>
            <Tag color="green">{record.seedling.species}</Tag>
            {record.seedling.spec}
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.seedling.source} · 进场 {record.seedling.arrivalDate}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '进场数量',
      key: 'arrival',
      width: 100,
      align: 'right',
      render: (_v, record) => record.arrival.toLocaleString('zh-CN'),
    },
    {
      title: '苗圃出库账',
      key: 'outflow',
      width: 110,
      align: 'right',
      render: (_v, record) => (
        <Typography.Text type={record.matched ? undefined : 'danger'}>
          {record.outflow.toLocaleString('zh-CN')}
        </Typography.Text>
      ),
    },
    {
      title: '项目部落实账',
      key: 'fulfilled',
      width: 130,
      align: 'right',
      render: (_v, record) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <span>{record.fulfilled.toLocaleString('zh-CN')}</span>
          {record.requested - record.fulfilled > 0 ? (
            <Tag color="orange">挂起 {record.requested - record.fulfilled}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: '两账一致',
      key: 'matched',
      width: 100,
      render: (_v, record) =>
        record.matched ? <Tag color="green">一致</Tag> : <Tag color="red">不符 {record.outflow - record.fulfilled}</Tag>,
    },
    {
      title: '保证率 / 批次成活率',
      key: 'rate',
      width: 260,
      render: (_v, record) => {
        const guarantee = record.seedling.guaranteeRate;
        if (guarantee === null) return <Tag color="cyan">自育苗不考核</Tag>;
        const rate = record.batchRate;
        const below = rate !== null && rate < guarantee;
        return (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <Tag color="geekblue">保证 {guarantee}%</Tag>
              {rate === null ? (
                <Tag>尚无测次</Tag>
              ) : (
                <Tag color={below ? 'red' : 'green'}>批次成活 {rate}%</Tag>
              )}
            </Space>
            {record.share.map((item) => (
              <Typography.Text key={item.plotId} type="secondary" style={{ fontSize: 12 }}>
                {item.plotName} · 第{item.round}测次：领 {item.planted} / 活 {item.alive}（{item.rate}%）
              </Typography.Text>
            ))}
          </Space>
        );
      },
    },
    {
      title: '结算差额',
      key: 'settlement',
      width: 230,
      render: (_v, record) => {
        if (!record.settlement) return <Typography.Text type="secondary">无差额</Typography.Text>;
        const s = record.settlement;
        return (
          <Space direction="vertical" size={2}>
            <Space>
              <Tag color="red">差 {s.shortfallCount} 株</Tag>
              <Tag color={s.status === '已确认' ? 'green' : 'orange'}>{s.status}</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              依据 {plotName(s.plotId)} 第{s.round}测次：保证活 {s.guaranteedAlive} / 摊回活 {s.allocatedAlive}
            </Typography.Text>
            <Space>
              {s.status === '待确认' ? (
                <Popconfirm
                  title="项目部确认该批次结算差额？"
                  description={`低于保证率 ${s.guaranteeRate}% 的差额为 ${s.shortfallCount} 株。`}
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => void handleConfirm(s, true)}
                >
                  <Button size="small" type="primary" ghost icon={<CheckCircleOutlined />}>
                    项目部确认
                  </Button>
                </Popconfirm>
              ) : (
                <Button size="small" onClick={() => void handleConfirm(s, false)}>
                  撤回确认
                </Button>
              )}
            </Space>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong style={{ fontSize: 16 }}>
          批次结算与对账台
        </Typography.Text>
        <Tag color="geekblue">两摊按批次对账</Tag>
        <Typography.Text type="secondary">成活株数按测次领用摊回批次，低于供苗保证率的差额进结算单，等项目部确认。</Typography.Text>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="对账批次" value={seedlings.length} suffix="批" tone="primary" icon={<FileProtectOutlined />} />
        <StatBadge
          label="两账不符"
          value={mismatchCount}
          suffix="批"
          tone={mismatchCount > 0 ? 'danger' : 'success'}
          hint="苗圃出库账与项目部落实账不一致的批次数（可能有侧重试任务未补齐）"
        />
        <StatBadge label="待确认差额" value={pendingShortfall.toLocaleString('zh-CN')} suffix="株" tone="warning" />
        <StatBadge label="待确认 / 已确认" value={`${pending.length} / ${confirmed.length}`} suffix="单" tone="info" />
      </div>

      {mismatchCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${mismatchCount} 个批次两侧账目不符`}
          description="苗圃供苗流水账与项目部栽植领用落实数对不上，通常是苗圃侧记账失败还在重试队列里；可到「苗圃供苗台」重提本侧后再对账。"
        />
      ) : null}

      <Card
        title="按批次对账"
        size="small"
        extra={
          <Space>
            <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
            <Select
              style={{ minWidth: 200 }}
              value={plotFilter}
              onChange={setPlotFilter}
              options={[
                { value: 'all', label: '全部地块（批次汇总）' },
                ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
              ]}
            />
          </Space>
        }
      >
        {seedlings.length === 0 && !loading ? (
          <EmptyPanel title="还没有苗木批次" description="先到苗圃供苗台登记进场批次与供苗保证率。" />
        ) : (
          <Table<ReconcileRow>
            rowKey={(record) => record.seedling.id}
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filteredRows}
            pagination={false}
            scroll={{ x: 1200 }}
          />
        )}
      </Card>
    </div>
  );
}
