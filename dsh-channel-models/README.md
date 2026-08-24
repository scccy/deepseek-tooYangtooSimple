# dsh-channel-models

DSH 自定义渠道模型发现与推理等级补充插件。

## 功能

- 在设置中新增“渠道模型”页面。
- 通过 `llm-pi-ai` 的正式模型发现接口读取 OpenAI 兼容渠道的模型列表。
- 支持协议：`openai-completions`、`openai-responses`、`anthropic-messages`。其中 `anthropic-messages` 没有模型列表接口，需使用“手动添加模型”逐个填写。
- 自动尝试填写的 API 地址及其 `/v1` 变体。
- 根据 DSH 当前模型目录中相同模型 ID 的权威 metadata 补全可选推理等级。
- 支持逐模型调整 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- 支持逐模型声明图片输入（多模态）能力：创建渠道时勾选“支持图片”的模型会写入 `input: [text, image]`，否则默认按文本模型处理。
- 通过 DSH credentials 服务保存 API 密钥，通过 `llm-pi-ai` settings namespace 保存渠道配置。

## 使用

1. 打开“设置 → 渠道模型”。
2. 填写 Provider ID、显示名称、API 地址、协议和 API 密钥。
3. 点击“获取渠道模型”。
4. 选择需要加入目录的模型并确认各模型的推理等级。
5. 点击“新增自定义渠道”。

API 密钥只用于渠道探测和凭据服务写入，不会写进插件源码、settings 文档或接口响应。

模型列表接口通常只返回 ID，无法证明模型支持哪些推理等级。本插件只从当前已注册适配器中同 ID 模型的 `resolveModelInfo()` metadata 补全；未识别模型默认不声明推理能力，用户可在创建前显式选择。

图片能力同理：若当前模型目录中有同 ID 模型声明了 `image` 输入模态，插件会在发现列表里默认勾选“支持图片”；自定义渠道的同 ID 模型可能是不同变体，勾选结果仅为提示，请以网关实际能力为准手动确认。
