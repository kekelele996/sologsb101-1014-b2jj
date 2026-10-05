/**
 * /plots/:id/seedlings 苗木批次台账（苗圃侧）
 * 苗圃只登记：进场数量与供苗保证率（自育苗可不考核，外购默认八成）。
 * 成活株数由项目部验收测次按领用摊回，最新批次成活率与对账数量只展示、不可在此编辑。
 * 消费模型：Seedling、Planting；复用组件：<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
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
import StatBadge from '../components/common/StatBadge';
import { usePlotStore } from '../stores/plotStore';
import {
  defaultGuaranteeRate,
  guaranteeRateText,
  GUARANTEE_RATE_MAX,
  GUARANTEE_RATE_MIN,
  PURCHASED_DEFAULT_GUARANTEE_RATE,
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type GuaranteeRate,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import { saveSeedling, removeSeedling } from '../utils/db';
import { ROUTES } from '../router';
import { muToM2, round1 } from '../utils/rate';

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
  /** 勾选 = 不考核（自育苗默认勾选）；取消勾选时按 guaranteeInput 考核 */
  exempt: boolean;
  guaranteeInput: number;
}

/** 参考密度：每平方米不超过 2 株（约 0.5 ㎡/株），用于批次数量提示 */
const MAX_PLANTS_PER_M2 = 2;

export default function SeedlingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const plantings = usePlotStore((state) => state.plantings);
  const seedlings = usePlotStore((state) => state.seedlings);
  const reconcile = usePlotStore((state) => state.reconcile);
  const refreshCounts = usePlotStore((state) => state.refreshCounts);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Seedling | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  const plotSeedlings = useMemo(
    () => seedlings.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [seedlings, id],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const committedQuantity = plotSeedlings.reduce((acc, row) => acc + (reconcile[row.id]?.committed ?? 0), 0);
  const pendingQuantity = plotSeedlings.reduce((acc, row) => acc + (reconcile[row.id]?.pending ?? 0), 0);

  const density = plot ? round1(totalQuantity / Math.max(1, muToM2(plot.areaMu))) : 0;
  const overloaded = plot !== undefined && density > MAX_PLANTS_PER_M2;

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
      arrivalDate: dayjs(),
      exempt: true,
      guaranteeInput: PURCHASED_DEFAULT_GUARANTEE_RATE,
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
      exempt: row.guaranteeRate === null,
      guaranteeInput: row.guaranteeRate ?? PURCHASED_DEFAULT_GUARANTEE_RATE,
    });
    setOpen(true);
  };

  const handleValuesChange = (changed: Partial<SeedlingFormValues>): void => {
    // 切换来源时自动给一个保证率默认值：自育苗不考核，外购八成
    if (changed.source !== undefined) {
      const next = defaultGuaranteeRate(changed.source);
      form.setFieldsValue({
        exempt: next === null,
        guaranteeInput: next ?? PURCHASED_DEFAULT_GUARANTEE_RATE,
      });
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const guaranteeRate: GuaranteeRate = values.exempt ? null : values.guaranteeInput;
      const row = await saveSeedling({
        id: editing?.id,
        draft: {
          plotId: id,
          species: values.species,
          source: values.source,
          spec: values.spec.trim(),
          quantity: values.quantity,
          guaranteeRate,
          arrivalDate: values.arrivalDate.format('YYYY-MM-DD'),
        },
      });
      message.success(
        editing === null
          ? `已登记苗木批次：${row.species} ${row.quantity} 株，供苗保证率 ${guaranteeRateText(row.guaranteeRate)}`
          : '苗木批次已更新，领用在库 / 挂起状态已按新进场数量重算',
      );
      await refreshCounts();
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    const bound = plantings.filter((item) => item.seedlingId === row.id).length;
    await removeSeedling(row.id);
    await refreshCounts();
    message.success(
      bound > 0 ? `已删除批次（同时清理了 ${bound} 条引用它的栽植记录与相关结算单）` : '已删除苗木批次',
    );
  };

  if (!ready) {
    return <Card loading title="苗木批次台账（苗圃侧）" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块。可能是链接已过期，或该地块已被删除。`}
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

  const columns: ColumnsType<Seedling> = [
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
      width: 90,
      render: (value: string) => <Tag color={value === '自育苗' ? 'cyan' : 'gold'}>{value}</Tag>,
    },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 150 },
    {
      title: '进场数量（株）',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 120,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '供苗保证率',
      dataIndex: 'guaranteeRate',
      key: 'guaranteeRate',
      width: 110,
      align: 'center',
      render: (value: GuaranteeRate) =>
        value === null ? <Tag>不考核</Tag> : <Tag color="geekblue">{value}%</Tag>,
    },
    {
      title: '已在库领用（株）',
      key: 'committed',
      width: 130,
      align: 'right',
      render: (_value, record) => (reconcile[record.id]?.committed ?? 0).toLocaleString('zh-CN'),
    },
    {
      title: '挂起（株）',
      key: 'pending',
      width: 100,
      align: 'right',
      render: (_value, record) => {
        const pending = reconcile[record.id]?.pending ?? 0;
        return pending > 0 ? <Tag color="orange">{pending.toLocaleString('zh-CN')}</Tag> : <span>0</span>;
      },
    },
    {
      title: '摊回成活率 / 保证率',
      key: 'batchRate',
      width: 200,
      render: (_value, record) => {
        const item = reconcile[record.id];
        if (!item || !item.latest) return <Typography.Text type="secondary">暂无验收</Typography.Text>;
        const latest = item.latest;
        const short = latest.shortRate > 0;
        return (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Tooltip title={`第 ${latest.round} 测次（${latest.date}）成活株数按领用摊回`}>
                <Tag color={short ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                  {latest.rate.toFixed(1)}%
                </Tag>
              </Tooltip>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                / {guaranteeRateText(item.guaranteeRate)}
              </Typography.Text>
            </Space>
            {short ? (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                差 {latest.shortRate.toFixed(1)} 点 · {latest.shortCount} 株
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '进场日期',
      dataIndex: 'arrivalDate',
      key: 'arrivalDate',
      width: 110,
      sorter: (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="引用该批次的栽植记录与相关结算单会被一并清理。"
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

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name}
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>{plot.substrate}</Tag>
        <Tag color="blue">{plot.restoreMode}</Tag>
        <Typography.Text type="secondary">
          面积 {plot.areaMu} 亩（{Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡）
        </Typography.Text>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="苗圃侧台账：只管进场数量与供苗保证率"
        description="成活率由项目部按整块地做验收测次，再按领用摊回本批；低于保证率的差额会自动生成结算单，等项目部确认。自育苗可登记为「不考核」，外购默认按八成登记。"
      />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={plotSeedlings.length} suffix="批" tone="primary" />
        <StatBadge label="进场苗木合计" value={totalQuantity.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="已在库领用"
          value={committedQuantity.toLocaleString('zh-CN')}
          suffix="株"
          percent={totalQuantity > 0 ? (committedQuantity / totalQuantity) * 100 : 0}
          tone="success"
          hint="领用累计未超进场数量的部分，参与测次成活株数摊回"
        />
        <StatBadge
          label="挂起领用"
          value={pendingQuantity.toLocaleString('zh-CN')}
          suffix="株"
          tone={pendingQuantity > 0 ? 'danger' : 'default'}
          hint="超出进场数量的领用先挂起，不参与摊回；苗圃补足进场数量后自动恢复在库"
        />
        <StatBadge
          label="批次密度"
          value={density}
          suffix="株/㎡"
          tone={overloaded ? 'danger' : 'default'}
          hint={`地块面积 ${plot.areaMu} 亩，建议每平方米不超过 ${MAX_PLANTS_PER_M2} 株`}
        />
      </div>

      {overloaded ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="苗木批次数量偏多"
          description={`当前地块累计进场 ${totalQuantity} 株，折算密度 ${density} 株/㎡，已超过 ${MAX_PLANTS_PER_M2} 株/㎡ 的参考上限。请核对规格与数量，或拆分到其他地块。`}
        />
      ) : null}

      <Card
        title="苗木批次与供苗保证率"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记苗木批次
          </Button>
        }
      >
        {plotSeedlings.length === 0 ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="苗圃在此登记进场苗木的树种、来源、规格、进场数量与供苗保证率，项目部领用栽植时只能挑在库批次。"
            actionText="登记第一批苗木"
            onAction={openCreate}
          />
        ) : (
          <Table<Seedling>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={plotSeedlings}
            scroll={{ x: 1400 }}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '登记苗木批次（苗圃侧）' : '编辑苗木批次'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" onValuesChange={(changed) => handleValuesChange(changed)}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="source" label="来源" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SOURCE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格" rules={[{ required: true, message: '请填写苗木规格' }]}>
            <Input placeholder="如：50cm 裸根苗 / 40cm 营养袋苗" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="quantity"
              label="进场数量（株）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写数量' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="arrivalDate"
              label="进场日期"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择进场日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Form.Item label="供苗保证率" style={{ marginBottom: 6 }}>
            <Space size={12} wrap>
              <Form.Item name="exempt" valuePropName="checked" noStyle>
                <Checkbox>不考核（自育苗）</Checkbox>
              </Form.Item>
              <Form.Item
                noStyle
                shouldUpdate={(prev, next) => prev.exempt !== next.exempt}
              >
                {({ getFieldValue }) =>
                  getFieldValue('exempt') ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      该批次不参与结算差额考核
                    </Typography.Text>
                  ) : (
                    <Space size={6}>
                      <Form.Item name="guaranteeInput" noStyle rules={[{ required: true }]}>
                        <InputNumber
                          min={GUARANTEE_RATE_MIN}
                          max={GUARANTEE_RATE_MAX}
                          step={1}
                          style={{ width: 110 }}
                          addonAfter="%"
                        />
                      </Form.Item>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        外购默认 {PURCHASED_DEFAULT_GUARANTEE_RATE}%，低于该保证率的差额将进结算单
                      </Typography.Text>
                    </Space>
                  )
                }
              </Form.Item>
            </Space>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存后，项目部已登记的领用会按新进场数量重算在库 / 挂起；测次成活株数按在库领用摊回本批。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
