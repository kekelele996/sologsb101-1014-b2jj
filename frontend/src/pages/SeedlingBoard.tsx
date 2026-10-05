/**
 * /nursery 苗圃供苗台（苗圃侧）
 * 只管苗圃这摊：苗木批次的进场数量与供苗保证率、批次在库、供苗保证率考核、
 * 本侧（苗圃）保存失败后的侧重试队列与故障注入演示。
 * 消费模型：Seedling、Planting（项目部在库占用只读）、NurseryOutflow、OutboxTask
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { useNurseryStore } from '../stores/nurseryStore';
import { usePlotStore } from '../stores/plotStore';
import { db } from '../utils/db';
import {
  PURCHASED_DEFAULT_GUARANTEE_RATE,
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import type { NurseryOutflow, OutboxTask } from '../types/ledger';
import { batchInStock, fulfilledByBatch } from '../utils/batch';
import { ROUTES } from '../router';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
  assessed: boolean;
  guaranteeRate: number;
}

const KIND_LABEL: Record<OutboxTask['kind'], string> = {
  'outflow-sync': '供苗流水账同步',
  'settlement-sync': '结算单重算',
  'plot-purge': '地块账清理',
};

export default function NurseryBoard() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const plantings = usePlotStore((state) => state.plantings);
  const { rows, loading } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows: outflows } = useIdbTable<NurseryOutflow>(db.nurseryOutflows, { sortByUpdatedAt: false });
  const { rows: outbox } = useIdbTable<OutboxTask>(db.outbox, { sortByUpdatedAt: false });

  const failing = useNurseryStore((state) => state.failing);
  const refreshFailing = useNurseryStore((state) => state.refreshFailing);
  const toggleFailing = useNurseryStore((state) => state.toggleFailing);
  const createSeedling = useNurseryStore((state) => state.createSeedling);
  const updateSeedling = useNurseryStore((state) => state.updateSeedling);
  const deleteSeedling = useNurseryStore((state) => state.deleteSeedling);
  const retryOutbox = useNurseryStore((state) => state.retryOutbox);
  const dismissInjectionAndRetry = useNurseryStore((state) => state.dismissInjectionAndRetry);
  const discardTask = useNurseryStore((state) => state.discardTask);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows],
  );

  const pendingTasks = useMemo(() => outbox.filter((row) => row.status !== 'done'), [outbox]);

  const totals = useMemo(() => {
    const arrival = rows.reduce((acc, row) => acc + row.quantity, 0);
    const fulfilled = rows.reduce((acc, row) => acc + fulfilledByBatch(row.id, plantings), 0);
    const inStock = rows.reduce((acc, row) => acc + batchInStock(row, plantings), 0);
    const assessed = rows.filter((row) => row.guaranteeRate !== null).length;
    return { arrival, fulfilled, inStock, assessed };
  }, [rows, plantings]);

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
      arrivalDate: dayjs(),
      assessed: false,
      guaranteeRate: PURCHASED_DEFAULT_GUARANTEE_RATE,
    });
    setOpen(true);
  };

  const openEdit = (row: Seedling): void => {
    setEditing(row);
    form.setFieldsValue({
      species: row.species,
      source: row.source,
      spec: row.spec,
      quantity: row.quantity,
      arrivalDate: dayjs(row.arrivalDate),
      assessed: row.guaranteeRate !== null,
      guaranteeRate: row.guaranteeRate ?? PURCHASED_DEFAULT_GUARANTEE_RATE,
    });
    setOpen(true);
  };

  const handleSourceChange = (source: SeedlingSource): void => {
    const assessed = source === '外购';
    form.setFieldsValue({
      assessed,
      guaranteeRate: assessed ? PURCHASED_DEFAULT_GUARANTEE_RATE : form.getFieldValue('guaranteeRate'),
    });
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        species: values.species,
        source: values.source,
        spec: values.spec.trim(),
        quantity: values.quantity,
        arrivalDate: values.arrivalDate.format('YYYY-MM-DD'),
        guaranteeRate: values.assessed ? values.guaranteeRate : null,
      };
      if (editing === null) {
        await createSeedling(payload);
        message.success(`已进场登记：${payload.species} ${payload.quantity} 株`);
      } else {
        await updateSeedling(editing.id, payload);
        message.success('苗木批次已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    try {
      await deleteSeedling(row.id);
      message.success('已删除苗木批次');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const handleRetryAll = async (): Promise<void> => {
    const result = await retryOutbox();
    if (result.done > 0) message.success(`苗圃侧重提成功 ${result.done} 条`);
    if (result.failed > 0) message.warning(`仍有 ${result.failed} 条苗圃侧任务失败，项目部侧数据不受影响`);
  };

  const columns: ColumnsType<Seedling> = [
    {
      title: '进场日期',
      dataIndex: 'arrivalDate',
      key: 'arrivalDate',
      width: 120,
      sorter: (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
    },
    {
      title: '树种',
      dataIndex: 'species',
      key: 'species',
      width: 110,
      render: (value: string) => <Tag color="green">{value}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 96,
      render: (value: string) => <Tag color={value === '自育苗' ? 'cyan' : 'gold'}>{value}</Tag>,
    },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 160 },
    {
      title: '进场数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '已供苗（落实）',
      key: 'fulfilled',
      width: 120,
      align: 'right',
      render: (_v, record) => fulfilledByBatch(record.id, plantings).toLocaleString('zh-CN'),
    },
    {
      title: '在库',
      key: 'inStock',
      width: 110,
      align: 'right',
      sorter: (a, b) => batchInStock(a, plantings) - batchInStock(b, plantings),
      render: (_v, record) => {
        const stock = batchInStock(record, plantings);
        return <Typography.Text type={stock === 0 ? 'warning' : undefined}>{stock.toLocaleString('zh-CN')}</Typography.Text>;
      },
    },
    {
      title: '供苗保证率',
      key: 'guaranteeRate',
      width: 120,
      render: (_v, record) =>
        record.guaranteeRate === null ? (
          <Tag color="cyan">自育苗不考核</Tag>
        ) : (
          <Tag color="geekblue">{record.guaranteeRate}%</Tag>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="已被项目部领用的批次不能删除。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const outflowColumns: ColumnsType<NurseryOutflow> = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 120 },
    {
      title: '批次',
      key: 'seedling',
      render: (_v, record) => {
        const seedling = rows.find((item) => item.id === record.seedlingId);
        return seedling ? `${seedling.species} · ${seedling.spec}` : '（批次已删除）';
      },
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 110,
      render: (value: string) => <Tag color="blue">{value}</Tag>,
    },
    {
      title: '出库株数',
      dataIndex: 'count',
      key: 'count',
      width: 120,
      align: 'right',
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    { title: '领用记录', dataIndex: 'plantingId', key: 'plantingId', width: 200 },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong style={{ fontSize: 16 }}>
          苗圃供苗台
        </Typography.Text>
        <Tag color="green">苗圃侧台账</Tag>
        <Typography.Text type="secondary">只登记批次进场数量与供苗保证率；项目部领用与验收在另一侧。</Typography.Text>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={rows.length} suffix="批" tone="primary" />
        <StatBadge label="进场合计" value={totals.arrival.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge label="已供苗落实" value={totals.fulfilled.toLocaleString('zh-CN')} suffix="株" tone="success" />
        <StatBadge label="当前在库" value={totals.inStock.toLocaleString('zh-CN')} suffix="株" tone="default" />
        <StatBadge label="考核批次" value={`${totals.assessed} / ${rows.length}`} suffix="批" tone="warning" hint="登记了供苗保证率、需要按批次成活率考核的批次（外购）" />
      </div>

      <Alert
        type={failing ? 'error' : 'info'}
        showIcon
        style={{ marginBottom: 14 }}
        message={
          <Space>
            <span>两摊各记各的：苗圃保存失败模拟</span>
            <Switch
              checked={failing}
              onChange={(checked) => {
                toggleFailing(checked);
                refreshFailing();
                message.info(checked ? '已开启：苗圃侧保存将失败并入本侧重试队列，项目部侧照常' : '已关闭：自动重提苗圃侧任务');
              }}
              checkedChildren="故障中"
              unCheckedChildren="正常"
            />
          </Space>
        }
        description={
          failing
            ? '开启期间，领用 / 验收触发的苗圃侧记账会失败，只挂进苗圃侧重试队列；项目部侧的领用与测次正常提交、不回滚。关闭开关后点「重提本侧」即可补齐苗圃账。'
            : '正常状态：苗圃侧流水账与结算单随项目部领用、验收即时登记。'
        }
      />

      {pendingTasks.length > 0 ? (
        <Card
          size="small"
          style={{ marginBottom: 14, borderColor: '#e6b3aa' }}
          title={
            <Space>
              <WarningOutlined style={{ color: '#c0392b' }} />
              <span>苗圃侧重试队列（{pendingTasks.length}）——项目部侧已照常提交</span>
            </Space>
          }
          extra={
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleRetryAll()}>
                只重提苗圃侧
              </Button>
            </Space>
          }
        >
          <Table<OutboxTask>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={pendingTasks}
            columns={[
              { title: '本侧动作', key: 'kind', render: (_v, r) => KIND_LABEL[r.kind] },
              {
                title: '状态',
                dataIndex: 'status',
                key: 'status',
                width: 100,
                render: (value: OutboxTask['status']) => (
                  <Tag color={value === 'failed' ? 'red' : 'orange'}>{value === 'failed' ? '失败待重试' : '待重试'}</Tag>
                ),
              },
              { title: '尝试次数', dataIndex: 'attempts', key: 'attempts', width: 90, align: 'right' },
              { title: '原因', dataIndex: 'lastError', key: 'lastError' },
              {
                title: '操作',
                key: 'action',
                width: 220,
                render: (_v, record) => (
                  <Space size={4}>
                    <Tooltip title="先解除本条故障注入再重放，验证只重试苗圃侧">
                      <Button
                        size="small"
                        type="link"
                        onClick={async () => {
                          const result = await dismissInjectionAndRetry(record.id);
                          message.success(`重提完成：成功 ${result.done} 条，仍失败 ${result.failed} 条`);
                        }}
                      >
                        解除并重试
                      </Button>
                    </Tooltip>
                    <Button
                      size="small"
                      type="link"
                      danger
                      onClick={async () => {
                        await discardTask(record.id);
                        message.success('已移除该重试任务');
                      }}
                    >
                      丢弃
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Card
        title="苗木批次（进场数量 + 供苗保证率）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记进场批次
          </Button>
        }
        style={{ marginBottom: 14 }}
      >
        {sortedRows.length === 0 && !loading ? (
          <EmptyPanel
            title="苗圃还没有进场批次"
            description="登记树种、来源、规格、进场数量与供苗保证率；项目部领用时按当前在库挑苗，自育苗可不考核。"
            actionText="登记第一批进场苗"
            onAction={openCreate}
          />
        ) : (
          <Table<Seedling> rowKey="id" size="middle" loading={loading} columns={columns} dataSource={sortedRows} pagination={false} />
        )}
      </Card>

      <Card title={`苗圃供苗流水账（${outflows.length}）——苗圃自己记的出库账`} size="small">
        <Table<NurseryOutflow>
          rowKey="id"
          size="small"
          pagination={{ pageSize: 5, showSizeChanger: false }}
          dataSource={outflows}
          columns={outflowColumns}
          locale={{ emptyText: '项目部还没有已落实的领用' }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          对账以批次为准：拿这里的出库合计，和项目部「栽植领用」页按批次的落实数核对。
          <Button type="link" size="small" onClick={() => navigate(ROUTES.settlements)}>
            去批次结算台看保证率差额
          </Button>
        </Typography.Text>
      </Card>

      <Modal
        title={editing === null ? '登记进场批次' : '编辑苗木批次'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="source" label="来源" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select
                options={SEEDLING_SOURCE_OPTIONS.map((value) => ({ value, label: value }))}
                onChange={(value: SeedlingSource) => handleSourceChange(value)}
              />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格" rules={[{ required: true, message: '请填写苗木规格' }]}>
            <Input placeholder="如：50cm 裸根苗 / 40cm 营养袋苗" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="quantity" label="进场数量（株）" style={{ flex: 1 }} rules={[{ required: true, message: '请填写数量' }]}>
              <InputNumber min={1} max={500000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="arrivalDate" label="进场日期" style={{ flex: 1 }} rules={[{ required: true, message: '请选择进场日期' }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="center">
            <Form.Item name="assessed" valuePropName="checked" label="考核供苗保证率" style={{ marginBottom: 0 }}>
              <Switch
                checkedChildren="考核"
                unCheckedChildren="不考核"
                onChange={(checked) => {
                  if (!checked) return;
                  const source = form.getFieldValue('source');
                  if (source === '外购' && !form.getFieldValue('guaranteeRate')) {
                    form.setFieldsValue({ guaranteeRate: PURCHASED_DEFAULT_GUARANTEE_RATE });
                  }
                }}
              />
            </Form.Item>
            <Form.Item
              noStyle
              shouldUpdate={(prev, next) => prev.assessed !== next.assessed}
            >
              {({ getFieldValue }) =>
                getFieldValue('assessed') ? (
                  <Form.Item
                    name="guaranteeRate"
                    label="供苗保证率（%）"
                    style={{ marginBottom: 0, minWidth: 200 }}
                    rules={[{ required: true, message: '请填写保证率' }]}
                  >
                    <InputNumber min={1} max={100} step={1} style={{ width: '100%' }} />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            自育苗默认不考核；外购苗历史数据升级时按 {PURCHASED_DEFAULT_GUARANTEE_RATE}% 补登保证率。
            批次成活率按项目部测次成活株数摊回，低于保证率的差额记进批次结算单。
          </Typography.Paragraph>
        </Form>
      </Modal>
    </div>
  );
}
