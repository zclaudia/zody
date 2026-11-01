/**
 * detachAll 清理屏障。
 *
 * 扩展生命周期清理必须先于新 connection/窗口的 create/attach；否则新 agent tab 可能
 * 被旧 cleanup 的台账快照一并关闭。`begin` 在第一个 await 之前同步占位 flight，
 * 所有依赖清理完成的 Chrome API 入口调用 `wait`。
 *
 * 普通 CDP/取消不走该屏障，仍保持 P2 的并发语义（避免 dialog 解阻塞命令被排队）。
 */
export class LifecycleBarrier {
  private flight: Promise<void> | null = null;

  begin(task: () => Promise<void>): Promise<void> {
    if (this.flight) return this.flight;
    // 同步占位，然后把任务放到 microtask；调用方在 begin 返回后立即 wait 也能看到 flight。
    const flight = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.flight === flight) this.flight = null;
      });
    this.flight = flight;
    return flight;
  }

  get active(): boolean {
    return this.flight !== null;
  }

  wait(): Promise<void> {
    return this.flight ?? Promise.resolve();
  }
}
