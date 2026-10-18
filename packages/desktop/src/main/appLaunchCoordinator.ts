interface AppLaunchGateLike {
  consume(): boolean;
}

interface RendererReadyInput {
  rendererId: number;
}

export function createAppLaunchCoordinator(appLaunchGate: AppLaunchGateLike) {
  return {
    onRendererReady(_input: RendererReadyInput): boolean {
      // fork（F4.7）：OAuth 回调等待队列随官方账号链删除；renderer ready 即代表启动完成。
      return appLaunchGate.consume();
    },
  };
}
