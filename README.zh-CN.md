# Spooner

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

> 对仓库的 **AI 编程就绪度** 进行检测评分，并就地执行渐进化改造——装好工程门禁、生成 Agent 指令文件、落地 SDD 工作流。每步可验证、不破坏现有构建。

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-6.0-3178C6.svg?style=flat-square" alt="TypeScript 6.0"/>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.18-339933.svg?style=flat-square" alt="Node.js >= 22.18"/>
  <img src="https://img.shields.io/badge/build-zero%20build-brightgreen.svg?style=flat-square" alt="Zero build"/>
  <img src="https://img.shields.io/badge/agents-10%2B-8A2BE2.svg?style=flat-square" alt="Compatible with 10+ coding agents"/>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/workflow-Spec--Driven-blue.svg?style=flat-square" alt="Spec-driven workflow"/>
  <img src="https://img.shields.io/badge/Agent%20Skills-%E2%9C%93-green.svg?style=flat-square" alt="Agent Skills standard"/>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/CI-passing-brightgreen.svg?style=flat-square" alt="CI passing"/>
</p>

Spooner 是一个按 [Agent Skills](https://agentskills.io/specification) 开放标准（SKILL.md）编写的、给 coding agent 用的 skill。名字来自《我，机器人》（2004）里给机器人立规矩的警探——Spooner 是给 AI 编码立规矩的。

**当前状态（2026-08-04）：** 产品设计已冻结；工程脚手架已就绪（TypeScript 6、零构建、SDD 工作流、全套 lint + CI）；**M1-M6 已交付** —— audit → transform → check → sync 闭环完成，manifest 漂移在 CI 中被硬门禁拦截，transform 支持 **node / python / go / java**，安装的 commitlint 门禁真正生效（钩子安装步骤 + CI commit-msg 检查 + gate-active 审计），transform 情境感知（CI 平台分流：非 GitHub 仓库只装跨栈门禁 + 明确跳过说明）；下一步：发布准备。

## 工作流

| 命令 | 做什么 | 何时 |
|---|---|---|
| `audit` | 检测就绪度并评分（可重复，体检） | 任意仓库、任意时刻 |
| `transform` | 渐进化、可验证、可回滚的改造（按栈的 CI 门禁含 manifest 漂移 gate / AGENTS.md / SDD） | 一次性，手术 |
| `check` | 持续检测漂移（可重复，有记录） | 每次 CI 运行 |
| `sync` | 已装模板随工具版本重同步（版本感知、一键应用） | 工具升级后 |

## 栈支持

| 栈 | detect + audit | transform（门禁 + CI + AGENTS.md） |
|---|---|---|
| node（含 React/Vue/Next） | ✅ | ✅ `npm` 生命周期 |
| python | ✅ | ✅ `python3 -m unittest discover` |
| go | ✅ | ✅ `go build/test ./...` |
| java（Maven + Gradle） | ✅ | ✅ `mvn test` / `gradle build` |
| rust / ruby / php / swift / dotnet | ✅（audit 只低估不虚高） | ⚠️ 跨栈门禁 + 明确暂不支持提示 |

## 兼容性

10+ 主流 coding agent 全部原生支持 SKILL.md 标准，AGENTS.md 近乎全支持：

| Agent | AGENTS.md | Skills 目录 |
|---|---|---|
| Claude Code | 经 CLAUDE.md（软链） | `.claude/skills/` |
| OpenAI Codex | 原生 | `.agents/skills/` |
| OpenCode | 原生 | `.opencode/skills/` |
| Qwen Code | 配置开启 | `.qwen/skills/` |
| Kimi Code | 原生 | `.kimi-code/skills/` |
| CodeBuddy | 兜底（主文件 CODEBUDDY.md） | `.codebuddy/skills/` |
| Trae | 需开关 | `.trae/skills/` |
| Qoder | 原生 | SKILL.md 原生 |
| Cursor | 原生 | `.cursor/skills/` |
| VS Code | 原生 | `.github/skills/` |

通用策略：**AGENTS.md** 管常驻事实（根目录，≤200 行）+ **SKILL.md** 管按需流程（标准格式）+ 每 agent 规则文件做单工具适配。

## 安装

把 `skills/spooner/` 整个目录复制到你的 agent 的 skills 目录（见上表），或用 skills CLI：

```sh
npx skills add <owner>/spooner
```

需要 Node.js >= 22.18：脚本是 TypeScript，由 Node 原生 type-stripping 直接运行——**无构建步骤**。

## 项目结构

```text
spooner/
├── AGENTS.md / CLAUDE.md   # Agent 契约（单一事实来源；CLAUDE.md 是软链）
├── README.md / zh-CN.md    # 中英双语文档
├── docs/                   # 本地内部设计档案（不入库，不公开）
├── specs/                  # SDD 工作契约（活文档：README + templates/ + <nnn>-<name>/）
├── skills/spooner/         # 可分发单元：SKILL.md + scripts/ + templates/
│   ├── SKILL.md            # Agent Skills 标准入口（name 与目录名一致）
│   ├── scripts/            # 零依赖脚本（TS 由 Node 原生运行）
│   └── templates/          # 产物模板（AGENTS.md 等）
└── .github/workflows/      # CI：pre-commit、typecheck、commitlint、SKILL.md 校验
```

## 开发

**SDD（Spec-Driven Development）：** 每个功能先写成 spec（`specs/<nnn>-<name>/spec.md`，状态 `proposed → approved → in-progress → shipped`），按可独立验证的切片实现。模板：`specs/templates/spec.md`。

```sh
npm run typecheck   # tsc --noEmit（TypeScript 6，零构建）
npm run lint:md     # markdownlint-cli2
npm run check       # typecheck + lint:md
pre-commit install --hook-type commit-msg   # 每次 commit 强制 Conventional Commits
pre-commit run --all-files
node skills/spooner/scripts/detect.ts   # 切片 1：栈识别
```

**约束：** 只用 TypeScript 6（锁大版本——TS 7.1 前工具链仍需 6.0 API）、只用 erasable syntax（禁 `enum`/`namespace`）、脚本零依赖、Conventional Commits（commitlint 强制）。

## 分发（计划中）

计划：GitHub 分发为默认渠道（git tag + skills CLI），发布里程碑再上 Claude Code 插件市场与社区注册表。打包调研保留在本地内部档案（不入库）。

## 文档导航

| 文档 | 内容 |
|---|---|
| `AGENTS.md` | Agent 契约（单一事实来源；CLAUDE.md 是软链） |
| `specs/README.md` | SDD 工作流：状态、约定、两层结构 |
| `specs/ROADMAP.md` | 规划索引：当前 / 下一阶段 / 远景 / 想法 |
| `specs/0001-m1-audit-core/spec.md` | M1 audit 契约：评分矩阵、报告 schema、验收标准 |
| `skills/spooner/SKILL.md` | 可分发 skill 入口 |

## 许可证

[MIT](LICENSE)
