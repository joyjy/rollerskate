# Run 中的 Jev 判断工具

Codex Run 使用 `evaluate_jev` 调用固定 TypeSafe API。工具支持 Choice、Noul 和 Score。工具返回原始响应，保留实际模型名、答案分布与用量。

## 准入与凭证

Run 必须显式获得 `workspaceGrant.networkAccess=true`。Chat 和 Subscription 不装配这个工具。凭证文件默认是 `<runtime>/jev.env`。Host 使用 `RS_JEV_ENV_FILE` 指定其他绝对路径。文件只需包含 `TYPESAFE_API_KEY`。工具进程读取密钥，参数和结果不包含密钥。

调用方只发送判断所需且不含真实敏感信息的内容。调用前移除凭据、个人身份信息和其他真实敏感信息。内部业务语义本身不阻止调用。工具不自动识别全部敏感信息。

## 输入与结果

输入包含 `state`、`questions` 和可选 `model`。默认模型为 `jev-latest`。一次调用最多 32 个问题。请求和响应分别不超过 128 KiB。

一次调用的总预算为 20 秒，包括重试与读取响应。HTTP 429 和 529 最多重试 2 次。认证失败、输入错误、网络故障和无效响应返回工具错误。错误不表示“无需回复”。工具不返回上游错误正文。

Worker 在 Run 产物中保存原始响应、问题版本和输入摘要。Tandem 负责验证事项版本、来源水位和指示版本。响应超过 Run output 的 32 KiB 上限时，使用已有 `artifactRefs` 引用产物文件。文件只保存产物，不保存第二套执行状态。

## 停止与发布

HTTP client 支持 AbortSignal，工具进程退出时停止请求。当前 Run 取消回执不证明在途 provider 调用已退出。调用方必须拦截取消后的迟到结果。

源码接入不自动修改运行配置，也不恢复监控。使用前核对运行版本、凭证引用和 Run 权限。通过脱敏样本验证后，按原授权边界重载 Runtime。
