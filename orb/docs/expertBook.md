# 专家契约（自动生成，勿手改）

> 由 `orb/expertContract.mjs` 生成。要改契约请改 `orb/expertContract.mjs` 的 `DEFAULT_BOOK`
> 或在 `expertBook.json` 里覆盖（运行目录下），然后跑 `node orb/tools/gen-expertbook-doc.mjs`。

| 专家 | 动作范围 | 嵌套上限 | 检查点 |
|---|---|---:|---|
| `arch` | read-only | 0 | freeze / check |
| `sec` | read-only | 0 | freeze / check |
| `ux` | read-only | 0 | freeze / check |
| `perf` | read-only | 0 | freeze / check |
| `correct` | read-only | 0 | freeze / check |
| `core-team` | read-only | 1 | freeze / check |

## 三档动作范围的含义

- `read-only`：只许观察与提发现。任何写操作在派发口就被拒（`scope-read-only`）。
- `propose`：可以提方案与候选动作，但不能自己执行。
- `execute`：可以执行，但**必须先 freeze**（钉住现状），否则拒绝（`missing-freeze`）。

默认档位一律是最保守的一档。放宽必须显式写在覆盖文件里 ——
默认宽的东西没人会去收紧，而这类放宽的代价是「专家自己改过了，所以它说没问题」。
