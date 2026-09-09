# SAP 签名服务

> **AI 构建声明**：本项目由 AI 全程构建，包括代码、测试、文档和发布流程。使用前请自行审查代码并在目标环境中验证。

将父级目录 `ipatool/internal/sap` 的跨平台签名器包装成 HTTP 服务，在 Linux
Docker 中运行。支持已购接口 `/update` 的表单、`/databases/{revision}/items`
的 DMAP、XML plist 和其他原始字节，返回可直接用于 `X-Apple-ActionSignature`
的 Base64 签名。

构建复用相邻的 `../../ipatool` 源码；不需要在 Mac 上启动签名进程或挂载系统
Framework。初始实现参考的上游提交为 `a9bd16c9a211c556650e206245ff34115c725e12`。

## 启动

需要 Docker Compose 2.17+（支持 additional contexts）和 Python 3。

```sh
cd ./sap-signer
./setup.sh
python3 smoke_test.py
```

`setup.sh` 首次运行生成权限为 `0600` 的 `.env`，其中保存随机 API Token，
随后构建并启动服务；再次运行会保留 Token。`.env` 不纳入 Git 或镜像。
默认只映射本机 `127.0.0.1:18080`，容器会随 Docker 自动重启。

首次签名会下载并校验 Apple SAP 运行资源及 Unicorn 动态库，可能需要数分钟。
资源持久化在 Compose 的 `sap-cache` 卷中，容器更新后可继续使用。
后续同 GUID 请求复用一个签名会话；切换 GUID 或会话空闲超过 10 分钟时重建。
该时间是本服务的资源管理设置，不代表 Apple 保证的会话有效期。

## HTTP 接口

`GET /healthz` 检查 HTTP 进程是否存活。验证实际签名能力请运行 `smoke_test.py`；
健康状态不代表已完成资源下载、SAP 握手或 Apple 已购接口验证。

`POST /sign` 需要 `Authorization: Bearer <SAP_API_TOKEN>` 和
`Content-Type: application/json`：

```json
{
  "guid": "020000000001",
  "bodyBase64": "aGVsbG8="
}
```

返回：

```json
{
  "signature": "<SAP 签名的标准 Base64>",
  "bytesSigned": 5,
  "guid": "020000000001"
}
```

`guid` 必须是请求 Apple 时使用的设备 GUID，服务会将十六进制解码成硬件字节。
例如 `020000000001` 对应 6 个字节；请勿传 Apple ID、设备 UUID 或 ASCII
十六进制字符串的二次编码。允许 1–20 字节的硬件标识。

`bodyBase64` 必须来自实际发送给 Apple 的请求体。表单以原始 UTF-8 字节编码，
DMAP 直接编码二进制。获得签名后不能再改参数顺序、空格、换行或重新序列化。
请求体解码后上限为 1 MiB。服务不需要 Apple ID、密码、Cookie 或登录令牌作为
单独的配置，也不会记录待签名内容。

可以在当前终端加载本地生成的 Token 后调用：

```sh
set -a
. ./.env
set +a
curl --fail-with-body http://127.0.0.1:18080/sign \
  -H "Authorization: Bearer $SAP_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"guid":"020000000001","bodyBase64":"aGVsbG8="}'
```

签名引擎固定使用 SAP version 200。默认端点为
`https://s.mzstatic.com/sap/setupCert.plist` 与
`https://fpinit.itunes.apple.com/v1/signSapSetup/legacy`。
必要时可在 Compose 的 `environment` 中配置 `SAP_CERTIFICATE_URL` 和
`SAP_SETUP_URL`；客户端请求不能指定任意代理地址。

## JSBox 与服务器部署

在 JAsspp“设置 → 已购签名”填写服务地址和 `.env` 中的 `SAP_API_TOKEN`，
保存完整配置后自动开启，“清空配置”后关闭。地址接受基础路径或完整 `/sign` 路径；Token 保存在设备钥匙串。
配置仅用于已购记录，Apple ID 登录继续使用 JSBox 内置 XML 签名。

- 局域网：将 `.env` 的 `SAP_BIND_ADDRESS` 改为宿主机局域网 IP，执行
  `docker compose up -d`，JSBox 填 `http://<宿主机局域网IP>:18080`。
- 远程服务器：服务器上按相同目录结构准备本项目与相邻 `ipatool` 源码，运行
  `./setup.sh`，再用 HTTPS 反向代理转发到 `127.0.0.1:18080`。
  JSBox 填 `https://sap.example.com`；有路径前缀时，代理需将其正确映射到服务的 `/sign`。

手机的 `127.0.0.1` 指向手机自身。服务地址应直接响应，不能将签名请求重定向到其他地址。
代理应保留 Authorization 和原始请求体，并给首次签名预留至少 8 分钟响应超时。

其他 Docker Compose 项目可加入 `ipatool-sap_default` 网络，通过
`http://signer:8080/sign` 调用。

## 维护与验证

```sh
docker compose ps
docker compose logs --tail=50 signer
docker compose restart signer
docker compose down
```

`down` 保留资源缓存；只有显式附加 `--volumes` 才会删除缓存。
构建过程执行服务的 Go 单元测试、`go vet` 和编译。开发时也可直接运行
`go test -race ./...`、`go vet ./...`。

## GitHub Container Registry

推送 `sap-signer-vX.Y.Z` 标签会触发仓库工作流，使用 `majd/ipatool` 作为构建依赖，构建 `linux/amd64` 和 `linux/arm64` 镜像，并发布到：

```text
ghcr.io/dompling/ipatool-sap-signer:X.Y.Z
ghcr.io/dompling/ipatool-sap-signer:latest
```

发布标签必须使用 `sap-signer-v` 前缀。生产部署建议固定具体版本，例如：

```sh
docker pull ghcr.io/dompling/ipatool-sap-signer:1.0.0
```

GitHub Actions 使用仓库内置的 `GITHUB_TOKEN` 推送 GHCR，不需要额外配置 Token；仓库或组织的 Actions 设置必须允许该 Token 写入 Packages。

`smoke_test.py` 使用合成表单、DMAP、含零字节及非 UTF-8 字节的二进制、XML，
实际完成 Apple SAP 握手与签名，并验证未鉴权请求被拒绝。它不发送已购查询，
也不能代替使用真实 Apple 登录会话验证已购列表。Apple 私有协议或资源下载
端点变化仍可能影响服务。

## 本机验证记录（2026-09-07）

在 Docker Desktop 的 Linux ARM64 容器中完成实测：

- Go 单元测试、race 检查、`go vet`、编译与格式检查通过。
- 表单（91 字节）、DMAP（130 字节）、任意二进制（19 字节）、XML
  （108 字节）均返回 501 字节签名；不同请求体的签名不同。
- 空缓存首次签名约 31.42 秒，同会话后续签名约 0.02 秒。
- 重启容器后首次签名约 0.74 秒，四种输入再次通过，持久化缓存正常复用。
- 未携带 Token 的请求返回 HTTP 401；容器健康检查通过。
- Unicorn 的 `ldd` 检查没有缺失项，仅依赖容器中的 glibc、libm、libpthread
  和 ARM64 动态加载器。
- JSBox 客户端适配器连接本机容器通过：91 字节 `/update` 表单、130 字节
  `/items` DMAP 和 7 字节非 UTF-8 数据均完成真实签名；两次已购请求的发送字节
  与签名字节完全一致。此项测试的 Apple 已购响应使用合成数据。

以上耗时是这台机器和当时网络的测量值。未发送真实账号的已购查询。
