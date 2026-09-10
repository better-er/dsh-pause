# dsh·暂停插件

## 引言

DeepSeek Harness 会自动调用工具并连续作答，虽然可以使用插话发送在中途提示，但是 DeepSeek 输出太快了，拼尽全力也没有其百分之一的 tok/s，根本无法成功插话。而直接打断 DeepSeek 的输出会导致其变成胆小菇，甚至不愿继续执行命令，工作积极性大幅下降。

为了能够成功在 DeepSeek 下一轮调用前插话并保护其弱小的心灵，此插件使用了拔网线的力量，假装卡了阻止 DeepSeek 发出下一次请求，直到你按下 Enter 或点按钮放行。暂停期间输入框照常可打字并插话发送后自动继续，或者直接回车让模型继续，这样在模型侧不会察觉到暂停的存在。

恰巧做完这个插件后，`deepseek-v4.1-flash-expires-on-0910` 速度已经到 300~400 tok/s，这下拼尽全力也追不上其百分之一的 tok/s，只能使用盘外招了。

注：现 deepseek-v4-flash 的速度约为 100 tok/s，而其一个中文字符约为 0.6 token，其百分之一的速度为 100 字/分钟，你的打字速度如何？

## 关键词

暂停 · 插话 · 无感

## 功能

- **可开关**：默认关闭，每个会话可独立开启。
- **暂停在请求前**：模型完成一轮工具交互、正要发出下一次请求之前停下，不打断任何在途 API 调用。
- **保持 composer 可用**：暂停期间输入框照常可打字，不遮挡、不切换。
- **回车即放行**：在主输入框按裸 Enter 继续。草稿为空为无感放行，草稿有字则把文字作为插话随本次请求一并发出，随后清空草稿。
- **按钮同样放行**：也可直接点「已暂停·回车或点此继续」按钮，行为同上并读取当前草稿。
- **模型无感知**：上下文完整、不插入多余消息，模型察觉不到暂停存在。

## 它长什么样

开关打开、暂停被触发时，composer 工具行右侧出现一个暂停控件：

![暂停控件](docs/暂停.webp)

暂停时在主输入框按 Enter 即继续。未开启开关时不拦截任何按键，一切照常。

## 安装

**从 GitHub 安装**：源码在 `src/`，`lib/` 不入仓库，安装时 npm 会触发 `prepare` 脚本现场构建。

```powershell
dsh plugin --profile web add github:better-er/dsh-pause
```

**从 npm 安装**：包内已含构建产物 `lib/index.js` 与 `lib/client.js`，安装时不再构建。

```powershell
dsh plugin --profile web add dsh-pause
```

两种方式装完都会自动挂载，重启 DSH web 后启用，无需手工编辑任何文件。

## 卸载

```powershell
dsh plugin --profile web remove dsh-pause
```

彻底移除，重启 DSH web 后不再加载。

## 使用

1. 点 composer 工具行右侧的「暂停」按钮，变「暂停开」即该会话已开启。
2. 之后该会话的工具续跑请求会在发出前停下等你。
3. 需要放行时在主输入框按裸 Enter，空为无感继续，有字为插话。也可点「已暂停·回车或点此继续」。
4. 用完再点「暂停开」关掉。暂停中关掉会放行正挂着的门。

## 配置

cordis 配置项 `defaultEnabled`，默认 false：

```yaml
plugins:
  dsh-pause:
    defaultEnabled: false
```

运行期可用 composer 里的开关逐会话切换，并覆盖 defaultEnabled。

## 工作原理

dsh 把一次模型请求当作一个 step，agent 连续调用工具时会经历 step、工具执行、下一次 step 的循环。
本插件挂在 `agent/pre-step`，在「带工具结果的下一请求」正要进入前决定是否拉门。

- 暂停点设在请求真正发出之前，故无在途调用可打断。
- 续跑判定用同一 turn 内 step 大于 1 近似，首条纯文字请求永不暂停。
- 浏览器端经 `conversation.input.right` 槽位在 composer 工具行渲染控件。
- 因 dsh 的 composer Enter 由 InputBar 私有 keymap 处理、第三方无 hook 点，暂停态用 DOM capture 拦截裸 Enter 改走放行，不改 DSH 源码。
- 主机侧不经 `ctx.connection.rpc.handle`：该 API 自 0.1.2 起即不可用，改为向 webServer 自注册 `/dsh-pause` 前缀路由，复用 connection 的信任判定与浏览器鉴权，信封格式与官方一致。

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

[MIT](./LICENSE)

