/**
 * /settlements 批次对账与结算单
 * - 「批次对账」：苗圃看进场数量 / 在库余量 / 挂起，与项目部按批次对账最新测次摊回的批次成活率；
 * - 「结算单」：低于供苗保证率的差额单据，苗圃生成（随测次 / 领用自动更新），项目部确认或驳回。
 * - 苗圃那份保存失败的待办只在苗圃本侧重试，项目部侧操作照旧。
 * 消费模型：Settlement、Seedling、Planting、Survey；复用组件：<StatBadge>、<FilterBar>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  FieldTimeOutlined,
  RetweetOutlined,
} from '@ant-design/icons';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { useSettlementStore } from '../stores/settlementStore';
import { DB_NAME, DB_SCHEMA_VERSION } from '../utils/db';
import { SETTLEMENT_STATUS_OPTIONS, type Settlement, type SettlementStatus } from '../types/settlement';
import { guaranteeRateText } from '../types/seedling';

export default function SettlementBoard() {
  const { message } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const seedlings = usePlotStore((state) => state.seedlings);
  const reconcile = usePlotStore((state) => state.reconcile);
  const settlements = usePlotStore((state) => state.settlements);
  const ready = usePlotStore((state) => state.ready);
  const retryItems = useSettlementStore((state) => state.retryItems);
  const confirmOne = useSettlementStore((state) => state.confirm);
  const rejectOne = useSettlementStore((state) => state.reject);
  const dropOne = useSettlementStore((state) => state.drop);
  const retryAll = useSettlementStore((state) => state.retryAll);

  const [tab, setTab] = useState<'reconcile' | 'settlements'>('settlements');
  const [plotFilter, setPlotFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<SettlementStatus | 'all'>('待确认');
  const [keyword, setKeyword] = useState('');
  const [rejectTarget, setRejectTarget] = useState<Settlement | null>(null);
  const [rejectRemark, setRejectRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';
  const seedlingOf = (seedlingId: string) => seedlings.find((item) => item.id === seedlingId);

  const stats = useMemo(() => {
    const pending = settlements.filter((row) => row.status === '待确认');
    const confirmed = settlements.filter((row) => row.status === '已确认');
    const rejected = settlements.filter((row) => row.status === '已驳回');
    const shortPlants = pending.reduce((acc, row) => acc + row.shortCount, 0);
    const pendingBatches = Object.values(reconcile).filter((row) => row.pending > 0).length;
    return {
      total: settlements.length,
      pending: pending.length,
      confirmed: confirmed.length,
      rejected: rejected.length,
      shortPlants,
      pendingBatches,
    };
  }, [settlements, reconcile]);

  const filteredSettlements = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return settlements
      .filter((row) => {
        if (plotFilter !== 'all' && row.plotId !== plotFilter) return false;
        if (statusFilter !== 'all' && row.status !== statusFilter) return false;
        if (key === '') return true;
        const seedling = seedlingOf(row.seedlingId);
        return (
          plotName(row.plotId).toLowerCase().includes(key) ||
          (seedling?.species ?? '').toLowerCase().includes(key) ||
          row.surveyDate.includes(key)
        );
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlements, plotFilter, statusFilter, keyword, plots, seedlings]);

  const reconcileRows = useMemo(() => {
    return seedlings
      .filter((row) => plotFilter === 'all' || row.plotId === plotFilter)
      .map((row) => reconcile[row.id])
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
  }, [seedlings, reconcile, plotFilter]);

  const handleConfirm = async (row: Settlement): Promise<void> => {
    await confirmOne(row.id);
    message.success(`已确认批次「${seedlingOf(row.seedlingId)?.species ?? row.seedlingId}」${row.shortCount} 株的差额`);
  };

  const openReject = (row: Settlement): void => {
    setRejectTarget(row);
    setRejectRemark('');
  };

  const handleReject = async (): Promise<void> => {
    if (rejectTarget === null) return;
    if (rejectRemark.trim() === '') {
      message.warning('驳回时请填写原因，便于苗圃复核');
      return;
    }
    setSubmitting(true);
    try {
      await rejectOne(rejectTarget.id, rejectRemark);
      message.success('已驳回该结算差额');
      setRejectTarget(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryAll = async (): Promise<void> => {
    const result = await retryAll();
    if (result.remain === 0) {
      message.success(`苗圃本侧重试完成，已补存 ${result.success} 个地块的结算单`);
    } else {
      message.warning(`已补存 ${result.success} 个，仍有 ${result.remain} 个地块的苗圃侧保存失败，稍后可再试`);
    }
  };

  const settlementColumns: ColumnsType<Settlement> = [
    {
      title: '批次 / 地块',
      key: 'batch',
      width: 230,
      render: (_value, record) => {
        const seedling = seedlingOf(record.seedlingId);
        return (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Tag color="green">{seedling?.species ?? '批次已删除'}</Tag>
              <span>{seedling?.spec ?? record.seedlingId}</span>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {plotName(record.plotId)} · {seedling?.source ?? '—'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '测次',
      key: 'round',
      width: 150,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            第 {record.round} 次
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.surveyDate}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '参与摊回领用（株）',
      dataIndex: 'issuedCount',
      key: 'issuedCount',
      width: 150,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '摊回成活（株）',
      dataIndex: 'aliveCount',
      key: 'aliveCount',
      width: 130,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '批次成活率',
      dataIndex: 'batchRate',
      key: 'batchRate',
      width: 100,
      align: 'right',
      render: (value: number) => <Tag color="red">{value.toFixed(1)}%</Tag>,
    },
    {
      title: '供苗保证率',
      dataIndex: 'guaranteeRate',
      key: 'guaranteeRate',
      width: 100,
      align: 'right',
      render: (value: number) => `${value}%`,
    },
    {
      title: '差额',
      key: 'short',
      width: 140,
      align: 'right',
      render: (_value, record) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <Typography.Text strong type="danger">
            {record.shortRate.toFixed(1)} 个百分点
          </Typography.Text>
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {record.shortCount.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 170,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Tag color={record.status === '已确认' ? 'green' : record.status === '已驳回' ? 'default' : 'orange'}>
            {record.status}
          </Tag>
          {record.confirmedAt !== '' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.confirmedAt}
            </Typography.Text>
          ) : null}
          {record.remark !== '' ? (
            <Tooltip title={record.remark}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                {record.remark}
              </Typography.Text>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      fixed: 'right',
      render: (_value, record) =>
        record.status === '待确认' ? (
          <Space size={4} wrap>
            <Button
              size="small"
              type="link"
              icon={<CheckCircleOutlined />}
              onClick={() => void handleConfirm(record)}
            >
              项目部确认
            </Button>
            <Button size="small" type="link" icon={<CloseCircleOutlined />} onClick={() => openReject(record)}>
              驳回
            </Button>
            <Popconfirm
              title="苗圃侧撤回该待确认结算单？"
              description="仅撤回苗圃本侧单据；若短差仍存在，下次重算会重新生成。"
              okText="撤回"
              cancelText="取消"
              onConfirm={async () => {
                await dropOne(record.id);
                message.success('已撤回该结算单');
              }}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                撤回
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            项目部已{record.status}，不再随测次重算覆盖
          </Typography.Text>
        ),
    },
  ];

  const reconcileColumns: ColumnsType<(typeof reconcileRows)[number]> = [
    {
      title: '地块',
      key: 'plot',
      width: 180,
      render: (_value, record) => plotName(record.plotId),
    },
    {
      title: '批次',
      key: 'batch',
      width: 210,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <Tag color="green">{record.species}</Tag>
            <Tag color={record.source === '自育苗' ? 'cyan' : 'gold'}>{record.source}</Tag>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保证率 {guaranteeRateText(record.guaranteeRate)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '进场数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 100,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '在库领用',
      dataIndex: 'committed',
      key: 'committed',
      width: 100,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '在库余量',
      key: 'available',
      width: 100,
      align: 'right',
      render: (_value, record) => (
        <Typography.Text type={record.available <= 0 ? 'warning' : undefined}>
          {record.available.toLocaleString('zh-CN')}
        </Typography.Text>
      ),
    },
    {
      title: '挂起领用',
      key: 'pending',
      width: 150,
      align: 'right',
      render: (_value, record) =>
        record.pending > 0 ? (
          <Tooltip title={`累计超出进场数量 ${record.overQuantity} 株，挂起部分不参与测次摊回`}>
            <Tag color="orange">{record.pending.toLocaleString('zh-CN')} 株（超 {record.overQuantity}）</Tag>
          </Tooltip>
        ) : (
          <span>0</span>
        ),
    },
    {
      title: '最新测次摊回',
      key: 'latest',
      render: (_value, record) => {
        if (!record.latest) return <Typography.Text type="secondary">该地块尚无验收测次</Typography.Text>;
        const latest = record.latest;
        return (
          <Space direction="vertical" size={0}>
            <Space size={6}>
              <Tag color="blue">第 {latest.round} 次 · {latest.date}</Tag>
              <span>
                成活 {latest.alive.toLocaleString('zh-CN')} / 领用 {latest.issued.toLocaleString('zh-CN')} 株
              </span>
            </Space>
            <Space size={6}>
              <Tag color={latest.pass === false ? 'red' : 'green'}>批次成活率 {latest.rate.toFixed(1)}%</Tag>
              {latest.pass === false ? (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  低于保证率，差 {latest.shortRate.toFixed(1)} 点 / {latest.shortCount} 株
                </Typography.Text>
              ) : latest.pass === true ? (
                <Typography.Text type="success" style={{ fontSize: 12 }}>
                  达到供苗保证率
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  不考核
                </Typography.Text>
              )}
            </Space>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="结算单合计" value={stats.total} suffix="张" tone="primary" />
        <StatBadge label="待项目部确认" value={stats.pending} suffix="张" tone={stats.pending > 0 ? 'warning' : 'default'} />
        <StatBadge label="待确认差额" value={stats.shortPlants.toLocaleString('zh-CN')} suffix="株" tone="danger" />
        <StatBadge label="已确认" value={stats.confirmed} suffix="张" tone="success" />
        <StatBadge label="已驳回" value={stats.rejected} suffix="张" tone="default" />
        <StatBadge
          label="存在挂起批次"
          value={stats.pendingBatches}
          suffix="批"
          tone={stats.pendingBatches > 0 ? 'warning' : 'default'}
          hint="领用累计超出进场数量的苗木批次数"
        />
      </div>

      {retryItems.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`苗圃侧有 ${retryItems.length} 个地块的结算单保存失败，等待本侧重试`}
          description={
            <Space direction="vertical" size={4}>
              {retryItems.map((item) => (
                <Typography.Text key={item.id} style={{ fontSize: 12 }}>
                  <FieldTimeOutlined /> {plotName(item.plotId)}：{item.reason}
                </Typography.Text>
              ))}
              <Button size="small" type="primary" ghost icon={<RetweetOutlined />} onClick={() => void handleRetryAll()}>
                只重试苗圃本侧
              </Button>
            </Space>
          }
        />
      ) : null}

      <Card
        title={
          <Space>
            <span>批次对账与结算</span>
            <Tag color="cyan">
              {DB_NAME} · v{DB_SCHEMA_VERSION}
            </Tag>
          </Space>
        }
      >
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as typeof tab)}
          items={[
            {
              key: 'settlements',
              label: `结算单（待确认 ${stats.pending}）`,
              children: (
                <>
                  <FilterBar
                    keyword={keyword}
                    onKeywordChange={setKeyword}
                    fields={[
                      {
                        key: 'plotId',
                        label: '地块',
                        options: plots.map((plot) => plot.id),
                        optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])),
                      },
                    ]}
                    values={{ plotId: plotFilter }}
                    onChange={(key: string, value: string) => {
                      if (key === 'plotId') setPlotFilter(value);
                    }}
                    onReset={() => {
                      setKeyword('');
                      setPlotFilter('all');
                      setStatusFilter('待确认');
                    }}
                    resultText={`命中 ${filteredSettlements.length} / ${settlements.length} 张`}
                    extra={
                      <Space size={6}>
                        <span style={{ color: '#5b6b66', fontSize: 13 }}>状态</span>
                        <Select
                          style={{ minWidth: 120 }}
                          value={statusFilter}
                          onChange={(value: SettlementStatus | 'all') => setStatusFilter(value)}
                          options={[
                            { value: 'all', label: '全部状态' },
                            ...SETTLEMENT_STATUS_OPTIONS.map((value) => ({ value, label: value })),
                          ]}
                        />
                      </Space>
                    }
                  />
                  {!ready || settlements.length === 0 ? (
                    <EmptyPanel
                      title="暂无结算单"
                      description="项目部录入验收测次后，成活株数会按在库领用摊回苗木批次；外购等考核批次的批次成活率低于供苗保证率时，差额自动生成结算单。"
                    />
                  ) : (
                    <Table<Settlement>
                      rowKey="id"
                      size="middle"
                      columns={settlementColumns}
                      dataSource={filteredSettlements}
                      scroll={{ x: 1480 }}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                      locale={{
                        emptyText: <EmptyPanel title="没有符合筛选条件的结算单" />,
                      }}
                    />
                  )}
                </>
              ),
            },
            {
              key: 'reconcile',
              label: '苗圃批次对账',
              children: (
                <>
                  <Space size={12} wrap style={{ marginBottom: 14 }}>
                    <Space size={6}>
                      <span style={{ color: '#5b6b66', fontSize: 13 }}>地块</span>
                      <Select
                        style={{ minWidth: 200 }}
                        value={plotFilter}
                        onChange={setPlotFilter}
                        options={[
                          { value: 'all', label: '全部地块' },
                          ...plots.map((plot) => ({ value: plot.id, label: plot.name })),
                        ]}
                      />
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      两边按批次对账：苗圃登记进场数量与保证率，项目部登记栽植领用与验收测次；
                      测次成活株数按在库领用摊回批次。
                    </Typography.Text>
                  </Space>
                  {!ready || reconcileRows.length === 0 ? (
                    <EmptyPanel title="暂无苗木批次" description="苗圃先登记进场批次与供苗保证率后，这里才会出现对账行。" />
                  ) : (
                    <Table
                      rowKey="seedlingId"
                      size="middle"
                      columns={reconcileColumns}
                      dataSource={reconcileRows}
                      scroll={{ x: 1200 }}
                      pagination={{ pageSize: 8, showSizeChanger: false }}
                    />
                  )}
                </>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="项目部驳回结算差额"
        open={rejectTarget !== null}
        onCancel={() => setRejectTarget(null)}
        onOk={() => void handleReject()}
        confirmLoading={submitting}
        okText="提交驳回"
        cancelText="取消"
      >
        {rejectTarget !== null ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              批次：{seedlingOf(rejectTarget.seedlingId)?.species ?? rejectTarget.seedlingId} ·{' '}
              {plotName(rejectTarget.plotId)} · 第 {rejectTarget.round} 测次
            </Typography.Text>
            <Typography.Text type="secondary">
              批次成活率 {rejectTarget.batchRate.toFixed(1)}% / 保证率 {rejectTarget.guaranteeRate}%，差额{' '}
              {rejectTarget.shortCount.toLocaleString('zh-CN')} 株
            </Typography.Text>
            <Form layout="vertical" style={{ marginTop: 4 }}>
              <Form.Item label="驳回原因（退回苗圃复核）" required>
                <Input.TextArea
                  rows={3}
                  value={rejectRemark}
                  onChange={(event) => setRejectRemark(event.target.value)}
                  placeholder="如：该测次样方边界与供苗批次不一致，需重新核对领用记录"
                />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
