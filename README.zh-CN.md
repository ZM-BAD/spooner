# Spooner

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/static/v1?label=agents&message=15%2B&color=8A2BE2&style=flat-square" alt="兼容 15+ coding agent"/>
  <img src="https://img.shields.io/static/v1?label=Agent%20Skills&message=%E2%9C%93&color=green&style=flat-square" alt="Agent Skills 标准"/>
  <a href="https://github.com/ZM-BAD/spooner/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ZM-BAD/spooner/ci.yml?style=flat-square&label=CI&cacheSeconds=300" alt="CI 状态"/></a>
  <a href="https://codecov.io/gh/ZM-BAD/spooner"><img src="https://img.shields.io/codecov/c/github/ZM-BAD/spooner?style=flat-square&label=coverage" alt="Codecov"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ZM-BAD/spooner?style=flat-square&label=License" alt="License"/></a>
</p>

> **让这个 git 仓库为 AI 做好准备**——AI coding agent 从第一次运行起就能顺畅工作。检测它的 AI 编码就绪度、打出 10 分制的分数，然后就地改造：CI 门禁、AGENTS.md、spec 驱动工作流。每步可验证，永不破坏已有构建。
>
> **audit → transform → check → sync**——一条流水线，零构建，零依赖。

<p align="center">
  <a href="assets/audit-report.md"><img src="assets/before-after.svg" alt="AI 就绪度：一次改造 4.3/10 AI-Aware → 9.2/10 AI-Native"/></a>
</p>

## Spooner 做什么

Spooner 是一个按 [Agent Skills](https://agentskills.io/specification)（SKILL.md）开放标准编写的、给 coding agent 用的 skill。它给你的仓库打出 **/10** 的 AI 就绪度分数，就地补齐缺失的门禁（永不破坏已有构建），并持续防止漂移。

一个 AI 原生仓库通常具备这些质量门禁与 AI 引导设施：**pre-commit 门禁**、真正会跑的 **lint / formatter 检查**、与本地门禁**一致的 CI**、告诉 agent 怎么干活的 **AGENTS.md**、**spec 驱动的契约**（SDD 模板）等等——未来涌现的同类设施，也会纳入 Spooner 的就绪度考核。

**名字的来历：Spooner 出自《我，机器人》（2004）里的 Del Spooner 警探——他的左臂是机械臂，并很好地为他服务。这个项目评估你的仓库缺了什么，并用同样的方式为它服务。**

"改造前"是这个仓库的一份零状态副本——同样的代码，减去 spooner 会安装的一切（没有 AGENTS.md、没有 pre-commit/commitlint 门禁、没有漂移 gate、没有 SDD 工作流）。跑一次管线，就从 **4.3/10（AI-Aware）提升到 9.2/10（AI-Native）**——每个得分点都有证据支撑，而不是观点（[完整报告](assets/audit-report.md)）。

分数采用 10 分制，划分为五档：

| 档位        | 分数  | 含义                                                             |
| ----------- | ----- | ---------------------------------------------------------------- |
| AI-Native   | 9–10  | 开箱即用——有 AGENTS.md、真门禁、与本地钩子一致的 CI、无漂移      |
| AI-Friendly | 7–8.9 | 设施基本齐了，还剩一两个缺口（假 hook、CI 不一致、缺 AGENTS.md） |
| AI-Curious  | 5–6.9 | 有部分面向 AI 的配置，但不完整                                   |
| AI-Aware    | 3–4.9 | AI 能读懂，但没有为它做任何准备                                  |
| AI-Absent   | 0–2.9 | AI 连看懂都费劲——没有 README、没有结构、没有可追溯命令           |

## 快速上手

前置要求：Node.js >= 22.18 与 git。**audit 本身完全离线可用。**

**安装**——一条命令，覆盖所有主流 coding agent（Claude Code、Codex、Cursor、Copilot、OpenCode、Kilo Code、Goose、Qwen Code、Kimi Code、Antigravity、TRAE、Qoder、ZCode、CodeBuddy 等）：

```sh
npx skills add ZM-BAD/spooner
```

常用参数：`-g` / `--global`（所有项目）、`-a` / `--agent <agent>`（指定目标 agent）、`-s` / `--skill <name>`（只装 spooner）。[skills CLI](https://github.com/vercel-labs/skills) 会从环境自动识别你的 agent，把 `skills/spooner/` 复制进它的 skills 目录。装完在 agent 会话里用 `/skills` 确认。

**跑审计**——对任意仓库（确定性体检——分数可复现、有证据、绝不是一句观点）：

```text
$ node skills/spooner/scripts/audit.ts --root /path/to/repo --format markdown

# AI-Readiness Report
- Stack: node · Maturity: stable · Score: **9.2/10**

## Score by category
| Category      | Score | Max |
| ------------- | ----- | --- |
| Agent Setup   | 4.5   | 4.5 |
| Configuration | 1.9   | 2   |
| Integrity     | 1.5   | 1.5 |
| Freshness     | 0.5   | 0.5 |
| Structure     | 0.8   | 1.5 |
```

报告里每个缺口都指向工具集真正能交付的动作——没有虚构建议。照着报告改、重跑、看分数动。

## transform 之后你会得到什么

跑 `transform --stage all` 会就地安装（每次前后都做构建验证）：

- **Git 门禁**——`.commitlintrc.json`（Conventional Commits）、栈感知的 `.pre-commit-config.yaml`（按你的栈生成 lint/format/typecheck/test 钩子，只检查不改写）、`.markdownlint-cli2.yaml`
- **CI**——按栈生成的 `.github/workflows/ai-native.yml`：质量任务（默认 warn-only，`--gates hard` 可转硬门禁）、声明命令硬门禁、commit-msg commitlint 检查、模板漂移硬门禁（漂移即 CI 红）
- **Agent 文件**——从你的真实命令（package.json 脚本 / Makefile / CI）生成的 `AGENTS.md` + `CLAUDE.md` 软链
- **SDD 工作流**（可选）——`docs/sdd/` 的 spec/plan/tasks 模板 + spec 存在性 CI 门禁
- **台账**——`.ai-native.yml` 精确记录装了哪些文件；`check` 检测漂移，`sync` 在工具升级后重同步

每一步都可验证、可回滚（`git restore` 列出的文件）；已存在的坏构建会被如实报告原因，不会阻塞安装。

## 工作流

| 命令        | 做什么                                                                                | 何时                 |
| ----------- | ------------------------------------------------------------------------------------- | -------------------- |
| `audit`     | 检测就绪度并评分（可重复，体检）                                                      | 任意仓库、任意时刻   |
| `transform` | 渐进化、可验证、可回滚的改造（按栈的 CI 门禁含 manifest 漂移 gate / AGENTS.md / SDD） | 每个仓库一次         |
| `check`     | 持续检测漂移（可重复，有记录）                                                        | 每次 CI 运行         |
| `sync`      | 已装模板随工具版本重同步（版本感知、一键应用）                                        | 工具升级后           |
| `badge`     | 渲染就绪度徽章，匹配 README 现有徽章风格（5 种 shields 风格，链接审计报告）           | 改造之后、分数变动时 |

## 栈支持

| 栈                                             | detect + audit                                                                     | transform（门禁 + CI + AGENTS.md）       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| node（含 React/Vue/Next）                      | ✅                                                                                 | ✅ `npm` 生命周期                        |
| python                                         | ✅                                                                                 | ✅ `python3 -m unittest discover`        |
| go                                             | ✅                                                                                 | ✅ `go build/test ./...`                 |
| java（Maven + Gradle）                         | ✅                                                                                 | ✅ `mvn -q -B test` / `gradle build`     |
| rust                                           | ✅                                                                                 | ✅ `cargo build/test`（fmt/clippy 门禁） |
| ruby / php / swift / dotnet / harmonyos        | ✅（audit 只低估不虚高）                                                           | ⚠️ 跨栈门禁 + 明确暂不支持提示           |
| apple / c-cpp / dart-flutter / unity（Tier 1） | ✅（canonical 生命周期信用：xcodebuild / cmake+ctest / flutter test+dart analyze） | ⚠️ 跨栈门禁 + 明确暂不支持提示           |
| zig                                            | ✅（zig build/test 生命周期信用）                                                  | ⚠️ 跨栈门禁 + 明确暂不支持提示           |

## FAQ

- **我的环境访问不了 GitHub，会被卡住吗？** 生成的 pre-commit 配置在运行时从 GitHub 拉取 hook 仓库；GitHub 不可达时 pre-commit 无法准备钩子环境、commit 会被阻塞——生成配置的头部说明了这一点并给出镜像方案。CI（GitHub Actions）不受影响。面向内网/离线环境的离线模式正在规划中。

## 开发

**SDD（Spec-Driven Development）：** 每个功能先写成 spec（`specs/<nnn>-<name>.md`，状态 `proposed → approved → in-progress → shipped`），按可独立验证的切片实现。模板：`specs/spec-template.md`。

```sh
npm run typecheck   # tsc --noEmit (TypeScript 6, 零构建)
npm run lint:md     # markdownlint-cli2
npm run check       # typecheck + lint:md + 测试
pre-commit install --hook-type commit-msg   # 每次提交强制 Conventional Commits
pre-commit run --all-files
node skills/spooner/scripts/detect.ts   # slice 1: 栈检测
```

**约束：** 只用 TypeScript 6（锁大版本——TS 7.1 前工具链仍需 6.0 API）、只用 erasable syntax（禁 `enum`/`namespace`）、脚本零依赖、Conventional Commits（commitlint 强制）。

**文档：** `AGENTS.md`（agent 契约）· `specs/README.md`（SDD 工作流）· `specs/ROADMAP.md`（规划索引）· `skills/spooner/SKILL.md`（可分发 skill 入口）。代码在 `skills/spooner/scripts/` 下——直接读目录，它就是事实源。

## 贡献者

感谢用试用反馈塑造了这个项目的用户——每个 release 都会列出被修复问题的人：

<a href="https://github.com/shellRaining"><img src="https://avatars.githubusercontent.com/shellRaining?v=4" title="shellRaining" width="50" height="50" alt="shellRaining"></a>

觉得有用？[给仓库点个星](https://github.com/ZM-BAD/spooner)，把它推荐给需要它的仓库。

## 许可证

[MIT](LICENSE)
