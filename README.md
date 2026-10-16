# Roadster Flight Lab — v0.0.3

一个 3D 喷气平衡小游戏：驾驶银色楔形跑车爬上弧形轨道，离轨后用九个独立喷口侧滚翻正、调整姿态并安全着陆。车辆载入后即可驾驶，底部车模周围显示当前可用按键。

0.0.3 为开源发布版本，玩法与模型沿用 0.0.2。适合使用键盘、支持 WebGL 2 的现代桌面浏览器。

## 本地运行

需要 Node.js 22+ 和 npm。

```sh
git clone https://github.com/wwtlitee/roadster-flight-lab.git
cd roadster-flight-lab
npm ci
npm run dev
```

打开终端显示的本地地址。构建并运行生产版本：

```sh
npm run build
npm start
```

生产服务默认地址为 `http://127.0.0.1:5189/`，只监听本机；关闭终端会停止服务。

Windows 也可以在安装 Node.js 后双击 `启动游戏.bat`，首次运行会自动安装依赖并构建。

## 操作

| 场景 | 按键 | 作用 |
| --- | --- | --- |
| 地面与弧轨 | W / S | 加速 / 制动，停下后可倒车 |
| 地面与弧轨 | A / D | 左右转向，自己对准轨道 |
| 空中前排 | Q W E | 左前 / 正前 / 右前喷口 |
| 空中中排 | A S D | 左侧 / 中央主升力 / 右侧喷口 |
| 空中后排 | Z X C | 左后 / 正后 / 右后喷口 |
| 通用 | R / Esc / F | 重来 / 暂停 / 全屏 |

轨道只提供吸附，油门和转向由你控制。离轨后先松开驾驶键，再按下才会启动喷口。先用 A 或 D 侧滚翻正，接近正立时点喷另一侧止转，再用 W/X 微调俯仰、S 缓降。喷力沿车身方向作用，倒挂时按 S 会加速下坠；气量有限，适合短促点喷。

落地后车辆会继续弹跳、落稳并滑行。正常落轮按首次接触的姿态、速度和落点计分，翻车为 0 分。Esc 菜单可切换标准或练习难度；失焦时自动暂停。

## 开发

技术栈：JavaScript ES Modules、Vite、Three.js、cannon-es。空中姿态采用四元数和车辆局部喷力，地面碰撞由刚体引擎处理。车辆 GLB 约 **1.66 MB**，使用 Meshopt 和 WebP，解码器随本地依赖打包。

| 入口 | 内容 |
| --- | --- |
| `src/main.js` | 输入、游戏流程、界面与固定时间步长 |
| `src/physics.js` | 驾驶、轨道吸附、喷气飞行与评分 |
| `src/ground-contact.js` | 车体与四轮接地、碰撞和滑行 |
| `src/scene.js` | Three.js 场景、车辆、镜头与效果 |
| `src/car-materials.js` / `src/control-car.js` | 车辆配色与底部俯视车模 |
| `src/style.css` / `index.html` | 页面样式与界面结构 |
| `scripts/serve.mjs` | 本地生产服务 |
| `tests/physics.test.js` / `tests/browser.mjs` | 物理测试与浏览器流程回归 |

```sh
npm run check
npm test
```

运行 `npm run package` 会检查源码、运行物理测试并重新构建，在 `output/` 生成带版本号的本地试玩目录。目录包含 `dist/`、启动器和文件哈希清单；可复制给朋友，安装 Node.js 22+ 后直接启动，无需再次安装 npm 依赖。该目录不含开发源码，开发请使用上面的仓库克隆方式。

浏览器回归位于 `tests/browser.mjs`，使用隔离的无头 Playwright。运行前需安装 Chromium，并通过 `ROADSTER_TEST_URL` 环境变量指定已启动的服务地址；脚本默认使用端口 5188。

飞行和碰撞参数用于游戏手感，不是实车工程仿真；离轨后仅模拟地面接触，不包含与轨道或舞台的再次碰撞。

## 许可与素材

源码采用 [MIT 许可证](LICENSE)。第三方依赖许可见 [署名说明](THIRD_PARTY_NOTICES.md)。

车辆模型由用户提供的参考图经 **造点啥 / TRELLIS.2** 生成，再进行方向、配色和压缩处理；单图不可见部位由模型推断。模型与参考素材独立于源码许可，来源和处理记录见 [模型来源](public/assets/roadster.source.json) 与 [模型说明](public/assets/roadster.LICENSE.txt)。源码的 MIT 许可不代表对参考图及其他第三方权利作出授权承诺。

Tesla / Roadster 等商标归各自权利人所有。本项目是非官方小游戏，与 Tesla 或 SpaceX 无关联，也不是官方车辆模型。

维护者：Unclecow。
