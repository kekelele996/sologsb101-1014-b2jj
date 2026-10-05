/**
 * /plots/:id/plantings 栽植领用（项目部侧）
 * 领用时挑苗圃当时在库的批次：在库够多少落实多少，超出进场数量的先挂起。
 * 同时保留株距与栽植密度合理性校验。
 * 消费模型：Planting、Seedling；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
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
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useRequisitionStore } from '../stores/requisitionStore';
import { db } from '../utils/db';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import { ROUTES } from '../router';
import {
  DENSITY_MAX_M2_PER_PLANT,
  DENSITY_MIN_M2_PER_PLANT,
  checkDensity,
  muToM2,
  type DensityCheck,
} from '../utils/rate';
import { allocateRequisition, batchInStock } from '../utils/batch';

interface PlantingFormValues {
  seedlingId: string;
  plantDate: Dayjs;
  spacingM: number;
  count: number;
  operator: string;
}

const DEFAULT_VALUES: PlantingFormValues = {
  seedlingId: '',
  plantDate: dayjs(),
  spacingM: 1,
  count: 1000,
  operator: '',
};

export default function PlantingEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const allPlantings = usePlotStore((state) => state.plantings);
  const requisitionRevision = useRequisitionStore((state) => state.revision);

  const { rows: allSeedlings } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows, loading } = useIdbTable<Planting>(db.plantings, { sortByUpdatedAt: false });
  const createRequisition = useRequisitionStore((state) => state.createRequisition);
  const updateRequisition = useRequisitionStore((state) => state.updateRequisition);
  const deleteRequisition = useRequisitionStore((state) => state.deleteRequisition);
  const fulfillHeld = useRequisitionStore((state) => state.fulfillHeld);

  const [keyword, setKeyword] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Planting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [density, setDensity] = useState<DensityCheck | null>(null);
  const [form] = Form.useForm<PlantingFormValues>();

  // 苗圃批次是全局在库资源，项目部领用时可挑任意在库批次（不限于本地块）
  const inStockById = useMemo(() => {
    void requisitionRevision;
    const map = new Map<string, number>();
    allSeedlings.forEach((seedling) => {
      const others = allPlantings.filter((row) => row.id !== editing?.id);
      map.set(seedling.id, batchInStock(seedling, others));
    });
    return map;
  }, [allSeedlings, allPlantings, editing, requisitionRevision]);

  const plotPlantings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.plantDate.localeCompare(a.plantDate)),
    [rows, id],
  );

  const operatorOptions = useMemo(
    () => Array.from(new Set(plotPlantings.map((row) => row.operator).filter((item) => item !== ''))),
    [plotPlantings],
  );

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return plotPlantings.filter((row) => {
      if (operatorFilter !== 'all' && row.operator !== operatorFilter) return false;
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (key === '') return true;
      const seedling = allSeedlings.find((item) => item.id === row.seedlingId);
      const species = seedling?.species ?? '';
      return row.operator.toLowerCase().includes(key) || species.toLowerCase().includes(key) || row.plantDate.includes(key);
    });
  }, [plotPlantings, allSeedlings, keyword, operatorFilter, statusFilter]);

  const totalCount = plotPlantings.reduce((acc, row) => acc + row.fulfilledCount, 0);
  const heldCount = plotPlantings.reduce((acc, row) => acc + Math.max(0, row.count - row.fulfilledCount), 0);
  const avgSpacing =
    plotPlantings.length === 0
      ? 0
      : Math.round((plotPlantings.reduce((acc, row) => acc + row.spacingM, 0) / plotPlantings.length) * 100) / 100;
  const usedSeedlingIds = new Set(plotPlantings.map((row) => row.seedlingId));

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = allSeedlings.find((row) => row.id === seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  /** 表单选择批次后，在库不足时即时给出挂起提示 */
  const previewAllocation = (wantedRaw: unknown, seedlingIdRaw: unknown): { wanted: number; inStock: number; fulfilled: number; held: number } => {
    const wanted = typeof wantedRaw === 'number' ? wantedRaw : 0;
    const seedlingId = typeof seedlingIdRaw === 'string' ? seedlingIdRaw : form.getFieldValue('seedlingId');
    const inStock = inStockById.get(seedlingId) ?? 0;
    const fulfilled = allocateRequisition(wanted, inStock);
    return { wanted, inStock, fulfilled, held: Math.max(0, wanted - fulfilled) };
  };

  const openCreate = (): void => {
    setEditing(null);
    setDensity(null);
    const firstInStock = allSeedlings.find((row) => (inStockById.get(row.id) ?? 0) > 0)?.id ?? allSeedlings[0]?.id ?? '';
    form.setFieldsValue({
      ...DEFAULT_VALUES,
      seedlingId: firstInStock,
      plantDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Planting): void => {
    setEditing(row);
    form.setFieldsValue({
      seedlingId: row.seedlingId,
      plantDate: dayjs(row.plantDate),
      spacingM: row.spacingM,
      count: row.count,
      operator: row.operator,
    });
    setDensity(plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.fulfilledCount));
    setOpen(true);
  };

  const handleValuesChange = (): void => {
    if (plot === undefined) return;
    const values = form.getFieldsValue();
    const preview = previewAllocation(values.count, values.seedlingId);
    // 密度按预计落实株数算（挂起部分没有真正栽到地块上）
    setDensity(checkDensity(plot.areaMu, values.spacingM, preview.fulfilled > 0 ? preview.fulfilled : values.count));
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        plotId: id,
        seedlingId: values.seedlingId,
        plantDate: values.plantDate.format('YYYY-MM-DD'),
        spacingM: values.spacingM,
        count: values.count,
        operator: values.operator.trim(),
      };
      if (editing === null) {
        const result = await createRequisition(payload);
        if (result.held > 0) {
          message.warning(
            `领用 ${payload.count} 株：苗圃当时在库仅够 ${result.row.fulfilledCount} 株，已落实，超出 ${result.held} 株先挂起。`,
            6,
          );
        } else {
          message.success(`已领用栽植 ${result.row.fulfilledCount} 株`);
        }
        if (result.nurseryPending) message.warning(result.nurseryMessage, 6);
      } else {
        const result = await updateRequisition(editing.id, payload);
        if (result.held > 0) {
          message.warning(`重新分配后仍有 ${result.held} 株超出在库，保持挂起。`, 6);
        } else {
          message.success('栽植领用已更新');
        }
        if (result.nurseryPending) message.warning(result.nurseryMessage, 6);
      }
      const check = plot === undefined ? null : checkDensity(plot.areaMu, payload.spacingM, payload.count);
      if (check !== null && !check.ok) {
        message.warning(check.message, 6);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFulfillHeld = async (): Promise<void> => {
    if (id === undefined) return;
    const result = await fulfillHeld(id);
    if (result.fulfilledDelta > 0) {
      message.success(`苗圃补苗已到：按当前在库新落实 ${result.fulfilledDelta.toLocaleString('zh-CN')} 株`);
    } else {
      message.info('苗圃在库仍不足，挂起领用暂无法落实');
    }
    if (result.nurseryPending) message.warning(result.nurseryMessage, 6);
  };

  if (!ready) {
    return <Card loading title="栽植领用" />;
  }  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法登记栽植领用。`}
        actionText="返回地块台账"
        onAction={() => navigate(ROUTES.plots)}
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
            返回
          </Button>
        }
      />
    );
  }

  const columns: ColumnsType<Planting> = [
    {
      title: '栽植日期',
      dataIndex: 'plantDate',
      key: 'plantDate',
      width: 120,
      sorter: (a, b) => a.plantDate.localeCompare(b.plantDate),
    },
    {
      title: '苗木批次（苗圃在库）',
      key: 'seedling',
      width: 230,
      render: (_value, record) => {
        const seedling = allSeedlings.find((item) => item.id === record.seedlingId);
        return (
          <Space direction="vertical" size={0}>
            <span>{seedlingLabel(record.seedlingId)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {seedling?.source ?? '—'} · 当前在库 {(inStockById.get(record.seedlingId) ?? 0).toLocaleString('zh-CN')} 株
            </Typography.Text>
          </Space>
        );
      },
    },
    { title: '株距(米)', dataIndex: 'spacingM', key: 'spacingM', width: 90, align: 'right', render: (v: number) => v.toFixed(2) },
    {
      title: '领用 / 落实 / 挂起',
      key: 'counts',
      width: 190,
      render: (_v, record) => {
        const held = Math.max(0, record.count - record.fulfilledCount);
        return (
          <Space size={6} wrap>
            <Tag>领 {record.count.toLocaleString('zh-CN')}</Tag>
            <Tag color="green">落实 {record.fulfilledCount.toLocaleString('zh-CN')}</Tag>
            {held > 0 ? <Tag color="orange">挂起 {held.toLocaleString('zh-CN')}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: Planting['status']) => (
        <Tag color={value === '已落实' ? 'green' : value === '部分挂起' ? 'orange' : 'red'}>{value}</Tag>
      ),
    },
    {
      title: '密度校验',
      key: 'densityCheck',
      width: 100,
      render: (_value, record) => {
        const check = checkDensity(plot.areaMu, record.spacingM, record.fulfilledCount);
        return (
          <Tag color={check.level === 'success' ? 'green' : check.level === 'warning' ? 'orange' : 'red'}>
            {check.ok ? '合理' : check.level === 'warning' ? '偏疏' : '异常'}
          </Tag>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 110 },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该栽植领用？"
            description="苗圃侧供苗流水账会随本侧重算同步冲销。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              const result = await deleteRequisition(record.id);
              message.success('栽植领用已删除');
              if (result.nurseryPending) message.warning(result.nurseryMessage, 6);
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name} · 栽植领用
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>
          {plot.areaMu} 亩 / {Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡
        </Tag>
        <Tag color="gold">项目部侧</Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="领用记录" value={plotPlantings.length} suffix="条" tone="primary" />
        <StatBadge label="已落实栽植" value={totalCount.toLocaleString('zh-CN')} suffix="株" tone="success" />
        <StatBadge label="挂起待苗" value={heldCount.toLocaleString('zh-CN')} suffix="株" tone={heldCount > 0 ? 'danger' : 'default'} />
        <StatBadge label="平均株距" value={avgSpacing.toFixed(2)} suffix="米" tone="default" />
        <StatBadge
          label="用到批次"
          value={`${usedSeedlingIds.size}`}
          suffix="批"
          tone="info"
          hint="本地块领用涉及的苗圃批次数"
        />
      </div>

      {allSeedlings.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="苗圃还没有进场批次"
          description="栽植领用必须挑苗圃在库批次，请先到苗圃供苗台登记进场苗木。"
          action={
            <Button size="small" onClick={() => navigate(ROUTES.nursery)}>
              去苗圃供苗台
            </Button>
          }
        />
      ) : null}

      <Card
        title="栽植领用（挑苗圃当时在库的批次）"
        extra={
          <Space>
            {heldCount > 0 ? (
              <Popconfirm
                title="苗圃已补苗？"
                description={`按当前在库，把本地块挂起的 ${heldCount.toLocaleString('zh-CN')} 株按栽植日期先后落实。`}
                okText="重新落实"
                cancelText="取消"
                onConfirm={() => void handleFulfillHeld()}
              >
                <Button icon={<ReloadOutlined />}>按在库落实挂起 {heldCount.toLocaleString('zh-CN')} 株</Button>
              </Popconfirm>
            ) : null}
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={allSeedlings.length === 0}>
              新增栽植领用
            </Button>
          </Space>
        }
      >
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[
            { key: 'operator', label: '班组', options: operatorOptions },
            { key: 'status', label: '状态', options: ['已落实', '部分挂起', '挂起'] },
          ]}
          values={{ operator: operatorFilter, status: statusFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'operator') setOperatorFilter(value);
            if (key === 'status') setStatusFilter(value);
          }}
          onReset={() => {
            setKeyword('');
            setOperatorFilter('all');
            setStatusFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${plotPlantings.length} 条`}
        />

        {plotPlantings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有栽植领用"
            description="选苗圃当时在库的批次领用：在库够多少落实多少，超出进场数量的部分先挂起。"
            actionText="新增栽植领用"
            onAction={openCreate}
          />
        ) : (
          <Table<Planting>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            pagination={{ pageSize: 8, showSizeChanger: false }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新增栽植领用' : '编辑栽植领用'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={600}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} onValuesChange={handleValuesChange}>
          <Form.Item name="seedlingId" label="苗木批次（苗圃在库）" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              placeholder="挑苗圃当时在库的批次"
              options={allSeedlings.map((row) => {
                const stock = inStockById.get(row.id) ?? 0;
                return {
                  value: row.id,
                  label: `${row.species} · ${row.spec} · 在库 ${stock.toLocaleString('zh-CN')} 株（${row.source}）`,
                  disabled: false,
                };
              })}
            />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {({ getFieldValue }) => {
              const seedlingId = getFieldValue('seedlingId');
              const stock = inStockById.get(seedlingId) ?? 0;
              const preview = previewAllocation(getFieldValue('count'), seedlingId);
              return (
                <Alert
                  style={{ marginBottom: 12 }}
                  type={preview.held > 0 ? 'warning' : 'info'}
                  showIcon
                  message={
                    preview.held > 0
                      ? `苗圃当时在库 ${stock.toLocaleString('zh-CN')} 株：本次落实 ${preview.fulfilled.toLocaleString('zh-CN')} 株，超出 ${preview.held.toLocaleString('zh-CN')} 株先挂起`
                      : `苗圃当时在库 ${stock.toLocaleString('zh-CN')} 株：本次领用可全部落实`
                  }
                />
              );
            }}
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plantDate" label="栽植日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="spacingM"
              label="株距（米）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写株距' }]}
            >
              <InputNumber min={0.2} max={10} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="count" label="领用株数" style={{ flex: 1 }} rules={[{ required: true, message: '请填写株数' }]}>
              <InputNumber min={1} max={500000} step={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="作业班组" rules={[{ required: true, message: '请填写作业班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>

          {density !== null ? (
            <Alert
              type={density.level === 'success' ? 'success' : density.level === 'warning' ? 'warning' : 'error'}
              showIcon
              message={`密度校验：${density.ok ? '合理' : '需要关注'}`}
              description={
                <span>
                  {density.message}
                  <br />
                  合理区间为 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株（按已落实株数计）。
                </span>
              }
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              填写株距与株数后会自动校验密度；挂起部分不占在库、不计入栽植总株数。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
