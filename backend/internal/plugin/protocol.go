package plugin

// ProtocolVersion 宿主 ↔ 外部插件进程之间的通信协议版本（Unix socket + JSON）。
//
// 插件通过 /meta 的 apiVersion 字段自报它编译时用的协议版本；宿主在注册时校验两者相等，
// 不相等（含旧 SDK 缺省 0）就拒绝加载并给出明确错误，避免「版本对不上却勉强跑」导致的
// 诡异故障。**只有破坏性改动才 +1**（新增可选字段不算）。
const ProtocolVersion = 1
