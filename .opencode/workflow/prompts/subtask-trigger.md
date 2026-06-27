执行当前阶段任务。完整 workOrder 已注入你的系统提示（含 ⛔ 任务范围硬约束 + 输入/输出路径 + schema hint；分片阶段另含 targetUnits + 切片读取清单 + 依赖签名），按系统提示的 workOrder 工作，完成后输出 WORKER_SUMMARY + TASK_STATUS（TASK_STATUS 为紧凑 JSON，必须是回复最后一段）。

⛔ 你的具体任务在系统提示最前（「分片范围硬约束」+「分片信息」+「Runtime Context」段）——直接读系统提示即可，**禁止 Read `run.json` / `dispatch-logs/` / `_events.log` 等文件去推断任务**。任务已在系统提示里，探索这些文件只会浪费上下文、不助于完成。若系统提示里确无分片信息，说明 dispatch 异常，直接输出 TASK_STATUS（status:failed，notes:"系统提示无 workOrder"）。
