// JAsspp 入口：Asspp 风格的多区域 App Store 客户端（JSBox）。
// 参考：ipatool-sapfix（协议）、Lakr233/Asspp（功能与 ApplePackage 认证实现）。
// 主界面为底部 Tab 导航：首页（榜单预览）/ 已购 / 下载 / 搜索 / 设置。

if ($app.env !== $env.app) {
  $app.openURL(
    "jsbox://run?name=" + encodeURIComponent($addin.current.name)
  );
} else {
  const ota = require("scripts/services/ota");
  // 不能在 pause 时停止：唤起 itms-services 本身就会让 JSBox 暂停。
  $app.listen({ exit: ota.stopActive });
  require("scripts/ui/shell").launch();
}
