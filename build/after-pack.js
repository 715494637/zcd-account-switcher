"use strict";
/**
 * electron-builder afterPack hook
 * 删除打包后不需要的文件，减小安装包体积：
 *   - LICENSES.chromium.html (~8.7MB)
 */
const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const toDelete = ["LICENSES.chromium.html"];
  for (const name of toDelete) {
    const p = path.join(context.appOutDir, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`  ✓ afterPack: 已删除 ${name}`);
    }
  }
};
