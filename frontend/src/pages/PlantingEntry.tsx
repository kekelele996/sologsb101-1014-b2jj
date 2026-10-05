/**
 * /plots/:id/plantings 栽植领用记录（项目部侧）
 * 项目部只登记栽植领用：挑苗圃当时在库的批次，录株距与株数并即时提示栽植密度。
 * 累计领用超出批次进场数量的整笔先「挂起」（不参与测次成活株数摊回），等苗圃补足进场数量后自动恢复在库。
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
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import { removePlanting, savePlanting } from '../utils/db';
import type { Planting } from '../types/planting';
import { guaranteeRateText } from '../types/seedling';
import { ROUTES } from '../router';
import {
  DENSITY_MAX_M2_PER_PLANT,
  DENSITY_MIN_M2_PER_PLANT,
  checkDensity,
  muToM2,
  type DensityCheck,
} from '../utils/rate';

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
  const allSeedlings = usePlotStore((state) => state.seedlings);
  const allPlantings = usePlotStore((state) => state.plantings);
  const reconcile = usePlotStore((state) => state.reconcile);
  const refreshCounts = usePlotStore((state) => state.refreshCounts);

  const plotSeedlings = useMemo(
    () =>
      allSeedlings
        .filter((row) => row.plotId === id)
        .sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [allSeedlings, id],
  );
  const plotPlantings = useMemo(
    () =>
      allPlantings
        .filter((row) => row.plotId === id)
        .sort((a, b) => b.plantDate.localeCompare(a.plantDate)),
    [allPlantings, id],
  );

  const [keyword, setKeyword] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Planting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [density, setDensity] = useState<DensityCheck | null>(null);
  const [form] = Form.useForm<PlantingFormValues>();

  const operatorOptions = useMemo(
    () => Array.from(new Set(plotPlantings.map((row) => row.operator).filter((item) => item !== ''))),
    [plotPlantings],
  );

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return plotPlantings.filter((row) => {
      if (operatorFilter !== 'all' && row.operator !== operatorFilter) return false;
      if (key === '') return true;
      const species = plotSeedlings.find((item) => item.id === row.seedlingId)?.species ?? '';
      return (
        row.operator.toLowerCase().includes(key) ||
        species.toLowerCase().includes(key) ||
        row.plantDate.includes(key)
      );
    });
  }, [plotPlantings, plotSeedlings, keyword, operatorFilter]);

  const totalCount = plotPlantings.reduce((acc, row) => acc + row.count, 0);
  const activeCount = plotPlantings
    .filter((row) => row.status === 'active')
    .reduce((acc, row) => acc + row.count, 0);
  const pendingCount = totalCount - activeCount;
  const avgSpacing =
    plotPlantings.length === 0
      ? 0
      : Math.round((plotPlantings.reduce((acc, row) => acc + row.spacingM, 0) / plotPlantings.length) * 100) / 100;
  const usedSeedlingIds = new Set(plotPlantings.map((row) => row.seedlingId));

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = plotSeedlings.find((row) => row.id === seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  /** 新建领用时只允许挑苗圃当时「还有在库余量」的批次 */
  const selectableSeedlings = useMemo(
    () => plotSeedlings.filter((row) => (reconcile[row.id]?.available ?? row.quantity) > 0),
    [plotSeedlings, reconcile],
  );

  const openCreate = (): void => {
    setEditing(null);
    setDensity(null);
    form.setFieldsValue({
      ...DEFAULT_VALUES,
      seedlingId: selectableSeedlings.length > 0 ? selectableSeedlings[0].id : '',
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
    setDensity(plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.count));
    setOpen(true);
  };

  const handleValuesChange = (): void => {
    if (plot === undefined) return;
    const values = form.getFieldsValue();
    setDensity(checkDensity(plot.areaMu, values.spacingM, values.count));
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const seedling = plotSeedlings.find((row) => row.id === values.seedlingId);
      const row = await savePlanting({
        id: editing?.id,
        draft: {
          plotId: id,
          seedlingId: values.seedlingId,
          plantDate: values.plantDate.format('YYYY-MM-DD'),
          spacingM: values.spacingM,
          count: values.count,
          operator: values.operator.trim(),
        },
      });
      await refreshCounts();
      if (row.status === 'pending') {
        message.warning(
          `该批次进场仅 ${seedling?.quantity ?? 0} 株，本笔 ${row.count} 株超出余量，已先挂起 ${row.overQuantity} 株；补足进场数量后自动恢复在库。`,
          8,
        );
      } else {
        message.success(editing === null ? `已登记栽植 ${row.count} 株` : '栽植记录已更新');
      }
      const check = plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.count);
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

  if (!ready) {
    return <Card loading title="栽植领用记录" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法登记栽植记录。`}
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
      width: 110,
      sorter: (a, b) => a.plantDate.localeCompare(b.plantDate),
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 190,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{seedlingLabel(record.seedlingId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {plotSeedlings.find((item) => item.id === record.seedlingId)?.source ?? '—'} · 进场{' '}
            {plotSeedlings.find((item) => item.id === record.seedlingId)?.quantity ?? 0} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '领用状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (value: Planting['status'], record) =>
        value === 'pending' ? (
          <Tooltip title={`超出进场数量 ${record.overQuantity} 株，先挂起，不参与测次摊回`}>
            <Tag color="orange">挂起 {record.overQuantity} 株</Tag>
          </Tooltip>
        ) : (
          <Tag color="green">在库</Tag>
        ),
    },
    {
      title: '株距（米）',
      dataIndex: 'spacingM',
      key: 'spacingM',
      width: 90,
      align: 'right',
      render: (value: number) => value.toFixed(2),
    },
    {
      title: '株数',
      dataIndex: 'count',
      key: 'count',
      width: 90,
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '平均单株占地',
      key: 'perPlant',
      width: 130,
      align: 'right',
      render: (_value, record) => `${checkDensity(plot.areaMu, record.spacingM, record.count).areaPerPlant} ㎡/株`,
    },
    {
      title: '密度校验',
      key: 'densityCheck',
      width: 100,
      render: (_value, record) => {
        const check = checkDensity(plot.areaMu, record.spacingM, record.count);
        return (
          <Tag color={check.level === 'success' ? 'green' : check.level === 'warning' ? 'orange' : 'red'}>
            {check.ok ? '合理' : check.level === 'warning' ? '偏疏' : '异常'}
          </Tag>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 100 },
    {
      title: '操作',
      key: 'action',
      width: 140,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该栽植记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await removePlanting(record.id);
              await refreshCounts();
              message.success('栽植记录已删除');
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
          {plot.name} · 栽植领用记录
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>
          {plot.areaMu} 亩 / {Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡
        </Tag>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="项目部侧台账：只管栽植领用与验收测次"
        description="领用时只能挑苗圃当时在库、有余量的批次；按栽植日期累计超出进场数量的领用先挂起，不参与测次成活株数摊回，等苗圃补足进场数量后自动恢复在库。"
      />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="栽植记录" value={plotPlantings.length} suffix="条" tone="primary" />
        <StatBadge label="栽植总株数" value={totalCount.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="在库领用"
          value={activeCount.toLocaleString('zh-CN')}
          suffix="株"
          tone="success"
          hint="参与整块地成活率与批次摊回"
        />
        <StatBadge
          label="挂起领用"
          value={pendingCount.toLocaleString('zh-CN')}
          suffix="株"
          tone={pendingCount > 0 ? 'danger' : 'default'}
        />
        <StatBadge label="平均株距" value={avgSpacing.toFixed(2)} suffix="米" tone="default" />
        <StatBadge
          label="已引用批次"
          value={`${usedSeedlingIds.size} / ${plotSeedlings.length}`}
          percent={plotSeedlings.length > 0 ? (usedSeedlingIds.size / plotSeedlings.length) * 100 : 0}
          tone="default"
          size="small"
          hint="已被栽植记录引用的苗木批次占全部批次的比例"
        />
      </div>

      {plotSeedlings.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="该地块尚未登记苗木批次"
          description="栽植记录必须引用一个苗木批次，请先到苗木批次页由苗圃登记进场苗木。"
          action={
            <Button size="small" onClick={() => navigate(ROUTES.seedlings(plot.id))}>
              去登记苗木批次
            </Button>
          }
        />
      ) : null}

      <Card
        title="栽植领用记录"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plotSeedlings.length === 0}>
            新增栽植记录
          </Button>
        }
      >
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[{ key: 'operator', label: '班组', options: operatorOptions }]}
          values={{ operator: operatorFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'operator') setOperatorFilter(value);
          }}
          onReset={() => {
            setKeyword('');
            setOperatorFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${plotPlantings.length} 条`}
        />

        {plotPlantings.length === 0 ? (
          <EmptyPanel
            title="该地块还没有栽植记录"
            description="从苗圃在库批次里挑选苗木，录入栽植日期、株距与株数，系统会按地块面积自动校验栽植密度是否合理。"
            actionText="新增栽植记录"
            onAction={openCreate}
          />
        ) : (
          <Table<Planting>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1280 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的栽植记录"
                  actionText="重置筛选"
                  onAction={() => {
                    setKeyword('');
                    setOperatorFilter('all');
                  }}
                />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新增栽植领用记录' : '编辑栽植记录'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} onValuesChange={handleValuesChange}>
          <Form.Item name="seedlingId" label="苗木批次（只列苗圃当时在库、有余量的批次）" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              placeholder="选择该地块下在库的苗木批次"
              options={plotSeedlings.map((row) => {
                const item = reconcile[row.id];
                const available = item?.available ?? row.quantity;
                const inStock = available > 0;
                return {
                  value: row.id,
                  disabled: editing === null && !inStock,
                  label: `${row.species} · ${row.spec} · 进场 ${row.quantity} 株 · 在库余量 ${Math.max(
                    0,
                    available,
                  )} 株（${row.source} / ${guaranteeRateText(row.guaranteeRate)}）${inStock ? '' : ' · 已无在库余量'}`,
                };
              })}
            />
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
            <Form.Item name="count" label="株数" style={{ flex: 1 }} rules={[{ required: true, message: '请填写株数' }]}>
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
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
                  本笔若按栽植日期累计后超出批次进场数量，会整笔先挂起，不参与测次成活株数摊回。
                  <br />
                  合理区间为 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株。
                </span>
              }
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              填写株距与株数后会自动校验密度（合理区间 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT}{' '}
              ㎡/株）；超出在库余量的领用先挂起。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
