# ai.centos.hk 价格获取与费用计算流程

本文档记录如何从 `https://ai.centos.hk` 获取公开价格数据，并按该站点价格页的规则计算模型实际消费。文中的示例数据基于 2026-06-18 查询到的接口返回；后续如果站点调整模型倍率或分组倍率，应重新拉取接口数据后再计算。

## 1. 相关接口

### 1.1 价格接口

```bash
curl -Ls --max-time 20 https://ai.centos.hk/api/pricing
```

这个接口是价格页的主要数据来源。重点字段：

- `data`: 模型列表。
- `data[].model_name`: 模型名，例如 `gpt-5.5`。
- `data[].quota_type`: 计费类型，`0` 表示按 token 计费，`1` 表示按次计费。
- `data[].model_ratio`: 模型输入基础倍率。
- `data[].completion_ratio`: 输出/补全倍率。
- `data[].cache_ratio`: 缓存命中倍率。
- `data[].enable_groups`: 该模型可用分组。
- `group_ratio`: 各分组倍率。
- `usable_group`: 分组说明。

### 1.2 站点状态接口

```bash
curl -Ls --max-time 20 https://ai.centos.hk/api/status
```

这个接口用于确认站点展示配置。重点字段：

- `quota_display_type`: 当前额度展示币种。查询时为 `CNY`。
- `usd_exchange_rate`: 价格页按人民币展示时使用的汇率/换算倍率。查询时为 `1`。
- `quota_per_unit`: 额度余额展示换算用字段。查询时为 `500000`。
- `HeaderNavModules.pricing.enabled`: 是否启用公开价格页。

`quota_per_unit` 主要影响账号额度余额如何显示，不直接参与本文按价格页单价计算 token 消费的公式。

## 2. 获取某个模型的价格参数

从 `/api/pricing` 的 `data` 中找到目标模型：

```text
data[].model_name == "gpt-5.5"
```

2026-06-18 查询到的 `gpt-5.5` 关键参数：

```text
model_name       = gpt-5.5
quota_type       = 0
model_ratio      = 2.5
completion_ratio = 6
cache_ratio      = 0.1
enable_groups    = openai api, gpt-pro-fast, gpt-pro, codex特惠, OpenRouter官方
```

再从顶层 `group_ratio` 中取对应分组倍率：

```text
codex特惠      = 0.1
gpt-pro        = 0.3
gpt-pro-fast   = 0.6
openai api     = 2
OpenRouter官方 = 8
```

## 3. 按价格页规则计算单价

对 `quota_type = 0` 的按 token 计费模型，价格页使用以下规则展示每 1M tokens 单价。

基础输入价：

```text
输入价/1M = model_ratio × 2 × 分组倍率
```

输出价：

```text
输出价/1M = 输入价/1M × completion_ratio
```

缓存命中价：

```text
缓存命中价/1M = 输入价/1M × cache_ratio
```

人民币展示价：

```text
人民币价 = 上面算出的价格 × usd_exchange_rate
```

当前该站点 `usd_exchange_rate = 1`，所以计算值与人民币展示值一致。

## 4. gpt-5.5 当前分组单价

按 2026-06-18 接口数据，`gpt-5.5` 的分组单价如下：

| 分组 | 分组倍率 | 输入/1M | 缓存命中/1M | 输出/1M |
| --- | ---: | ---: | ---: | ---: |
| codex特惠 | 0.1x | ¥0.50 | ¥0.05 | ¥3.00 |
| gpt-pro | 0.3x | ¥1.50 | ¥0.15 | ¥9.00 |
| gpt-pro-fast | 0.6x | ¥3.00 | ¥0.30 | ¥18.00 |
| openai api | 2x | ¥10.00 | ¥1.00 | ¥60.00 |
| OpenRouter官方 | 8x | ¥40.00 | ¥4.00 | ¥240.00 |

示例，以 `codex特惠` 为例：

```text
输入价/1M = 2.5 × 2 × 0.1 = ¥0.50
缓存命中价/1M = 0.50 × 0.1 = ¥0.05
输出价/1M = 0.50 × 6 = ¥3.00
```

## 5. 用实际 token 用量计算消费

需要准备三类 token：

- 普通输入 Token: 未命中缓存的输入 token。
- 缓存命中 Token: prompt cache read / cached input token。
- 输出 Token: completion / output token。

如果统计里单独列出 `Reasoning Token`，通常不要再额外相加，因为 reasoning token 一般已经包含在输出 token 中。只有当站点日志明确把 reasoning 作为独立计费桶时，才需要另行处理。

通用公式：

```text
总费用 =
普通输入Token / 1,000,000 × 输入单价
+ 缓存命中Token / 1,000,000 × 缓存命中单价
+ 输出Token / 1,000,000 × 输出单价
```

也可以写成：

```text
普通输入M = 普通输入Token / 1,000,000
缓存命中M = 缓存命中Token / 1,000,000
输出M     = 输出Token / 1,000,000

总费用 = 普通输入M × 输入单价 + 缓存命中M × 缓存命中单价 + 输出M × 输出单价
```

## 6. gpt-5.5 实际用量示例

示例用量：

```text
普通输入 Token = 158,108,481
缓存命中 Token = 1,246,792,448
输出 Token     = 5,056,040
```

换算为百万 token：

```text
普通输入M = 158.108481
缓存命中M = 1246.792448
输出M     = 5.056040
```

代入 `gpt-5.5` 各分组单价：

| 分组 | 普通输入费用 | 缓存命中费用 | 输出费用 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| codex特惠 | ¥79.05 | ¥62.34 | ¥15.17 | ¥156.56 |
| gpt-pro | ¥237.16 | ¥187.02 | ¥45.50 | ¥469.69 |
| gpt-pro-fast | ¥474.33 | ¥374.04 | ¥91.01 | ¥939.37 |
| openai api | ¥1,581.08 | ¥1,246.79 | ¥303.36 | ¥3,131.24 |
| OpenRouter官方 | ¥6,324.34 | ¥4,987.17 | ¥1,213.45 | ¥12,524.96 |

以 `codex特惠` 为例，完整计算过程：

```text
158.108481 × 0.50
+ 1246.792448 × 0.05
+ 5.056040 × 3.00
= 79.0542405 + 62.3396224 + 15.16812
= ¥156.56
```

## 7. 复算检查清单

每次复算前建议按顺序检查：

1. 请求 `https://ai.centos.hk/api/pricing`。
2. 找到目标模型的 `model_ratio`、`completion_ratio`、`cache_ratio`。
3. 确认目标模型的 `enable_groups`，只计算该模型可用分组。
4. 从 `group_ratio` 读取每个可用分组的倍率。
5. 请求 `https://ai.centos.hk/api/status`，确认 `quota_display_type` 和 `usd_exchange_rate`。
6. 按 `输入价 = model_ratio × 2 × 分组倍率 × usd_exchange_rate` 计算输入单价。
7. 按 `缓存命中价 = 输入价 × cache_ratio` 计算缓存命中单价。
8. 按 `输出价 = 输入价 × completion_ratio` 计算输出单价。
9. 把实际 token 除以 `1,000,000` 后代入总费用公式。

## 8. 注意事项

- 这个流程只适用于该站点当前公开价格接口和价格页逻辑。
- 不同 New API 中转站可能关闭价格接口、要求登录、改接口路径，或修改前端展示公式。
- 同一个模型在不同分组价格差异可能很大，必须按实际使用分组计算。
- `auto` 分组不是固定价格，实际消费要看请求最终落到哪个分组；如果只做估算，应按可用分组中最低价或实际日志里的 `using_group` 分别计算。
- 价格接口返回的倍率会随站点运营调整变化，历史账单复算应使用对应日期的价格快照。
