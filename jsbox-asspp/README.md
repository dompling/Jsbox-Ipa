# JAsspp 0.2.1（JSBox App Store 客户端）

> **AI 构建声明**：本项目由 AI 全程构建，包括代码、测试、文档和发布流程。使用前请自行审查代码并在目标设备上验证。

JAsspp 是一个运行在 [JSBox](https://docs.xteko.com) 内的 App Store 客户端实验项目，组合了 Asspp 的交互方式与 `ipatool-sapfix` 使用的 Apple Store 协议。

它目前提供：

- 全屏启动；首页按模块使用圆角卡片，免费、付费、畅销榜的首位大卡片分别为蓝、紫、橙色，支持系统深浅色。
- 自定义顶部导航隐藏宿主播放和关闭按钮；子页保留返回，“已购”和“搜索”的圆形账号头像位于右上角。
- 多区域 App Store 浏览，支持名称、Bundle ID 和数字 App ID 搜索。
- 多 Apple ID 会话管理，以及 Apple 要求时的六位双重认证流程。
- “已购”每次显示 20 条，滚动从完整缓存继续加载；支持下拉刷新、完整 App 标题搜索及头像切换账号，底部仅显示实际加载状态。
- 已购卡片分三行显示版本、Bundle ID 和购买日期；详情的信息、简介按模块使用圆角卡片。
- 已购记录按账号和地区分别缓存，15 分钟内复用；过期时先显示缓存再更新，下拉可立即刷新。
- 登录时内置 scripting 版同源的 SAP ActionSignature 引擎；签名资源在扩展包内，
  不依赖 `/tmp` 或外部临时目录。
- 已购记录通过单独配置的 SAP 签名服务处理，支持局域网或远程服务器；登录仍使用内置签名引擎。
- 免费 App 的首次许可证获取、已有许可的免费／付费 App 下载，以及 Apple 仍提供的历史版本。
- 下载信息优先使用 `downloaddispatch.itunes.apple.com/r/redownload`，失败后由现有 `volumeStoreDownloadProduct` 接口兜底。
- 历史版本页立即显示加载动画，先列出构建 ID，再逐条补全版本号；失败保留已显示的 ID，可重试继续补全。
- IPA 本地库、sidecar 元数据、重复文件自动改名、分享和删除；“已下载”显示已注入 SINF 的包，原始包在独立“归档”页管理。
- 下载任务与本地 IPA 显示实际下载账号；已下载列表使用正常 App 名称和信息，不追加注入标记。
- 同一 App 的对应版本已下载时显示“打开”，进入与下载列表一致的文件操作菜单。
- 获取／打开使用紧凑胶囊，保留 44pt 点击区域和行内下载进度。
- 历史任务按原账号和版本重试，同一目标的进行中下载会合并，页面返回时保留列表状态。
- 下载列表和获取按钮的进度区域均可取消下载，取消前二次确认；失败任务支持删除记录。
- IPA 操作菜单保留“OTA 安装”；缺少验证信息时点击显示原因，已验证文件进入安装确认。
- **实验性** OTA：按 IPA-Tool-3.0 使用 HTTPS Plist 服务，并始终提供“分享 IPA”退路。

> 仅供协议研究与个人学习。项目调用 Apple 非公开接口，可能随时失效，也存在账号风控风险。建议只使用次要 Apple ID，不要泄露设备 GUID、Cookie、DSID 或登录令牌。

## 首次获取与重新下载

“本地没有 IPA”和“Apple ID 没有许可证”是两种情况。客户端先尝试当前账号的已有许可，只有 Apple 返回无许可时才进入免费获取流程。

| App 状态 | 处理方式 |
| --- | --- |
| 账号已有许可，本地尚未下载 | 直接下载；包括已购买的付费 App |
| 账号从未获取免费 App | 确认价格为 0 后获取一次免费许可，再重试原版本 |
| 价格未知 | 按账号区域补查；无法确认免费时不获取许可 |
| 付费 App 尚未购买 | 打开 App Store 完成购买，再返回重试 |
| App 已下架或历史版本已移除 | 尝试已有许可；能否下载取决于 Apple 是否仍提供资源 |

遇到账号条款或首次获取限制，可先在 App Store 获取，再返回下载。免费获取不会处理付费购买、订阅或 App 内购买。

依据：[Apple 下载说明](https://support.apple.com/en-us/102590)、[Apple 重新下载说明](https://support.apple.com/en-us/102417)、[ipatool 的许可说明](https://github.com/majd/ipatool/wiki/FAQ)。Apple 官方说明适用于 App Store 操作，不保证本项目调用的私有接口。

## 这次安全与可靠性调整

### 账号与认证

- Apple ID 密码不写入 `$prefs`。现有登录页默认开启“记住密码，失效时自动重新登录”；开启后密码保存在独立 Keychain 项，关闭后登录或删除账号会清理该项。此登录行为本轮未修改。
- `passwordToken`、Cookie、DSID、设备 GUID 等必要会话数据保存在 Keychain；`$prefs` 只保存邮箱索引和“区域 → 邮箱”绑定。
- 旧版 `jasspp.accounts.v2` 明文会话会迁移到 Keychain，旧版遗留的 `password.*` 项会在账号列表加载时清理。
- 账号索引损坏或写入中断时，会尝试用 `$keychain.keys()` 重建；损坏但仍存在的会话不会被静默覆盖，账号页会显示橙色修复提示。
- 删除和清空账号使用快照与回滚，降低 Keychain / `$prefs` 跨存储操作出现半提交状态的概率。
- 不再把其他 storefront 的任意账号静默用于当前区域。下载某一区域的 App 必须存在同一区域账号。
- 自定义认证地址必须是 `itunes.apple.com` 或其子域名、标准 443 端口、无 URL 内嵌凭据的 HTTPS 地址。
- 自动重定向后的最终地址也会重新检查；认证 POST 不会由应用代码主动重放到非 Apple、HTTP 或自定义端口地址。

### Cookie

- Cookie 按 `name + domain + path` 合并，不再只按名称互相覆盖。
- host-only Cookie 会绑定响应来源主机；服务端不能为无关域名设置 Cookie。
- 旧版缺少 domain 的 Cookie 仅迁移到 `itunes.apple.com` 范围，不会发送给任意站点。
- 支持合并响应中的多条 `Set-Cookie`，并正确处理 `Expires` 内的逗号。
- `Max-Age` 优先于 `Expires`；发送时按 path 长度排序，并过滤过期、Secure 和异常字段。

### IPA 本地库

- IPA 保存到 `downloads/`，每个文件旁边使用 `<文件名>.meta.json` 保存元数据。
- 下载账号随元数据保存，生成授权副本时沿用，切换当前账号不会改变旧记录。旧记录可从已存的 XML iTunesMetadata 恢复账号；缺少可解析记录时显示“未知”。
- 下载先写临时文件，再按“IPA → 元数据”顺序提交；进程若在中间退出，IPA 会作为“元数据待恢复”文件显示，而不是被隐藏。
- 同名文件自动使用 `_2`、`_3` 等后缀，避免静默覆盖。
- 文件名经过路径穿越检查；sidecar 不能把一个物理 IPA 冒充成另一个文件。
- 删除时先删除 sidecar，再删除 IPA。若 IPA 删除失败，文件仍会作为可见的待恢复项目保留。
- 旧版 `$prefs` 库索引会迁移为 sidecar；损坏 sidecar 不会阻止恢复物理 IPA。
- 下载响应会检查 HTTP 状态、最终 HTTPS 地址、明显错误的内容类型、实际/预期长度以及可用时的 ZIP 头尾结构。
- 大文件在服务端支持 Range 时按 4 MiB 分段，核对每段范围与实际长度；有强 ETag 时使用条件请求防止中途资源变化。分段校验失败会结束任务并清理临时文件，不再自动整包重试。
- 结构校验和版本元数据校验分别记录。请求的历史版本 ID 不冒充响应 ID，SINF 副本沿用原包的验证状态。
- 文件按 `sinfInjected` 标记分组，不移动已有文件；未注入、导入和待恢复的包都在“归档”。归档支持分享、删除，以及有授权数据时重新注入；生成的副本显示在“已下载”。
- 取消接受到原始 IPA 首次保存前；确认后停止后续下载步骤并清理临时文件，在途认证响应先保存 Cookie。已进入保存和 SINF 注入阶段的文件继续完成处理。
- 下载接口依次尝试 redownload、volumeStore；空项目、缺少 URL/SINF 和历史版本不匹配也会触发兜底。切换时保留响应 Cookie，取消后不再发送兜底请求；历史元数据查询允许没有 URL/SINF。

> `downloads/` 位于该 JSBox 扩展自己的沙盒中，并不是永久备份。删除或重命名扩展、清理 JSBox 数据或系统回收数据时，本地 IPA 可能一起丢失。重要文件请及时分享至“文件”、iCloud Drive 或其他备份位置。

## OTA 的真实定位

OTA 菜单现在明确标记为“实验性”，不会把“已唤起链接”描述成“安装成功”。
当前流程是：

1. 为单次请求生成随机 24 位 token。
2. 在固定 `localhost:8000` 的 JSBox `$server` 上临时提供 `/<token>/manifest.plist`、`/<fileName>` 和图标。
3. 仅接受 `GET` / `HEAD`；若 JSBox 能提供远端地址，只接受明确的 loopback 地址。
4. 响应使用 `no-store`，服务在 15 分钟后自动停止；脚本退出时也会停止。
5. 使用设置中的 HTTPS Plist 服务（默认 `api.scripting.fun`）生成 manifest，再通过 `itms-services://` 向 iOS **发起**安装请求。

这里有两个无法在当前纯 JSBox 实现中回避的限制：

- JSBox `$server` 只提供 HTTP。现代 iOS 通常要求 OTA manifest 和软件包使用受信任的 HTTPS，因此系统可能在读取清单前就拒绝。
- Apple 下载响应中的 SINF 与 iTunesMetadata 会被解析。下载分两步：先保存
  未注入的原始包，再自动生成「已注入SINF」副本（整体解压 + 重新打包，
  第一版为实验性实现）。重新打包结果受 JSBox `$archiver` 能力限制，仍需
  真机验证；注入失败时原始包始终保留，可点按“修复授权”再次尝试。

“已注入SINF”副本带有当前 Apple ID 的授权数据；原始包和注入失败的包不能据此视为已授权。安装与打开仍取决于 iOS、设备状态和签名／SINF。

## 功能与参考项目

| JAsspp 功能 | 主要参考 |
| --- | --- |
| 搜索、lookup、RSS 榜单 | iTunes 公开接口、`ipatool-sapfix/pkg/appstore` |
| Apple ID plist 认证与 2FA | `IPA-Tool-3.0/services/appleStore/domains/AuthService.ts`、ipatool 登录流程 |
| 免费许可证购买 | `appstore_purchase.go`、Lakr233/Asspp `ApplePackage/Commands/Purchase.swift` |
| volumeStore / redownload 下载 | `appstore_download.go`、Lakr233/Asspp `ApplePackage/Commands/Download.swift` |
| 历史 `externalVersionId` | `appstore_list_versions.go`、Lakr233/Asspp `ApplePackage/Commands/VersionFinder.swift` |
| App Store 已购记录 | `ipatool` `appstore_owned_apps.go` 的 Purchase DAAP / DMAP 协议 |
| manifest 结构 | Asspp Installer / Lakr233/Asspp 对应实现 |

`5002` 会按既有 ipatool 行为视为“许可证已存在”；购买的 `2059` 回退会从 `STDQ` 改用 `GAME`，并携带第一次响应刷新后的 Cookie。

## 目录结构

```text
jsbox-asspp/
├── main.js
├── config.json
├── assets/
│   ├── icon-source.svg
│   ├── icon.png
│   ├── icon57.png
│   ├── icon512.png
│   └── sap/                # SAP WASM/Unicorn 签名引擎（登录时按需加载）
├── scripts/
│   ├── config.js
│   ├── apple/              # bag / auth / purchase / download / public store
│   ├── lib/                # plist / cookies / HTTP / OTA manifest / format
│   ├── services/           # 下载编排与临时 OTA 服务
│   ├── store/              # 设置、Keychain 账号、IPA sidecar 库
│   └── ui/                 # App Store 风格页面与统一实验性安装入口
├── tests/
├── pack-box.sh
└── dist/JAsspp.box
```

## 导入 JSBox

`.box` 本质是一个 ZIP，根目录必须包含 `config.json`、`main.js`、`scripts/` 和 `assets/`。

```bash
cd jsbox-asspp
./pack-box.sh
```

脚本会先运行全部 Node 回归测试和 JavaScript 语法检查，再生成 `dist/JAsspp.box` 并验证 ZIP 完整性。可通过 AirDrop、文件 App、微信/QQ 的“用其他应用打开”等方式把 `.box` 交给 JSBox 导入。

不要只复制 `main.js`，否则多文件 `require("scripts/...")` 会失败。开发阶段也可使用 vscode-jsbox、jsbox-cli 或 jsbox-cli-plus 同步整个目录。

## 使用顺序

1. 打开“设置 → 账号与登录 → 添加 Apple ID”。
2. 输入账号和密码。Apple 要求时，应用再进入独立的六位验证码页面。
3. 在首页、搜索或设置中选择区域。下载时必须存在相同 storefront 的账号。
4. 在 App 详情页点下载按钮，或从“历史版本”选择 Apple 返回的版本 ID。账号已有许可时直接下载；免费 App 缺许可时自动尝试获取。
5. 下载完成后优先“分享 IPA”；如需尝试本机 OTA，先阅读应用弹出的限制说明。

## 已购 SAP 签名

在“设置 → 已购签名”同页填写服务地址与 API Token，保存后自动开启；点击“清空配置”关闭。
地址可用 `https://sap.example.com` 或 `http://<局域网 IP>:18080`，也接受完整的
`/sign` 地址和反向代理路径。手机上的 `127.0.0.1` 指向手机自身。
Token 保存在设备钥匙串。地址与 Token 一起保存，缺项时不会开启。

签名服务只接收设备 GUID 和 Base64 编码的待签名字节，不接收 Apple ID 密码、
Cookie 或登录令牌。已购 `/update` 表单与 `/items` DMAP 使用各自最终发送的字节签名，
客户端检查响应的 GUID、字节数和签名格式。首次签名可能需要数分钟。
服务部署见 [sap-signer](../sap-signer/README.md)。

## 本地验证

```bash
cd jsbox-asspp
node --test tests/*.test.js
find . -path './dist' -prune -o -name '*.js' -type f -print0 | xargs -0 -n1 node --check
./pack-box.sh
unzip -t dist/JAsspp.box
```

Node 测试覆盖 plist、Cookie、认证端点与重定向、Keychain 迁移／回滚、首次免费许可、原账号／历史版本重试、下载去重与确认取消、Range 完整性、版本验证状态、IPA sidecar 与下载账号、OTA、已购 SAP 请求字节一致性，以及已购缓存分页、历史版本渐进显示与取消、列表生命周期、归档分组、失败任务删除和对应版本“打开”入口。

Apple 私有接口、真实账号、超大 IPA、2FA 页面栈和 iOS OTA 仍必须在安装了 JSBox 的真机上验证。

## GitHub Actions 发布

仓库提供两个按标签触发的发布工作流：

- 推送 `jsbox-asspp-vX.Y.Z` 标签时，工作流会先将标签版本自动写入 `config.json` 的 `info.version` 和脚本内的 App 版本，再运行完整 Node 测试、JavaScript 语法检查和 ZIP 校验，生成 `dist/JAsspp.box` 并作为 GitHub Release 附件发布。
- 推送 `sap-signer-vX.Y.Z` 标签时，工作流会 checkout 已验证提交的 `majd/ipatool` 作为 Docker 构建依赖，构建 `linux/amd64` 和 `linux/arm64` 镜像，并发布到 `ghcr.io/dompling/ipatool-sap-signer`。版本标签会生成同名镜像标签，同时更新 `latest`。

例如：

```bash
git tag jsbox-asspp-v0.2.1
git push origin jsbox-asspp-v0.2.1

git tag sap-signer-v1.0.0
git push origin sap-signer-v1.0.0
```

GHCR 首次发布后，需要在 GitHub Package 设置中确认镜像可见性。部署时使用对应版本标签比 `latest` 更容易回滚。

## 已知限制与剩余风险

- **自动重定向底层行为**：JSBox `$http` 基于 NSURLSession。应用会检查最终 URL 并阻止后续处理/重放，但无法从 JavaScript 层证明 NSURLSession 在自动跟随前没有转发某些请求头；认证流程仍需真机与 Apple 当前端点回归。
- **IPA 校验**：下载会从磁盘解压并确认唯一的 `Payload/*.app/Info.plist`；可读 XML 提供实际 App 身份和版本。暂不解析 binary plist，因此结构通过不代表版本已验证。OTA 还要求实际元数据校验通过；旧记录仍可打开文件菜单和分享，不会因旧结构标志自动获得 OTA 资格。
- **下载内存与恢复**：支持 Range 的大包分段落盘，但每段的 JSBox `byteArray` 校验仍有内存开销。不支持 Range／merge 时仍需整包下载；解压和 SINF 重打包也可能产生较高峰值。目前任务为进程内状态，有去重与失败重试，没有暂停、断点续传或跨启动恢复。
- **取消下载**：JSBox 官方文档未保证 HTTP 返回取消句柄。代码只在运行时检测到可用句柄时尝试中止；其余情况显示“正在取消”，等当前请求回调收尾后丢弃数据，不继续重试或保存。
- **资源一致性**：每段都校验最终资源地址、范围和长度；没有强 ETag 的 CDN 无法独立证明各段属于同一个未变化的资源。若服务端忽略 Range 返回整包，JSBox 底层仍可能在客户端拒绝响应前先缓冲整包。
- **OTA HTTP 与 SINF**：现代 iOS 可能直接拒绝 localhost HTTP。下载会保留
  原始包并自动生成注入 SINF / iTunesMetadata 的副本（实验性，整体解压
  重打包，大包较慢且临时占用磁盘），注入失败保留原始包可重试，不应把
  OTA 当作可靠安装方式。
- **许可证**：支持新获取免费 App 和下载已有许可的 App；未购买的付费 App 需先在 App Store 购买。
- **已购记录的原始字节签名**：Apple 已购 `/update` 与 `/databases/{rev}/items`
  需要原始字节 ActionSignature；内置 WebView WASM 仅支持登录 XML plist。
  未配置时已购签名关闭，完整配置后自动开启。服务地址应直接响应 `/sign`，客户端拒收
  重定向响应；JSBox 底层自动重定向的请求头转发仍需真机验证。
- **历史版本标签**：请求 ID、响应 ID 和实际 IPA 版本分别处理。响应明确返回其他 ID 时停止；历史 IPA 的版本不可读时显示未知，不使用当前商店版本补齐。最新版可保留 API 显示版本，但不会标为实际元数据已验证。
- **私有 API 易变**：端点、UA、响应 plist 和风控策略均可能变化。
- **视觉与设备验证**：桌面 Node 测试不能验证 JSBox 的材质模糊、安全区、动态列表高度、键盘和连续导航动画。
- **文档时效**：本次实现以官方 `cyanzhong/jsbox-docs` 快照为依据，但该文档的部分页面较旧，真实最新版行为可能有差异。
