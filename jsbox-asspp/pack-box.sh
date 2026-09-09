#!/bin/bash
# 把 jsbox-asspp/ 打成 JSBox 可导入的 .box（本质是 zip，根目录含 config.json / main.js）。
# 产物：jsbox-asspp/dist/JAsspp.box，可用 AirDrop / 文件 App / 微信 分享到手机，
# 然后选择“用 JSBox 打开”即可导入。

set -euo pipefail
cd "$(dirname "$0")"

echo "运行 Node 回归测试…"
node --test tests/*.test.js

echo "检查 JavaScript 语法…"
while IFS= read -r -d '' source; do
  node --check "$source"
done < <(find . -path './dist' -prune -o -name '*.js' -type f -print0)

mkdir -p dist
rm -f dist/JAsspp.box

zip -r -q dist/JAsspp.box \
  main.js config.json scripts assets README.md \
  -x '*.DS_Store' -x '*__MACOSX*' -x 'tests/*' -x 'dist/*'

echo "已生成: $(pwd)/dist/JAsspp.box"
unzip -tq dist/JAsspp.box
unzip -l dist/JAsspp.box | tail -3
