// 原型样本数据（M2 视觉还原用；真实热榜/搜索后端在 M3/M4 接入）。
// 来源：prototype/index.html HOT_LISTS / SEARCH / PLAT_COLORS

export const PLAT_COLORS: Record<string, string> = {
  // 选题表、热门页统一使用此映射。四个平台必须一眼可区分，
  // 不再让抖音 / 小红书 / 微博都落到相近的红色系。
  抖音: '#7c3aed',
  小红书: '#f43f5e',
  微博: '#f97316',
  知乎: '#2563eb',
  搜索: '#888888',
};

export interface HotItem {
  t: string;
  heat: string;
  tag?: string;
  link?: string;
}
export interface SearchItem {
  t: string;
  l: string;
  c: string;
  tags: string[];
  url?: string;
}

export const HOT_LISTS: Record<string, HotItem[]> = {
  抖音: [
    { t: '淄博烧烤为什么又上热搜了', heat: '128.5w', tag: '民生' },
    { t: '端午高速免费通行时间定了', heat: '96.2w', tag: '民生' },
    { t: '年轻人开始流行「公园 20 分钟」', heat: '88.0w', tag: '生活' },
    { t: '演唱会门票为什么这么难抢', heat: '74.3w', tag: '娱乐' },
    { t: '618 预售今晚零点开启', heat: '69.1w', tag: '经济' },
    { t: 'AI 写真滤镜翻车现场', heat: '58.7w', tag: '科技' },
    { t: '县城咖啡店火出圈', heat: '52.4w', tag: '经济' },
    { t: '宠物经济爆发式增长', heat: '47.9w', tag: '经济' },
    { t: '国货美妆集体涨价', heat: '43.2w', tag: '经济' },
    { t: 'City Walk 路线推荐清单', heat: '39.8w', tag: '生活' },
  ],
  小红书: [
    { t: '人生第一套房装修避坑', heat: '42.1w', tag: '生活' },
    { t: '打工人带饭一周不重样', heat: '38.6w', tag: '生活' },
    { t: '百元平价香水推荐', heat: '35.2w', tag: '种草' },
    { t: '露营装备清单分享', heat: '31.0w', tag: '生活' },
    { t: '通勤穿搭公式', heat: '28.7w', tag: '穿搭' },
    { t: '租房改造前后对比', heat: '25.4w', tag: '家居' },
    { t: '副业搞钱思路整理', heat: '23.1w', tag: '搞钱' },
    { t: '极简生活收纳法', heat: '21.6w', tag: '生活' },
    { t: '云南小众旅行攻略', heat: '19.8w', tag: '旅行' },
    { t: '护肤踩雷合集', heat: '17.3w', tag: '种草' },
  ],
  微博: [
    { t: '#端午假期天气#', heat: '210.4w', tag: '民生' },
    { t: '某商场扶梯故障致伤', heat: '156.7w', tag: '社会' },
    { t: '考研报名人数连续两年下降', heat: '132.2w', tag: '教育' },
    { t: '预制菜进校园争议', heat: '118.9w', tag: '民生' },
    { t: '演唱会退票难维权', heat: '98.3w', tag: '娱乐' },
    { t: '高温补贴发放标准', heat: '87.5w', tag: '民生' },
    { t: '养老金上调方案', heat: '76.1w', tag: '民生' },
    { t: '新能源汽车下乡', heat: '69.8w', tag: '经济' },
    { t: '数字人民币试点扩围', heat: '61.4w', tag: '经济' },
    { t: '文旅市场强劲复苏', heat: '54.2w', tag: '经济' },
  ],
  知乎: [
    { t: '为什么年轻人不愿结婚了', heat: '45.6w', tag: '社会' },
    { t: '房价还会继续跌吗', heat: '42.3w', tag: '经济' },
    { t: '新能源汽车真的省钱吗', heat: '39.1w', tag: '经济' },
    { t: '该不该提前还房贷', heat: '35.7w', tag: '经济' },
    { t: '普通人如何开始理财', heat: '32.4w', tag: '经济' },
    { t: 'AI 会取代哪些工作', heat: '29.8w', tag: '科技' },
    { t: '如何判断一家公司经营状况', heat: '26.5w', tag: '职场' },
    { t: '公务员和程序员怎么选', heat: '24.1w', tag: '职场' },
    { t: '怎么理解通货膨胀', heat: '21.7w', tag: '经济' },
    { t: '远程办公的利弊', heat: '19.2w', tag: '职场' },
  ],
};

export const SEARCH: SearchItem[] = [
  { t: '端午回家发现家里 WiFi 又崩了，师傅一句话点醒我', l: '7.3w', c: '2100', tags: ['硬指标', '短平快', '权威'] },
  { t: '装维师傅悄悄说的路由器摆放技巧', l: '5.1w', c: '1400', tags: ['短平快'] },
  { t: '某品牌宽带提速广告，看着像营销', l: '1.1w', c: '300', tags: ['营销号⚠'] },
  { t: '广东电信端午网络保障现场记录', l: '4.4w', c: '980', tags: ['硬指标', '权威'] },
];
