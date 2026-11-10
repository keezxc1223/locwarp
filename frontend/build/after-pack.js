// electron-builder afterPack hook: drop Electron files LocWarp never loads.
//
//   dxcompiler.dll (~25 MB): the DirectX shader compiler Chromium uses for
//     WebGPU only. The map renders through WebGL (ANGLE + d3dcompiler_47),
//     and nothing in the app calls navigator.gpu.
//
// Kept on purpose: vk_swiftshader.dll / vulkan-1.dll, which are what WebGL
// falls back to when the user turns hardware acceleration off in 設定.
const fs = require('node:fs');
const path = require('node:path');

const DROP = ['dxcompiler.dll'];

exports.default = async function afterPack(context) {
  for (const name of DROP) {
    const file = path.join(context.appOutDir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(`  • after-pack    removed ${name}`);
    }
  }
};
