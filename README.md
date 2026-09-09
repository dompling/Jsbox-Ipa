# Jsbox-Ipa

> **AI 构建声明**：本项目由 AI 全程构建，包括代码、测试、文档和 GitHub Actions 发布流程。使用前请自行审查代码，并在目标设备或服务器上完成验证。

本仓库包含两个相互配合但可独立发布的项目：

- [`jsbox-asspp/`](jsbox-asspp/)：运行在 JSBox 中的 JAsspp App Store 客户端，发布产物为 `.box`。
- [`sap-signer/`](sap-signer/)：为 JAsspp 已购记录提供 SAP ActionSignature 的 Go HTTP 服务，发布产物为 Docker 镜像。

详细功能和限制请分别阅读 [`jsbox-asspp/README.md`](jsbox-asspp/README.md) 与 [`sap-signer/README.md`](sap-signer/README.md)。项目调用 Apple 非公开接口，可能随时失效，也存在账号风控风险；不要使用主 Apple ID 或提交 Cookie、Token、设备 GUID 等敏感信息。

## GitHub Actions 发布

发布通过标签触发：

| 标签 | 工作流 | 产物 |
| --- | --- | --- |
| `jsbox-asspp-vX.Y.Z` | `Release JAsspp` | GitHub Release 附件 `JAsspp.box` |
| `sap-signer-vX.Y.Z` | `Publish SAP signer package` | `ghcr.io/dompling/ipatool-sap-signer:X.Y.Z` 和 `latest` |

JAsspp 工作流会在打包前根据标签自动更新 `jsbox-asspp/config.json` 的 `info.version` 和脚本内的 App 版本。SAP signer 工作流会固定 checkout 已验证的 `majd/ipatool` 提交，并构建 `linux/amd64` 与 `linux/arm64`。

```bash
git tag jsbox-asspp-v0.2.1
git push origin jsbox-asspp-v0.2.1

git tag sap-signer-v1.0.0
git push origin sap-signer-v1.0.0
```

GHCR 首次发布后，在 GitHub Package 设置中确认镜像可见性。生产环境建议固定版本标签，便于回滚。

## 本地验证

JAsspp：

```bash
cd jsbox-asspp
./pack-box.sh
```

SAP signer 的 Dockerfile 需要相邻的 `ipatool` checkout：

```bash
git clone https://github.com/majd/ipatool.git ../ipatool
cd sap-signer
./setup.sh
```

只构建镜像时：

```bash
docker buildx build \
  --build-context ipatool=../ipatool \
  -f sap-signer/Dockerfile \
  -t ipatool-sap-signer:local \
  sap-signer
```

不要把 `sap-signer/.env` 提交到 Git；它包含服务 API Token，文件默认权限应为 `0600`。

## 特别感谢与参考

特别感谢以下贡献者和项目：

- **小白脸**：在项目构思、实现方向和问题讨论中的帮助。
- **[Lakr233](https://github.com/Lakr233)**：Asspp 项目及 ApplePackage 相关实现，为 JAsspp 的界面和 App Store 功能提供重要参考。
- **[majd/ipatool](https://github.com/majd/ipatool)**：Apple Store 协议、认证、购买、下载和 SAP 签名相关实现，是本项目协议层与签名服务的重要参考来源。

相关参考资料：

- [Lakr233/Asspp](https://github.com/Lakr233/Asspp)
- [majd/ipatool](https://github.com/majd/ipatool)
- [JSBox 官方文档](https://docs.xteko.com)
- [Apple App Store 重新下载说明](https://support.apple.com/en-us/102417)
- [Apple App Store 下载说明](https://support.apple.com/en-us/102590)

本项目仅用于协议研究和个人学习。上游项目、Apple 私有接口及相关服务的行为可能变化，实际使用请遵守对应项目许可证和 Apple 服务条款。
